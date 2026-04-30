/**
 * VisionExtractor — 用云端多模态 LLM 把 PDF 转 markdown。
 *
 * 架构：
 *   PDF → pdftoppm 拆页 → 多张 PNG → 并发调 vision API → markdown 块 → 按页号拼接
 *
 * 默认模型：Qwen/Qwen3-VL-8B-Instruct（硅基流动）
 *   实测 苏德矿微积分单页 31s，完美还原 LaTeX 公式 + 章节 ## 标题。
 *   5 并发 → 等效 ~6s/页 → 280 页约 30 分钟。
 *
 * 为什么用 VL 模型而不是 reasoning 模型（如 Kimi K2 / Qwen3.6）：
 *   - VL 专为视觉感知任务训练，markdown / LaTeX 是核心训练 target
 *   - reasoning 模型会浪费 4000+ tokens 思考 "怎么转 markdown"，但这种纯感知
 *     任务不需要思考；同档质量但慢 2-4 倍 + 算力浪费
 *
 * 失败容错：
 *   - 单页失败不阻塞，最后报告失败页号；可选重试
 *   - 网络断 / API 限流 / token 不够 → 降级到 pdf-parse
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

const execFileAsync = promisify(execFile);

export interface VisionConfig {
  enabled: boolean;
  baseUrl: string;            // 例 https://api.siliconflow.cn/v1
  apiToken: string;
  model: string;              // 例 Qwen/Qwen3-VL-8B-Instruct
  /** 并发请求数，默认 5。免费 tier 一般 RPM 限 60 ≈ 每秒 1 个，并发 5 安全 */
  concurrency?: number;
  /** 每张 PNG dpi，默认 200。越高 OCR 越准但 token 多 */
  dpi?: number;
  /** 单页 max_tokens 默认 6000 */
  maxTokens?: number;
}

export interface VisionExtractProgress {
  stage: 'split' | 'page' | 'done' | 'error';
  page?: number;
  totalPages?: number;
  message?: string;
}

const DEFAULT_PROMPT = `请把这张教材页面完整转换成 markdown：
1. 标题用 # ## ###（按层级）
2. 公式用 LaTeX：行内 $...$，块级 $$...$$
3. 表格用 markdown table
4. 不要省略任何文字内容
5. 直接输出 markdown，不要其他说明`;

/**
 * 探测 pdftoppm 是否在 PATH 里（拆 PDF 用）。
 */
let _pdftoppmCache: string | null | undefined;
export async function detectPdftoppm(): Promise<string | null> {
  if (_pdftoppmCache !== undefined) return _pdftoppmCache;
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(probe, ['pdftoppm'], { windowsHide: true, timeout: 5000 });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) {
      _pdftoppmCache = first;
      return first;
    }
  } catch { /* ignore */ }
  _pdftoppmCache = null;
  return null;
}

/**
 * 用 pdftoppm 把 PDF 拆成 PNG（每页一张）。
 * 输出布局：<outDir>/page-001.png, page-002.png, ...
 */
async function splitPdfToPngs(
  pdfPath: string,
  outDir: string,
  dpi: number,
): Promise<string[]> {
  const pdftoppm = await detectPdftoppm();
  if (!pdftoppm) throw new Error('pdftoppm 未安装（poppler-utils 必装；Windows 通常随 MiKTeX）');

  await fs.mkdir(outDir, { recursive: true });
  const prefix = path.join(outDir, 'page');
  // pdftoppm -png -r DPI input prefix → 生成 prefix-001.png ...
  await execFileAsync(
    pdftoppm,
    ['-png', '-r', String(dpi), pdfPath, prefix],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 50, timeout: 5 * 60 * 1000 },
  );
  // 列出生成的 PNG 按文件名排序（pdftoppm 按页号补 0）
  const entries = await fs.readdir(outDir);
  const pngs = entries
    .filter((e) => e.startsWith('page') && e.endsWith('.png'))
    .sort()
    .map((e) => path.join(outDir, e));
  if (pngs.length === 0) throw new Error('pdftoppm 未输出任何 PNG');
  return pngs;
}

/**
 * 调 vision API 把单张 PNG 转 markdown。
 * 返回 markdown 字符串（成功）或 null（失败）。
 */
