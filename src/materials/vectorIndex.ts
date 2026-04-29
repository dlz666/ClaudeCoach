/**
 * VectorIndex — 单本资料的向量索引存储 + 查询。
 *
 * 文件位置：courseSubjectDir/materials/<subject>/<materialId>/vector-index.json
 *
 * 设计要点：
 * - 文件粒度：一本资料一个 .json，避免单文件膨胀；一份资料 chunk 数通常在 50-500
 *   之间，1024 维 float32 即 ~2-4MB，完全可接受
 * - 增量：以 sha256(text) 为 chunk 主键，文本未变就不重 embed
 * - 模型变更：vector-index.json 里写 model 名 + dimension；用户切换模型时
 *   全部缓存失效（强制重建），避免不同模型空间混用产生噪声
 * - 检索：load 进内存后 brute-force cosine（资料体量小，<1ms / 几百 chunk）
 */
import * as path from 'path';
import * as crypto from 'crypto';
import { ensureDir, fileExists, readJson, writeJson } from '../utils/fileSystem';
import { StoragePathResolver, getStoragePathResolver } from '../storage/pathResolver';
import type { MaterialEntry } from '../types';
import { cosineSimilarity } from '../ai/embeddingClient';
import * as fsp from 'fs/promises';

export interface VectorChunk {
  /** 在 _chunkText 切分结果中的下标，用于回溯到原文 */
  chunkIndex: number;
  /** sha256(text)，做增量主键 */
  textHash: string;
  /** chunk 文本（缓存原文便于 retrieve 时直接返回，不必重新切） */
  text: string;
  /** float vector，长度等于 dimension */
  vector: number[];
}

export interface VectorIndexFile {
  version: number;
  materialId: string;
  model: string;
  dimension: number;
  /** 上次写入时使用的 chunkText hash 集合，便于做删除检测 */
  chunks: VectorChunk[];
  /**
   * v2 新增：章节级摘要的 embedding（每本书 ~30-100 个章节）。
   * 用于 two-stage 检索：先和 chapter vector 比 cosine 找 top-N 章，
   * 再在这 N 章对应的 chunk 范围内做精筛。
   * 老索引没有此字段时整体仍可用，只是降级为单级检索。
   */
  chapters?: ChapterVector[];
  updatedAt: string;
}

export interface ChapterVector {
  /** 与 MaterialSummary.chapters[i] 对齐的 index */
  chapterIndex: number;
  /** 章节标识（章号 + 标题） */
  label: string;
  /** 该章覆盖的 chunkIndex 区间 [start, end)，retrieval 阶段用来过滤 chunks */
  chunkRange: [number, number];
  /** sha256(label + summary)，增量复用 */
  textHash: string;
  /** 章节摘要 embedding 向量 */
  vector: number[];
}

const VECTOR_INDEX_VERSION = 2;

export class VectorIndex {
  private paths: StoragePathResolver;

  constructor() {
    this.paths = getStoragePathResolver();
  }

