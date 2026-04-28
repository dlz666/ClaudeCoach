/**
 * EmbeddingClient — 独立于 chat AIClient 的向量嵌入客户端。
 *
 * 设计目标：
 * - 与 chat 客户端解耦：用户的 chat profile 可能走 codex 中转（apikey.soxio.me），
 *   但中转不一定代理 /v1/embeddings；embedding 可独立挂硅基流动免费 bge-m3 或
 *   任何 OpenAI 兼容 endpoint。
 * - 失败优雅降级：网络错误、4xx、超时全部返回 null（不抛），让上层自动 fallback
 *   到纯关键词检索，不阻断主流程。
 * - 批量友好：一次最多打包 N 条文本（默认 32），减少请求数。
 * - 模型自适应维度：首次成功调用后记下 dimension；后续校验维度一致避免数据污染。
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface EmbeddingProfile {
  enabled: boolean;
  baseUrl: string;       // 例如 https://api.siliconflow.cn/v1
  apiToken: string;
  model: string;         // 例如 BAAI/bge-m3
  dimension?: number;    // bge-m3=1024、3-small=1536、3-large=3072
}

export interface EmbedOptions {
  /** 单次请求最多塞多少条；超过会自动分多个 HTTP 请求并合并结果。 */
  batchSize?: number;
  /** 单请求超时（ms）。默认 30s。 */
  timeoutMs?: number;
  /** 网络错误时重试几次（指数退避）。默认 1。 */
  retries?: number;
}

export interface EmbeddingTestResult {
  ok: boolean;
  message: string;
  dimension?: number;
  latencyMs?: number;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;

export class EmbeddingClient {
  /**
   * @param getProfile 必须每次调用都重新读取偏好，因为用户随时可能在设置页改 baseUrl/token/model
   */
  constructor(private readonly getProfile: () => Promise<EmbeddingProfile | null>) {}

  /**
   * 计算一组文本的向量。返回 null 表示失败（profile 缺失 / 网络错 / 模型错），
   * 调用方应自动 fallback 到纯关键词。返回数组与输入数组同长且同序。
   */
  async embed(texts: string[], options?: EmbedOptions): Promise<number[][] | null> {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    const profile = await this.getProfile();
    if (!profile || !profile.enabled || !profile.baseUrl || !profile.apiToken || !profile.model) {
      return null;
    }

    const batchSize = Math.max(1, Math.min(64, options?.batchSize ?? DEFAULT_BATCH_SIZE));
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options?.retries ?? DEFAULT_RETRIES;

    // bge-m3 单条上下文 8k token，一般 chunk 远小于；保险起见单条裁到 6000 字符
    const cleaned = texts.map((t) => (t || '').toString().trim().slice(0, 6000));

    const out: number[][] = [];
    for (let i = 0; i < cleaned.length; i += batchSize) {
      const batch = cleaned.slice(i, i + batchSize);
      const batchResult = await this._embedBatchWithRetry(profile, batch, timeoutMs, retries);
      if (!batchResult) {
        return null; // 任意 batch 失败即整体失败
      }
      if (batchResult.length !== batch.length) {
        console.warn(
          `[EmbeddingClient] batch size mismatch: requested ${batch.length}, got ${batchResult.length}`,
        );
        return null;
      }
      out.push(...batchResult);
    }

    return out;
  }

  /** 探活 + 维度探测，用于设置页 "测试连通性" 按钮。 */
  async testConnection(): Promise<EmbeddingTestResult> {
    const profile = await this.getProfile();
    if (!profile) {
      return { ok: false, message: '未配置 embedding profile' };
    }
    if (!profile.baseUrl || !profile.apiToken || !profile.model) {
      return { ok: false, message: '请填写 baseUrl / apiToken / model' };
    }

    const t0 = Date.now();
    try {
      const result = await this._embedBatchWithRetry(profile, ['hello'], 15_000, 0);
      if (!result || !result[0]?.length) {
        return { ok: false, message: '调用成功但未返回向量数据', latencyMs: Date.now() - t0 };
      }
      return {
        ok: true,
        message: `连通正常：${profile.model} / ${result[0].length} 维`,
        dimension: result[0].length,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `失败：${message}`, latencyMs: Date.now() - t0 };
    }
  }

  // =====================================================================
  // private
  // =====================================================================

  private async _embedBatchWithRetry(
    profile: EmbeddingProfile,
    batch: string[],
    timeoutMs: number,
    retries: number,
  ): Promise<number[][] | null> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._embedBatchOnce(profile, batch, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          // 指数退避：500ms, 1s, 2s ...
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
        }
      }
    }
    console.warn('[EmbeddingClient] batch failed after retries:', lastErr);
    return null;
  }

  private async _embedBatchOnce(
    profile: EmbeddingProfile,
    batch: string[],
    timeoutMs: number,
  ): Promise<number[][]> {
    // 拼 url：baseUrl 末尾有 /v1 或没都允许
    const url = this._joinUrl(profile.baseUrl, '/embeddings');
    const body = JSON.stringify({
      model: profile.model,
      input: batch,
    });

    const responseText = await this._postJson(url, profile.apiToken, body, timeoutMs);
    let parsed: any;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error(`非 JSON 响应：${responseText.slice(0, 200)}`);
    }

    if (parsed.error || parsed.code) {
      const msg =
        parsed.error?.message ||
        parsed.message ||
        (typeof parsed.error === 'string' ? parsed.error : null) ||
        `code=${parsed.code}`;
      throw new Error(`embedding API 错误：${msg}`);
    }

    if (!Array.isArray(parsed.data)) {
      throw new Error(`响应缺少 data[]：${JSON.stringify(parsed).slice(0, 300)}`);
    }

    // OpenAI 兼容协议：data 按 input 顺序返回，每项有 embedding[]
    const sorted = parsed.data.slice().sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item: any, idx: number) => {
      const vec = item?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`第 ${idx} 项缺少 embedding 向量`);
      }
      return vec.map((v: any) => Number(v));
    });
  }

  private _joinUrl(baseUrl: string, suffix: string): string {
    let base = baseUrl.replace(/\/+$/, '');
    if (!suffix.startsWith('/')) suffix = '/' + suffix;
    // baseUrl 已经带 /v1 就不再追加
    if (/\/v\d+$/.test(base)) {
      return base + suffix;
    }
    // 否则按 OpenAI 习惯补 /v1
    return base + '/v1' + suffix;
  }

  private _postJson(
    url: string,
    token: string,
    body: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (err) {
        reject(new Error(`非法 URL：${url}`));
        return;
      }
      const lib = parsed.protocol === 'http:' ? http : https;

      const req = lib.request(
        {
          method: 'POST',
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            const status = res.statusCode || 0;
            if (status >= 200 && status < 300) {
              resolve(text);
            } else {
              reject(new Error(`HTTP ${status}：${text.slice(0, 200)}`));
            }
          });
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
      });
      req.write(body);
      req.end();
    });
  }
}

// =====================================================================
// 实用工具：提供给 vectorIndex / hybridRetriever 复用，无需重复造轮子
// =====================================================================

/** 计算两个等长向量的余弦相似度。返回 [-1, 1]，归一化向量上 = 点积。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
