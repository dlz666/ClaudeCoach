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
  updatedAt: string;
}

const VECTOR_INDEX_VERSION = 1;

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
    if (!data || data.version !== VECTOR_INDEX_VERSION) {
      return null; // 版本不一致直接当无效
    }
    return data;
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

  /** 把 keep + 新 embed 的 chunks 合并写回。 */
  async merge(
    material: MaterialEntry,
    model: string,
    dimension: number,
    keep: VectorChunk[],
    fresh: { chunkIndex: number; text: string; textHash: string; vector: number[] }[],
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
