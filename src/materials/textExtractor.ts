import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * 进度回调：长 PDF 提取（vision 跑多页）给 webview 实时反馈。
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
  /** 'vision' = markdown 含 LaTeX；'pdf-parse' / 'windows-ocr' = 纯文本；'empty' = 提取失败 */
  format: 'markdown' | 'plain';
  method: 'vision' | 'pdf-parse' | 'windows-ocr' | 'empty';
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

// ===== 主入口 =====

export interface ExtractOptions {
  /**
   * 提取策略：
   *  - 'auto' (默认)：vision → pdf-parse → Windows OCR 多级降级
   *  - 'vision-only'：必须用 vision API，否则报错（用于深度提取按钮）
   *  - 'fast'：只用 pdf-parse + Windows OCR（导入时 placeholder，质量低但秒级）
   */
  strategy?: 'auto' | 'vision-only' | 'fast';
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

  // 1. Vision API 优先（云端多模态 LLM 输出 markdown 含 LaTeX，质量最高 + 速度可控）
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
        onProgress?.({ stage: 'fallback', message: 'Vision 输出过短，fallback 到 pdf-parse' });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        onProgress?.({ stage: 'error', message: `Vision 失败：${reason}` });
        if (strategy === 'vision-only') throw err;
      }
    } else if (strategy === 'vision-only') {
      throw new Error('Vision 提取未配置（请在设置→资料检索→Vision API 启用）');
    }
  }

  // 2. pdf-parse（输出 plain text，秒级，作为快速 fallback）
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
      // 用户直接上传的 markdown 文件视为已经是高质量提取（如 vision 输出）
      const text = await fs.readFile(filePath, 'utf-8');
      return { text, format: 'markdown', method: 'vision' };
    }
    case '.txt': {
      const text = await fs.readFile(filePath, 'utf-8');
      return { text, format: 'plain', method: 'pdf-parse' };
    }
    default:
      throw new Error(`不支持的文件格式: ${ext}。支持 PDF、TXT、Markdown。`);
  }
}