async function callVisionForPage(
  config: VisionConfig,
  pngPath: string,
  customPrompt?: string,
): Promise<string | null> {
  let png: Buffer;
  try {
    png = await fs.readFile(pngPath);
  } catch {
    return null;
  }
  const b64 = png.toString('base64');
  const url = joinUrl(config.baseUrl, '/chat/completions');
  const body = JSON.stringify({
    model: config.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: customPrompt || DEFAULT_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
    max_tokens: config.maxTokens ?? 6000,
  });

  try {
    const respText = await postJson(url, config.apiToken, body, 180_000);
    const parsed = JSON.parse(respText);
    if (parsed.error || parsed.code) {
      const msg = parsed.error?.message || parsed.message || `code=${parsed.code}`;
      throw new Error(`vision API 错误：${msg}`);
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return null;
    // 部分模型会用 ```markdown 包起来，剥离
    return stripMarkdownFence(content);
  } catch (err) {
    console.warn('[VisionExtractor] page failed:', err);
    return null;
  }
}

/** 主入口：PDF → markdown */
export async function extractWithVision(
  pdfPath: string,
  config: VisionConfig,
  onProgress?: (event: VisionExtractProgress) => void,
): Promise<string> {
  if (!config.enabled || !config.baseUrl || !config.apiToken || !config.model) {
    throw new Error('Vision 提取未配置');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudecoach-vision-'));
  try {
    onProgress?.({ stage: 'split', message: '拆分 PDF 为 PNG...' });
    const pngs = await splitPdfToPngs(pdfPath, tempDir, config.dpi ?? 200);
    onProgress?.({ stage: 'split', message: `已拆 ${pngs.length} 页`, totalPages: pngs.length });

    const concurrency = Math.max(1, Math.min(20, config.concurrency ?? 5));
    const results: (string | null)[] = new Array(pngs.length).fill(null);
    let done = 0;

    /** 并发池：随时保持 concurrency 个 in-flight */
    let nextIndex = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= pngs.length) break;
          const md = await callVisionForPage(config, pngs[idx]);
          results[idx] = md;
          done++;
          onProgress?.({
            stage: 'page',
            page: done,
            totalPages: pngs.length,
            message: md ? `[${done}/${pngs.length}] ${path.basename(pngs[idx])} ✓` : `[${done}/${pngs.length}] 失败`,
          });
        }
      })());
    }
    await Promise.all(workers);

    // 拼接：保留页号，失败的页留 placeholder（便于后续重试 / 用户察觉）
    const failedPages: number[] = [];
    const sections: string[] = [];
    results.forEach((md, i) => {
      if (md) {
        sections.push(md.trim());
      } else {
        failedPages.push(i + 1);
        sections.push(`<!-- 页 ${i + 1} 提取失败 -->`);
      }
    });
    const combined = sections.join('\n\n---\n\n');

    if (failedPages.length > 0) {
      onProgress?.({
        stage: 'error',
        message: `${failedPages.length}/${pngs.length} 页失败：${failedPages.slice(0, 10).join(',')}${failedPages.length > 10 ? '...' : ''}`,
      });
    }
    onProgress?.({ stage: 'done', message: `完成：${combined.length} 字符 / ${pngs.length - failedPages.length} 页成功` });
    return combined;
  } finally {
    // 清理 temp PNG 目录
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// =====================================================================
// HTTP utilities (复用 embeddingClient 风格)
// =====================================================================

function joinUrl(baseUrl: string, suffix: string): string {
  let base = baseUrl.replace(/\/+$/, '');
  if (!suffix.startsWith('/')) suffix = '/' + suffix;
  if (/\/v\d+$/.test(base)) return base + suffix;
  return base + '/v1' + suffix;
}

function postJson(url: string, token: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error(`非法 URL：${url}`)); return; }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request({
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
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        const code = res.statusCode || 0;
        if (code >= 200 && code < 300) resolve(text);
        else reject(new Error(`HTTP ${code}：${text.slice(0, 200)}`));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.write(body);
    req.end();
  });
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  // ```markdown ... ``` 或 ``` ... ```
  const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  if (m) return m[1];
  return trimmed;
}
