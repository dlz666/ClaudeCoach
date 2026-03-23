import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

export async function extractTextFromPdf(filePath: string): Promise<string> {
  // Dynamic import to handle cases where pdf-parse might not be installed
  const pdfParse = require('pdf-parse');
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  const parsedText = normalizeExtractedText(String(data.text || ''));
  if (looksLikeUsableText(parsedText)) {
    return parsedText;
  }

  const ocrText = await extractTextWithWindowsOcr(filePath);
  if (looksLikeUsableText(ocrText)) {
    return ocrText;
  }

  return parsedText;
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return extractTextFromPdf(filePath);
    case '.txt':
    case '.md':
    case '.markdown':
      return fs.readFile(filePath, 'utf-8');
    default:
      throw new Error(`不支持的文件格式: ${ext}。支持 PDF、TXT、Markdown。`);
  }
}
