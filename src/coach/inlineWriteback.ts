import * as fs from 'fs/promises';
import * as path from 'path';
import { writeMarkdown } from '../utils/markdown';
import { getDataDirectory } from '../config';

/**
 * One precise write-back into a lecture markdown file.
 *
 * The caller already knows:
 *   - which file
 *   - which line range was selected (0-indexed, inclusive end)
 *   - what the user actually selected (string)
 *   - what to write (AI output or user input)
 *
 * We do a defensive in-slice match instead of trusting raw character offsets,
 * because the source file may have been edited between the time the selection
 * was captured (in a preview) and the time we apply the change.
 */
export interface WritebackInput {
  filePath: string;
  selectionText: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  newContent: string;
  mode: 'replace' | 'insertAfter';
}

export interface WritebackResult {
  ok: boolean;
  appliedRange?: { startLine: number; endLine: number };
  errorMessage?: string;
  warning?: string;
}

/** Detect EOL style of an existing file so we round-trip cleanly. */
function detectEol(raw: string): '\r\n' | '\n' {
  // If the first newline we find is \r\n, treat the whole file as CRLF.
  const idx = raw.indexOf('\n');
  if (idx > 0 && raw[idx - 1] === '\r') {
    return '\r\n';
  }
  return '\n';
}

function splitLines(raw: string, eol: string): string[] {
  if (raw === '') {
    return [''];
  }
  return raw.split(eol);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * `~/ClaudeCoach/...` (or the user's overridden data dir) only, and the file must
 * live somewhere under a `lessons/` directory and end in `.md`. This is intentionally
 * a soft whitelist so we never mutate arbitrary markdown files the user happens to
 * have open.
 */
export function isLecturePath(filePath: string): boolean {
  if (!filePath) {
    return false;
  }
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.md')) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (!/\/lessons\//i.test(normalized)) {
    return false;
  }
  try {
    const dataDir = getDataDirectory();
    if (!dataDir) {
      return false;
    }
    const rel = path.relative(dataDir, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function applyInlineWriteback(input: WritebackInput): Promise<WritebackResult> {
  if (!isLecturePath(input.filePath)) {
    return {
      ok: false,
      errorMessage: '目标文件不在讲义目录下，已拒绝写回。',
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(input.filePath, 'utf-8');
  } catch (error) {
    return {
      ok: false,
      errorMessage: `读取讲义文件失败：${(error as Error).message}`,
    };
  }

  const eol = detectEol(raw);
  const lines = splitLines(raw, eol);

  const startLine = clamp(input.sourceLineStart, 0, Math.max(0, lines.length - 1));
  const endLine = clamp(input.sourceLineEnd, startLine, Math.max(0, lines.length - 1));

  const sliceLines = lines.slice(startLine, endLine + 1);
  const sliceText = sliceLines.join(eol);

  const trimmedSelection = input.selectionText.trim();
  let warning: string | undefined;

  let matchStart = -1;
  let matchEnd = -1;
  if (trimmedSelection) {
    matchStart = sliceText.indexOf(trimmedSelection);
    if (matchStart >= 0) {
      matchEnd = matchStart + trimmedSelection.length;
    }
  }

  let nextSliceText: string;
  if (input.mode === 'replace') {
    if (matchStart < 0) {
      // Fallback: replace the whole slice. Surface a warning so the caller can show it.
      warning = '未在选区行内精确匹配到选中文本，已替换整块所选行。';
      nextSliceText = input.newContent;
    } else {
      nextSliceText =
        sliceText.slice(0, matchStart) +
        input.newContent +
        sliceText.slice(matchEnd);
    }
  } else {
    // insertAfter
    if (matchStart < 0) {
      warning = '未在选区行内精确匹配到选中文本，已在所选行末尾插入。';
      nextSliceText = sliceText + eol + eol + input.newContent;
    } else {
      nextSliceText =
        sliceText.slice(0, matchEnd) +
        eol + eol +
        input.newContent +
        sliceText.slice(matchEnd);
    }
  }

  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine + 1);
  const merged = [...before, ...nextSliceText.split(eol), ...after];

  const finalText = merged.join(eol);

  try {
    // writeMarkdown runs through fixLatex(), which we want for AI output.
    await writeMarkdown(input.filePath, finalText);
  } catch (error) {
    return {
      ok: false,
      errorMessage: `写回讲义失败：${(error as Error).message}`,
    };
  }

  // After writeMarkdown the on-disk content has been LaTeX-normalized, so the line
  // count we report is approximate (we report what *we* produced before fixLatex).
  const newSliceLineCount = nextSliceText.split(eol).length;
  return {
    ok: true,
    appliedRange: {
      startLine,
      endLine: startLine + Math.max(0, newSliceLineCount - 1),
    },
    warning,
  };
}
