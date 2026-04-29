import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * 进度回调：marker 跑长 PDF 时给 webview 实时反馈
 *   stage='detect' / 'starting' / 'processing' / 'done' / 'error' / 'fallback'
 */
export type ExtractProgressCallback = (event: {
  stage: 'detect' | 'starting' | 'processing' | 'done' | 'error' | 'fallback';
  message?: string;
  /** 已处理页 / 总页 */
  pages?: number;
  totalPages?: number;
}) => void;

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeUsableText(text: string): boolean {
  const normalized = normalizeExtractedText(text);
  const compact = normalized.replace(/\s/g, '');
  return compact.length >= 200;
}

async function findCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('where.exe', [command], { windowsHide: true });
    const first = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

function buildWindowsOcrScript(): string {
  return `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]

function Await-Result($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethodDefinition -and
      $_.GetGenericArguments().Count -eq 1 -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  $generic = $method.MakeGenericMethod($resultType)
  $task = $generic.Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}

function Normalize-OcrText([string]$text) {
  if (-not $text) { return '' }
  $text = $text -replace '(?<=[\\p{IsCJKUnifiedIdeographs}])\\s+(?=[\\p{IsCJKUnifiedIdeographs}])', ''
  $text = $text -replace '(?<=[\\p{IsCJKUnifiedIdeographs}])\\s+(?=[，。；：！？、《》“”‘’（）])', ''
  $text = $text -replace '(?<=[，。；：！？、《》“”‘’（）])\\s+(?=[\\p{IsCJKUnifiedIdeographs}])', ''
  return $text.Trim()
}

$inputDir = $args[0]
$outputPath = $args[1]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  throw 'Windows OCR engine is unavailable.'
}

$images = Get-ChildItem -Path $inputDir -Filter '*.png' | Sort-Object Name
$pages = New-Object System.Collections.Generic.List[string]

foreach ($image in $images) {
  $file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($image.FullName)) ([Windows.Storage.StorageFile])
  $stream = Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = Normalize-OcrText $result.Text
  $pages.Add($text)
}

[System.IO.File]::WriteAllText($outputPath, ($pages -join [Environment]::NewLine + [Environment]::NewLine), [System.Text.Encoding]::UTF8)
`;
}

async function extractTextWithWindowsOcr(filePath: string): Promise<string> {
  if (process.platform !== 'win32') {
    return '';
  }

  const pdftoppm = await findCommand('pdftoppm');
  if (!pdftoppm) {
    return '';
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudecoach-ocr-'));
  const imagePrefix = path.join(tempDir, 'page');
  const scriptPath = path.join(tempDir, 'ocr.ps1');
  const outputPath = path.join(tempDir, 'ocr-output.txt');

  try {
    await execFileAsync(
      pdftoppm,
      ['-png', '-gray', '-r', '140', filePath, imagePrefix],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );

    await fs.writeFile(scriptPath, buildWindowsOcrScript(), 'utf-8');
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, tempDir, outputPath],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }
    );

    const text = await fs.readFile(outputPath, 'utf-8');
    return normalizeExtractedText(text);
  } catch (error) {
    console.error('Windows OCR fallback failed:', error);
    return '';
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ===== Marker 集成 =====

let _markerCmdCache: string | null | undefined; // undefined = 未探测，null = 不可用，string = 命令路径

/**
 * 探测 marker_single 是否可用（带 5s 超时，结果缓存到进程结束）。
 * 不抛异常；不可用就返回 null，调用方降级到 pdf-parse。
 */
export async function detectMarkerCommand(): Promise<string | null> {
  if (_markerCmdCache !== undefined) return _markerCmdCache;
  try {
    // Windows: where.exe ；Unix: which
    const probe = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(probe, ['marker_single'], { windowsHide: true, timeout: 5000 });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) {
      _markerCmdCache = first;
      return first;
    }
  } catch { /* ignore */ }
  _markerCmdCache = null;
  return null;
}

/**
 * 用 marker_single 跑一份 PDF，返回 markdown 文本。
 *
 * 进程：spawn 'marker_single <pdf> <out_dir> --output_format markdown'
 *   marker 默认会用 GPU（如果 PyTorch CUDA 可用），否则 CPU
 *
 * 输出布局：<out_dir>/<basename>/<basename>.md  + 同目录附图
 *   读完即清理整个 out_dir。
 *
 * 进度：marker stdout 会输出 "Processed page X" 类，正则抽取后回调
 *
 * 失败：超时（默认 30 分钟） / 退出码非 0 → 返回空串
 */
