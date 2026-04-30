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

/**
 * 提取结果：text + 提取方式（决定后续按 markdown 还是纯文本处理）。
 */
export interface ExtractResult {
  text: string;
  /** 'marker' / 'vision' = markdown 含 LaTeX；'pdf-parse' / 'windows-ocr' = 纯文本；'empty' = 提取失败 */
  format: 'markdown' | 'plain';
  method: 'vision' | 'marker' | 'pdf-parse' | 'windows-ocr' | 'empty';
}

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
 * 写一个临时 marker config_json，把 batch size + 行清理 + 重做内联公式 等性能/质量参数固化。
 * 详细参数权衡见 docs/ 评测报告 / chat 历史。
 */
async function writeMarkerConfig(): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `claudecoach-marker-config-${Date.now()}.json`);
  const config = {
    // 质量
    format_lines: true,           // 清理 OCR 断行（句子合并）
    redo_inline_math: true,       // 重做内联数学公式检测（数学教材 +5-10% 质量）
    // 性能（依据 RTX 5060 8GB VRAM 调，安全余量 ~500MB）
    DETECTOR_BATCH_SIZE: 32,
    RECOGNITION_BATCH_SIZE: 16,
    TABLE_REC_BATCH_SIZE: 16,
  };
  await fs.writeFile(tmpPath, JSON.stringify(config), 'utf-8');
  return tmpPath;
}

/**
 * 用 marker_single 跑一份 PDF，返回 markdown 文本。
 *
 * 进程：spawn 'marker_single <pdf> <out_dir> --output_format markdown
 *               --disable_image_extraction --languages "zh,en" --config_json <tmp>'
 *   marker 默认会用 GPU（如果 PyTorch CUDA 可用），否则 CPU
 *
 * 极致配置（已默认开启）：
 *   - --disable_image_extraction: 不写图片到磁盘，节省 IO 10-20%（我们不渲染原图）
 *   - --languages "zh,en": 中英混合教材识别精度更高（其他语言会差）
 *   - format_lines + redo_inline_math: 数学教材质量 +5-10%
 *   - batch size 调大: GPU 利用率 +30-50%
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
  options?: { languages?: string },
): Promise<string> {
  const cmd = await detectMarkerCommand();
  if (!cmd) return '';

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudecoach-marker-'));
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const configPath = await writeMarkerConfig();
  const languages = options?.languages || 'zh,en';

  try {
    onProgress?.({ stage: 'starting', message: `marker_single 启动中（首次会下载模型 ~3GB，请耐心等）` });

    const result = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const child = spawn(
        cmd,
        [
          pdfPath,
          '--output_dir', tempDir,
          '--output_format', 'markdown',
          '--disable_image_extraction',  // 节省 IO，不需要图
          '--languages', languages,       // 明示语言提升 OCR 精度
          '--config_json', configPath,    // 性能 + 质量参数
        ],
        {
          windowsHide: true,
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
    // 清理临时 config（每次新建是为了未来支持每资料独立配置；现在共用也可以但这样更安全）
    await fs.unlink(configPath).catch(() => undefined);
  }
}

// ===== 主入口 =====

export interface ExtractOptions {
  /**
   * 提取策略：
   *  - 'auto' (默认)：vision → marker → pdf-parse → Windows OCR 多级降级
   *  - 'vision-only'：必须用 vision API，否则报错（用于深度提取按钮）
   *  - 'marker-only'：必须用本地 marker，否则报错
   *  - 'fast'：只用 pdf-parse + Windows OCR（导入时 placeholder，质量低但秒级）
   */
  strategy?: 'auto' | 'vision-only' | 'marker-only' | 'fast';
  onProgress?: ExtractProgressCallback;
  /** vision 配置：从 prefs.retrieval.vision 读，注入这里 */
  visionConfig?: import('./visionExtractor').VisionConfig;
}

/**
 * 提取 PDF 文本，返回带元信息的 ExtractResult。
 * 老的 string 返回签名通过 .text 字段访问。
 */
