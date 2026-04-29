/**
 * HybridRetriever — 关键词召回 + 向量召回 + RRF 融合。
 *
 * RRF (Reciprocal Rank Fusion) 公式：
 *   score(c) = 1 / (k + rank_kw(c)) + alpha * 1 / (k + rank_vec(c))
 * 其中 k=60（业界默认），rank 是 chunk 在各自通道里的排名（从 1 开始），
 * 没在某通道命中则该项视为 0。alpha 由用户偏好 hybridWeight 控制（0 关闭向量、
 * 1 强调向量、0.5 均衡）。
 *
 * 为什么不用 score 加权（而用 rank）：关键词 IDF 分和 cosine 量纲完全不同
 * （IDF 几十、cosine 0-1），直接加权后 cosine 会被 IDF 淹没。RRF 用排名规避这一点。
 */
import type { MaterialEntry } from '../types';
import { EmbeddingClient } from '../ai/embeddingClient';
import { VectorIndex } from './vectorIndex';

export interface KeywordCandidate {
  materialId: string;
  fileName: string;
  chunkIndex: number;
  chunkText: string;
  /** 关键词通道的得分（IDF 加成等） */
  score: number;
  /** section 命中标签，例如 "第3章 / 3.2 动态规划"，可选 */
  sectionLabel?: string;
}

export interface HybridResult {
  materialId: string;
  fileName: string;
  chunkIndex: number;
  chunkText: string;
  /** 综合排名分（RRF 融合后） */
  finalScore: number;
  /** 召回通道：'keyword' | 'vector' | 'both' */
  retrievedBy: 'keyword' | 'vector' | 'both';
  /** 关键词通道的原始 IDF 分（仅 keyword/both） */
  keywordScore?: number;
  /** 向量通道的 cosine（仅 vector/both） */
  vectorScore?: number;
  /** section 标签（仅 keyword/both 命中时） */
  sectionLabel?: string;
}

export interface HybridOptions {
  /** 用户偏好里的混合权重 0-1，默认 0.5 */
  hybridWeight: number;
  /** 最终返回多少条 */
  maxExcerpts: number;
  /** 各通道初步召回的数量（应大于等于 maxExcerpts，给融合留余量） */
  channelTopK: number;
  /** 关闭按 query 类型动态调权（debug / 测试时用），默认 false */
  disableQueryRouting?: boolean;
}

const RRF_K = 60;

/**
 * Query 类型分类：路由不同的 hybridWeight。基于纯规则（无 AI 调用）。
 *
 * - definition：定义查找 → 关键词重要（精确命中术语）
 * - concept：概念问答 → 向量重要（语义匹配）
 * - counter-example：反例查找 → 强偏向量
 * - cross-lingual：英文短 query 找中文资料 → 强偏向量
 * - general：默认，用用户偏好
 */
export type QueryKind = 'definition' | 'concept' | 'counter-example' | 'cross-lingual' | 'general';

const DEF_PATTERN = /^(什么是|是什么|定义|解释|什么叫|名词解释|what is|define|definition of)\b|什么是|的定义|的概念$/i;
const CONCEPT_PATTERN = /(为什么|怎么|如何|比较|区别|对比|证明|推导|why|how|prove|derive|compare)/i;
const COUNTEREXAMPLE_PATTERN = /(反例|不成立的|失败的|counter[\s-]?example|exception)/i;

export function classifyQuery(query: string): QueryKind {
  const q = (query || '').trim();
  if (!q) return 'general';
  if (COUNTEREXAMPLE_PATTERN.test(q)) return 'counter-example';
  if (CONCEPT_PATTERN.test(q)) return 'concept';
  if (DEF_PATTERN.test(q)) return 'definition';
  // 跨语言：query 几乎全英文且很短（多半是术语），强偏向量去找跨语言匹配
  const englishWords = (q.match(/[a-z][a-z0-9-]+/gi) || []).length;
  const cjkChars = (q.match(/[一-鿿]/g) || []).length;
  if (englishWords >= 1 && englishWords <= 4 && cjkChars === 0) {
    return 'cross-lingual';
  }
  return 'general';
}