export async function extractTextWithMarker(
  pdfPath: string,
  onProgress?: ExtractProgressCallback,
): Promise<string> {
  const cmd = await detectMarkerCommand();
  if (!cmd) return '';

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudecoach-marker-'));
  const baseName = path.basename(pdfPath, path.extname(pdfPath));

  try {
    onProgress?.({ stage: 'starting', message: `marker_single 启动中（首次会下载模型 ~3GB，请耐心等）` });

    const result = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const child = spawn(
        cmd,
        [
          pdfPath,
          '--output_dir', tempDir,
          '--output_format', 'markdown',
          // Force_OCR 关闭以加速；marker 自动判断
        ],
        {
          windowsHide: true,
          // marker 内部需要 ENV，但用默认 PATH
          env: { ...process.env },
        },
      );

      let lastProgressLine = '';
      let killed = false;
      const TIMEOUT_MS = 30 * 60 * 1000; // 单本 PDF 超时 30 分钟（含模型首次下载）
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({ ok: false, reason: '超时（30 分钟）' });
      }, TIMEOUT_MS);

      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');

      const handleOutput = (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          lastProgressLine = trimmed;
          // marker 进度行通常含 "Processing pages" / "Saving" / "Detected"
          // tqdm 风格："  10%|██| 25/250 [..."
          const tqdm = trimmed.match(/(\d+)\/(\d+)/);
          if (tqdm) {
            const done = parseInt(tqdm[1], 10);
            const total = parseInt(tqdm[2], 10);
            if (Number.isFinite(done) && Number.isFinite(total)) {
              onProgress?.({ stage: 'processing', pages: done, totalPages: total });
              continue;
            }
          }
          if (/Process|Detect|Save|Loading|Convert/i.test(trimmed)) {
            onProgress?.({ stage: 'processing', message: trimmed.slice(0, 200) });
          }
        }
      };
      child.stdout?.on('data', (data) => handleOutput(String(data)));
      child.stderr?.on('data', (data) => handleOutput(String(data)));

      child.on('error', (err) => {
        clearTimeout(timer);
        if (!killed) resolve({ ok: false, reason: `spawn error: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, reason: `exit code ${code}; last line: ${lastProgressLine.slice(0, 200)}` });
      });
    });

    if (!result.ok) {
      onProgress?.({ stage: 'error', message: result.reason });
      return '';
    }

    // marker 输出布局：<tempDir>/<basename>/<basename>.md
    const mdCandidates = [
      path.join(tempDir, baseName, `${baseName}.md`),
      path.join(tempDir, `${baseName}.md`),
    ];
    let mdContent = '';
    for (const candidate of mdCandidates) {
      try {
        mdContent = await fs.readFile(candidate, 'utf-8');
        if (mdContent) break;
      } catch { /* try next */ }
    }
    if (!mdContent) {
      // 兜底：扫 tempDir 里第一个 .md
      const walk = async (dir: string): Promise<string | null> => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name.endsWith('.md')) return full;
          if (e.isDirectory()) {
            const found = await walk(full);
            if (found) return found;
          }
        }
        return null;
      };
      const found = await walk(tempDir);
      if (found) mdContent = await fs.readFile(found, 'utf-8');
    }

    if (!mdContent) {
      onProgress?.({ stage: 'error', message: '未找到 marker 输出 .md 文件' });
      return '';
    }
    onProgress?.({ stage: 'done', message: `marker 完成：${mdContent.length} 字符` });
    return mdContent;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message: reason });
    return '';
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ===== 主入口 =====

export interface ExtractOptions {
  /**
   * 提取策略：
   *  - 'auto' (默认)：marker 可用就优先用，失败 fallback；否则走 pdf-parse + Windows OCR
   *  - 'marker-only'：必须用 marker，否则报错
   *  - 'fast'：只用 pdf-parse + Windows OCR，跳过 marker（已索引材料增量更新时用）
   */
  strategy?: 'auto' | 'marker-only' | 'fast';
  onProgress?: ExtractProgressCallback;
}

export async function extractTextFromPdf(
  filePath: string,
  options?: ExtractOptions,
): Promise<string> {
  const strategy = options?.strategy ?? 'auto';
  const onProgress = options?.onProgress;

  // 1. marker 优先
  if (strategy === 'auto' || strategy === 'marker-only') {
    onProgress?.({ stage: 'detect', message: '探测 marker_single...' });
    const markerAvailable = await detectMarkerCommand();
    if (markerAvailable) {
      const markerText = await extractTextWithMarker(filePath, onProgress);
      const markerNormalized = normalizeExtractedText(markerText);
      if (looksLikeUsableText(markerNormalized)) {
        return markerNormalized;
      }
      onProgress?.({ stage: 'fallback', message: 'marker 输出过短，fallback 到 pdf-parse' });
    } else if (strategy === 'marker-only') {
      throw new Error('marker_single 不可用（请 pip install marker-pdf）');
    } else {
      onProgress?.({ stage: 'fallback', message: 'marker 不可用，使用 pdf-parse' });
    }
  }

  // 2. pdf-parse
  const pdfParse = require('pdf-parse');
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  const parsedText = normalizeExtractedText(String(data.text || ''));
  if (looksLikeUsableText(parsedText)) {
    return parsedText;
  }

  // 3. Windows OCR fallback
  const ocrText = await extractTextWithWindowsOcr(filePath);
  if (looksLikeUsableText(ocrText)) {
    return ocrText;
  }

  return parsedText;
}

export async function extractTextFromFile(
  filePath: string,
  options?: ExtractOptions,
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return extractTextFromPdf(filePath, options);
    case '.txt':
    case '.md':
    case '.markdown':
      return fs.readFile(filePath, 'utf-8');
    default:
      throw new Error(`不支持的文件格式: ${ext}。支持 PDF、TXT、Markdown。`);
  }
}