export async function extractTextFromPdf(
  filePath: string,
  options?: ExtractOptions,
): Promise<ExtractResult> {
  const strategy = options?.strategy ?? 'auto';
  const onProgress = options?.onProgress;
  const visionConfig = options?.visionConfig;

  // 1. Vision API 优先（输出 markdown 含 LaTeX，质量最高）
  if (strategy === 'auto' || strategy === 'vision-only') {
    if (visionConfig?.enabled) {
      onProgress?.({ stage: 'starting', message: `Vision API 启动（${visionConfig.model}）` });
      try {
        const { extractWithVision } = await import('./visionExtractor');
        const visionText = await extractWithVision(filePath, visionConfig, (e) => {
          onProgress?.({
            stage: e.stage === 'split' ? 'starting' :
                   e.stage === 'page' ? 'processing' :
                   e.stage === 'done' ? 'done' : 'error',
            message: e.message,
            pages: e.page,
            totalPages: e.totalPages,
          });
        });
        if (visionText && visionText.replace(/\s/g, '').length >= 200) {
          return { text: visionText, format: 'markdown', method: 'vision' };
        }
        onProgress?.({ stage: 'fallback', message: 'Vision 输出过短，fallback' });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        onProgress?.({ stage: 'error', message: `Vision 失败：${reason}` });
        if (strategy === 'vision-only') throw err;
      }
    } else if (strategy === 'vision-only') {
      throw new Error('Vision 提取未配置（请在设置→资料检索→Vision API 启用）');
    }
  }

  // 2. Marker 本地（GPU/CPU 都行，离线友好）
  if (strategy === 'auto' || strategy === 'marker-only') {
    onProgress?.({ stage: 'detect', message: '探测 marker_single...' });
    const markerAvailable = await detectMarkerCommand();
    if (markerAvailable) {
      const markerText = await extractTextWithMarker(filePath, onProgress);
      if (markerText && markerText.replace(/\s/g, '').length >= 200) {
        return { text: markerText, format: 'markdown', method: 'marker' };
      }
      onProgress?.({ stage: 'fallback', message: 'marker 输出过短，fallback 到 pdf-parse' });
    } else if (strategy === 'marker-only') {
      throw new Error('marker_single 不可用（请 pip install marker-pdf）');
    } else {
      onProgress?.({ stage: 'fallback', message: 'marker 不可用，使用 pdf-parse' });
    }
  }

  // 3. pdf-parse（输出 plain text，秒级）
  const pdfParse = require('pdf-parse');
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  const parsedText = normalizeExtractedText(String(data.text || ''));
  if (looksLikeUsableText(parsedText)) {
    return { text: parsedText, format: 'plain', method: 'pdf-parse' };
  }

  // 3. Windows OCR fallback（输出 plain text）
  const ocrText = await extractTextWithWindowsOcr(filePath);
  if (looksLikeUsableText(ocrText)) {
    return { text: ocrText, format: 'plain', method: 'windows-ocr' };
  }

  return { text: parsedText, format: 'plain', method: parsedText ? 'pdf-parse' : 'empty' };
}

/**
 * 兼容 wrapper：旧调用方仍可拿 string。新代码用 extractFileWithMeta 拿完整元信息。
 */
export async function extractTextFromFile(
  filePath: string,
  options?: ExtractOptions,
): Promise<string> {
  const result = await extractFileWithMeta(filePath, options);
  return result.text;
}

/**
 * 完整版 — 返回 text + format + method，让 materialManager 决定写 .md 还是 .txt。
 */
export async function extractFileWithMeta(
  filePath: string,
  options?: ExtractOptions,
): Promise<ExtractResult> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return extractTextFromPdf(filePath, options);
    case '.md':
    case '.markdown': {
      const text = await fs.readFile(filePath, 'utf-8');
      return { text, format: 'markdown', method: 'marker' };
    }
    case '.txt': {
      const text = await fs.readFile(filePath, 'utf-8');
      return { text, format: 'plain', method: 'pdf-parse' };
    }
    default:
      throw new Error(`不支持的文件格式: ${ext}。支持 PDF、TXT、Markdown。`);
  }
}