/**
 * 根据 query 类型映射到一个建议 hybridWeight：
 * 用户的 baseWeight 作为 general 时使用；其他类别按相对偏移调整。
 */
export function routeHybridWeight(kind: QueryKind, baseWeight: number): number {
  switch (kind) {
    case 'definition':       return Math.max(0.2, Math.min(0.5, baseWeight - 0.2));
    case 'concept':          return Math.max(0.5, Math.min(0.8, baseWeight + 0.2));
    case 'counter-example':  return Math.max(0.7, Math.min(0.9, baseWeight + 0.3));
    case 'cross-lingual':    return Math.max(0.7, Math.min(0.85, baseWeight + 0.25));
    case 'general':
    default:                 return baseWeight;
  }
}

export class HybridRetriever {
  constructor(
    private readonly embeddingClient: EmbeddingClient,
    private readonly vectorIndex: VectorIndex,
  ) {}

  /**
   * 主入口：在已有的 keyword 候选基础上叠加向量召回 + RRF 融合。
   *
   * - 如果 embedding 不可用（profile 缺、enable=false、网络错） → 直接返回 keyword 候选
   * - 如果某资料还没建向量索引 → 该资料只参与 keyword 通道
   * - 如果用户 hybridWeight=0 → 跳过向量整段计算（省一次 embed 调用）
   * - 自动按 query 类型路由 hybridWeight（除非 options.disableQueryRouting=true）
   */
  async fuse(
    materials: MaterialEntry[],
    queryText: string,
    keywordCandidates: KeywordCandidate[],
    options: HybridOptions,
  ): Promise<HybridResult[]> {
    // Query 路由：按类型动态调权
    const baseWeight = options.hybridWeight;
    const kind = options.disableQueryRouting ? 'general' : classifyQuery(queryText);
    const hybridWeight = routeHybridWeight(kind, baseWeight);
    const { maxExcerpts, channelTopK } = options;

    // 用户彻底关闭向量 → 走纯关键词
    if (hybridWeight <= 0 || !queryText.trim()) {
      return this._keywordOnlyTopK(keywordCandidates, maxExcerpts);
    }

    // 计算 query 的向量；失败就降级
    const queryVecs = await this.embeddingClient.embed([queryText.trim()]);
    if (!queryVecs || !queryVecs[0] || queryVecs[0].length === 0) {
      return this._keywordOnlyTopK(keywordCandidates, maxExcerpts);
    }
    const queryVector = queryVecs[0];

    // 收集向量通道 chunks（每本资料 top channelTopK 条）
    // Two-stage：若该资料有 chapter 索引（v2），先粗筛 top-3 章再精筛；否则全量
    // 触发条件：query 长度 ≥ 8 字符（短 query 跨语言场景，用全量 cosine 更稳）
    const useChapterPrefilter = queryText.trim().length >= 8;
    const vectorCandidates: Array<{
      materialId: string;
      fileName: string;
      chunkIndex: number;
      chunkText: string;
      score: number;
    }> = [];
    for (const material of materials) {
      let hits: { chunkIndex: number; text: string; score: number }[] = [];
      if (useChapterPrefilter) {
        const topChapters = await this.vectorIndex.searchChapters(material, queryVector, 3);
        if (topChapters.length > 0) {
          // 粗筛通过：在 top-3 章范围内精筛
          const ranges = topChapters.map((c) => c.chunkRange);
          hits = await this.vectorIndex.searchWithinChapters(material, queryVector, channelTopK, ranges);
        }
      }
      // 没有 chapter 索引 / 粗筛降级 → 全量 chunk 搜索
      if (hits.length === 0) {
        hits = await this.vectorIndex.search(material, queryVector, channelTopK);
      }
      for (const hit of hits) {
        vectorCandidates.push({
          materialId: material.id,
          fileName: material.fileName,
          chunkIndex: hit.chunkIndex,
          chunkText: hit.text,
          score: hit.score,
        });
      }
    }

    // 没有任何向量命中（多半是没建索引）→ 走纯关键词
    if (vectorCandidates.length === 0) {
      return this._keywordOnlyTopK(keywordCandidates, maxExcerpts);
    }

    return this._rrfFuse(keywordCandidates, vectorCandidates, hybridWeight, maxExcerpts, channelTopK);
  }