  /** 计算文本的 sha256，用作 chunk 主键。 */
  static hashText(text: string): string {
    return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 32);
  }

  /** 读单本资料的向量索引；不存在返回 null。 */
  async load(material: MaterialEntry): Promise<VectorIndexFile | null> {
    const filePath = this.paths.materialVectorIndexPath(material.subject, material.id);
    if (!(await fileExists(filePath))) {
      return null;
    }
    const data = await readJson<VectorIndexFile>(filePath);
    if (!data) return null;
    // v2 引入了 chapters 字段；v1 文件没有该字段但其余结构兼容 — 当作"无 chapter 索引"加载
    if (data.version === 1) {
      return { ...data, version: 1, chapters: undefined };
    }
    if (data.version === VECTOR_INDEX_VERSION) {
      return data;
    }
    // 未知版本，无法处理
    return null;
  }

  /** 保存（覆盖写入）。 */
  async save(material: MaterialEntry, file: VectorIndexFile): Promise<void> {
    const filePath = this.paths.materialVectorIndexPath(material.subject, material.id);
    await ensureDir(path.dirname(filePath));
    await writeJson(filePath, file);
  }

  /** 删除（资料被移除时调用）。 */
  async remove(material: MaterialEntry): Promise<void> {
    const filePath = this.paths.materialVectorIndexPath(material.subject, material.id);
    if (await fileExists(filePath)) {
      try {
        await fsp.unlink(filePath);
      } catch {
        /* noop */
      }
    }
  }

  /**
   * 计算缺失 chunks——对比当前 chunks 文本 hash 与已存索引，返回需要 embed 的 chunk
   * 列表 + 已经有效的 chunk 集合（保留下来，避免重 embed）。
   *
   * 同时检测模型/维度变更：若 expectedModel 与 file.model 不一致，整份失效。
   */
  diff(
    file: VectorIndexFile | null,
    chunks: string[],
    expectedModel: string,
    expectedDim: number | undefined,
  ): {
    /** 复用的旧 chunks（按 chunkIndex 重新对齐到新切分顺序） */
    keep: VectorChunk[];
    /** 需要现在调 embed 的 chunks */
    todo: { chunkIndex: number; text: string; textHash: string }[];
  } {
    const todo: { chunkIndex: number; text: string; textHash: string }[] = [];
    const keep: VectorChunk[] = [];

    // 模型/维度变更 → 全部丢弃，重新建
    if (
      !file ||
      file.model !== expectedModel ||
      (typeof expectedDim === 'number' && expectedDim > 0 && file.dimension !== expectedDim)
    ) {
      chunks.forEach((text, chunkIndex) => {
        todo.push({ chunkIndex, text, textHash: VectorIndex.hashText(text) });
      });
      return { keep, todo };
    }

    // 用 hash 建索引
    const byHash = new Map<string, VectorChunk>();
    for (const c of file.chunks) {
      byHash.set(c.textHash, c);
    }

    chunks.forEach((text, chunkIndex) => {
      const textHash = VectorIndex.hashText(text);
      const existing = byHash.get(textHash);
      if (existing) {
        // 复用，但用新的 chunkIndex（文本不变但顺序可能变化）
        keep.push({ ...existing, chunkIndex, text });
      } else {
        todo.push({ chunkIndex, text, textHash });
      }
    });

    return { keep, todo };
  }

  /** 把 keep + 新 embed 的 chunks 合并写回。可选附加 chapter 向量（v2）。 */
  async merge(
    material: MaterialEntry,
    model: string,
    dimension: number,
    keep: VectorChunk[],
    fresh: { chunkIndex: number; text: string; textHash: string; vector: number[] }[],
    chapters?: ChapterVector[],
  ): Promise<VectorIndexFile> {
    const all: VectorChunk[] = [
      ...keep,
      ...fresh.map((f) => ({
        chunkIndex: f.chunkIndex,
        textHash: f.textHash,
        text: f.text,
        vector: f.vector,
      })),
    ];
    all.sort((a, b) => a.chunkIndex - b.chunkIndex);

    const file: VectorIndexFile = {
      version: VECTOR_INDEX_VERSION,
      materialId: material.id,
      model,
      dimension,
      chunks: all,
      chapters: chapters && chapters.length ? chapters : undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.save(material, file);
    return file;
  }

  /**
   * 用 query 向量在该资料的所有 chunks 上做 cosine 相似度，返回按分降序的 top-K。
   * 没有索引文件 → 返回 []，让上层 fallback 关键词。
   */
  async search(
    material: MaterialEntry,
    queryVector: number[],
    topK: number,
  ): Promise<{ chunkIndex: number; text: string; score: number }[]> {
    const file = await this.load(material);
    if (!file || !file.chunks.length) {
      return [];
    }
    if (queryVector.length !== file.dimension) {
      // 模型不一致；返回空，让上层用关键词
      return [];
    }

    const scored = file.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunk.vector),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  /**
   * Two-stage retrieval 第一阶段：根据 query 向量找最相关的 N 个章节。
   *
   * 返回每个章节的 `chunkRange`，第二阶段会用这些 range 过滤 chunks。
   * 没有 chapter 索引（v1 老文件 / 文本无章节结构）时返回空数组，
   * 调用方应 fallback 到全量 chunk 检索。
   */
  async searchChapters(
    material: MaterialEntry,
    queryVector: number[],
    topN: number,
  ): Promise<{ chapterIndex: number; label: string; chunkRange: [number, number]; score: number }[]> {
    const file = await this.load(material);
    if (!file?.chapters || !file.chapters.length) return [];
    if (queryVector.length !== file.dimension) return [];

    const scored = file.chapters.map((c) => ({
      chapterIndex: c.chapterIndex,
      label: c.label,
      chunkRange: c.chunkRange,
      score: cosineSimilarity(queryVector, c.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topN));
  }

  /**
   * Two-stage retrieval 第二阶段：在指定章节范围内做 chunk 级 cosine。
   * `chunkRanges` 是从 searchChapters 返回的多个区间，合并后去重。
   */
  async searchWithinChapters(
    material: MaterialEntry,
    queryVector: number[],
    topK: number,
    chunkRanges: Array<[number, number]>,
  ): Promise<{ chunkIndex: number; text: string; score: number }[]> {
    const file = await this.load(material);
    if (!file?.chunks?.length) return [];
    if (queryVector.length !== file.dimension) return [];

    // 把多个 [start, end) 合并为一个 inRange 函数
    const inAnyRange = (idx: number): boolean =>
      chunkRanges.some(([s, e]) => idx >= s && idx < e);

    const candidates = file.chunks.filter((c) => inAnyRange(c.chunkIndex));
    if (candidates.length === 0) return [];

    const scored = candidates.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunk.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  /**
   * 整本资料是否已建索引（用于 UI 显示状态）。
   */
  async hasIndex(material: MaterialEntry): Promise<boolean> {
    const filePath = this.paths.materialVectorIndexPath(material.subject, material.id);
    return fileExists(filePath);
  }

  /** 元信息查询（chunk 数、模型、维度），UI 状态显示用。 */
  async stats(material: MaterialEntry): Promise<{
    exists: boolean;
    chunks: number;
    model?: string;
    dimension?: number;
    updatedAt?: string;
  }> {
    const file = await this.load(material);
    if (!file) return { exists: false, chunks: 0 };
    return {
      exists: true,
      chunks: file.chunks.length,
      model: file.model,
      dimension: file.dimension,
      updatedAt: file.updatedAt,
    };
  }
}