  /** 仅在已有候选上做 top-K 截断（embedding 不可用时的纯关键词回退）。 */
  private _keywordOnlyTopK(candidates: KeywordCandidate[], maxExcerpts: number): HybridResult[] {
    return candidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, maxExcerpts)
      .map((c) => ({
        materialId: c.materialId,
        fileName: c.fileName,
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        finalScore: c.score,
        retrievedBy: 'keyword' as const,
        keywordScore: c.score,
        sectionLabel: c.sectionLabel,
      }));
  }

  /**
   * 标准 RRF 融合：先在每个通道内排名（按 score 降序），再算 1/(k+rank)，
   * 加权求和后取 top maxExcerpts。
   */
  private _rrfFuse(
    kwCandidates: KeywordCandidate[],
    vecCandidates: Array<{
      materialId: string;
      fileName: string;
      chunkIndex: number;
      chunkText: string;
      score: number;
    }>,
    hybridWeight: number,
    maxExcerpts: number,
    channelTopK: number,
  ): HybridResult[] {
    // 关键词通道排名（在 channelTopK 内，避免长尾噪声）
    const kwRank = new Map<string, { rank: number; cand: KeywordCandidate }>();
    kwCandidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, channelTopK)
      .forEach((c, i) => {
        const key = `${c.materialId}::${c.chunkIndex}`;
        kwRank.set(key, { rank: i + 1, cand: c });
      });

    // 向量通道排名（每条 cand 已经在自己资料内 top channelTopK，再做全局排名）
    const vecRank = new Map<
      string,
      {
        rank: number;
        cand: {
          materialId: string;
          fileName: string;
          chunkIndex: number;
          chunkText: string;
          score: number;
        };
      }
    >();
    vecCandidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, channelTopK * Math.max(1, kwCandidates.length === 0 ? 1 : 1)) // 总数有上界但允许超过 kw
      .forEach((c, i) => {
        const key = `${c.materialId}::${c.chunkIndex}`;
        // 同一 key 已存在（资料内有多 chunk 同分），保留 rank 较小
        const existing = vecRank.get(key);
        if (!existing || existing.rank > i + 1) {
          vecRank.set(key, { rank: i + 1, cand: c });
        }
      });

    // 合并所有 key
    const allKeys = new Set<string>([...kwRank.keys(), ...vecRank.keys()]);
    const fused: HybridResult[] = [];
    for (const key of allKeys) {
      const kw = kwRank.get(key);
      const vec = vecRank.get(key);
      const kwTerm = kw ? 1 / (RRF_K + kw.rank) : 0;
      const vecTerm = vec ? 1 / (RRF_K + vec.rank) : 0;
      // hybridWeight 含义：0=纯关键词、1=纯向量、0.5=均衡。
      // 修正：之前用 `kwTerm + α*vecTerm`，导致 α=0.5 时 vector 永远低权（kw 权重隐式=1）。
      // 现在两边按 (1-α) / α 对称加权，slider 真正反映用户期望。
      const finalScore = (1 - hybridWeight) * kwTerm + hybridWeight * vecTerm;

      const ref = kw?.cand ?? vec!.cand;
      const retrievedBy: 'keyword' | 'vector' | 'both' =
        kw && vec ? 'both' : kw ? 'keyword' : 'vector';

      fused.push({
        materialId: ref.materialId,
        fileName: ref.fileName,
        chunkIndex: ref.chunkIndex,
        chunkText: (kw?.cand ?? vec!.cand).chunkText,
        finalScore,
        retrievedBy,
        keywordScore: kw?.cand.score,
        vectorScore: vec?.cand.score,
        sectionLabel: kw?.cand.sectionLabel,
      });
    }

    fused.sort((a, b) => b.finalScore - a.finalScore);
    return fused.slice(0, maxExcerpts);
  }
}
