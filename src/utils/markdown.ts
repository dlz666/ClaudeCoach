import * as vscode from 'vscode';
import { writeText } from './fileSystem';

/**
 * Fix LaTeX formatting from AI output.
 *
 * Rules:
 * - Inline $...$: no spaces inside the $ delimiters, always stays on one line
 * - Line-only single-$ blocks are collapsed into one inline formula
 * - Block $$...$$ stays on its own lines without blank lines inside
 * - A standalone "=" line inside a $$...$$ block is merged onto the previous formula line
 */
export function fixLatex(md: string): string {
  md = md.replace(/\r\n/g, '\n');

  md = md.replace(/\$\$[ \t]*([^\n$]+)/g, '$$\n$1');
  md = md.replace(/([^\n$]+)[ \t]*\$\$/g, '$1\n$$');

  md = md.replace(/\$\$\n([\s\S]*?)\n\$\$/g, (_m, inner) =>
    '$$\n' +
    normalizeBlockMath(inner) +
    '\n$$'
  );

  md = collapseStandaloneSingleDollarBlocks(md);

  const masked = maskBlockMath(md);
  md = unmaskBlockMath(normalizeSingleDollarMath(masked.text), masked.blocks);

  md = trimInlineMathDelimiters(md);

  md = md.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (_m, inner) => {
    const t = inner.trim();
    const hasCJK = /[\u4e00-\u9fff]/.test(t);
    const hasMath = /[=+\-*/<>\\^_{}\d]|\\[a-zA-Z]/.test(t);
    return (hasCJK && !hasMath) ? t : '$' + t + '$';
  });

  md = padInlineMathBoundaries(md);
  md = trimInlineMathDelimiters(md);

  return md;
}

function normalizeBlockMath(inner: string): string {
  const lines = inner
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '')
    .split('\n');

  const normalized: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed === '=' && normalized.length > 0) {
      normalized[normalized.length - 1] = `${normalized[normalized.length - 1].trimEnd()} =`;
      continue;
    }

    normalized.push(trimmed);
  }

  return normalized.join('\n');
}

function collapseStandaloneSingleDollarBlocks(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '$') {
      result.push(line);
      continue;
    }

    const inner: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '$') {
      inner.push(lines[j]);
      j += 1;
    }

    if (j >= lines.length) {
      result.push(line);
      continue;
    }

    result.push(`$${collapseInlineMath(inner.join('\n'))}$`);
    i = j;
  }

  return result.join('\n');
}

function maskBlockMath(md: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const text = md.replace(/\$\$\n[\s\S]*?\n\$\$/g, (block) => {
    const token = `@@BLOCK_MATH_${blocks.length}@@`;
    blocks.push(block);
    return token;
  });

  return { text, blocks };
}

function unmaskBlockMath(md: string, blocks: string[]): string {
  let restored = md;
  for (let i = 0; i < blocks.length; i++) {
    restored = restored.replace(`@@BLOCK_MATH_${i}@@`, blocks[i]);
  }
  return restored;
}

function normalizeSingleDollarMath(md: string): string {
  let result = '';
  let buffer = '';
  let inMath = false;
  let newlineCount = 0;

  for (let i = 0; i < md.length; i++) {
    const ch = md[i];
    const prev = i > 0 ? md[i - 1] : '';

    if (ch === '$' && prev !== '\\') {
      if (inMath) {
        result += `$${collapseInlineMath(buffer)}$`;
        buffer = '';
        inMath = false;
        newlineCount = 0;
      } else {
        inMath = true;
      }
      continue;
    }

    if (!inMath) {
      result += ch;
      continue;
    }

    buffer += ch;
    if (ch === '\n') {
      newlineCount += 1;
    }

    if (buffer.length > 500 || newlineCount > 12) {
      result += `$${buffer}`;
      buffer = '';
      inMath = false;
      newlineCount = 0;
    }
  }

  if (inMath) {
    result += `$${buffer}`;
  }

  return result;
}

function collapseInlineMath(inner: string): string {
  return inner
    .split('\n')
    .map((part: string) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function trimInlineMathDelimiters(md: string): string {
  return md.replace(/(?<!\$)\$([^$\n]*)\$(?!\$)/g, (_m, inner) => `$${inner.trim()}$`);
}

function padInlineMathBoundaries(md: string): string {
  return md.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (match, _inner, offset: number, source: string) => {
    const prev = offset > 0 ? source[offset - 1] : '';
    const next = offset + match.length < source.length ? source[offset + match.length] : '';

    const needBefore = /[\u4e00-\u9fffA-Za-z0-9_)\]}]/.test(prev);
    const needAfter = /[\u4e00-\u9fffA-Za-z0-9_(\[{*-]/.test(next);

    return `${needBefore ? ' ' : ''}${match}${needAfter ? ' ' : ''}`;
  });
}

export async function writeMarkdown(filePath: string, content: string): Promise<void> {
  await writeText(filePath, fixLatex(content));
}

/** Write content through fixLatex and open preview. */
export async function writeMarkdownAndPreview(filePath: string, content: string): Promise<void> {
  await writeMarkdown(filePath, content);
  const uri = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

/** Open existing file in markdown preview (no rewrite). */
export async function openMarkdownPreview(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

/** Reprocess an existing markdown file through fixLatex in-place. */
export async function reprocessMarkdown(filePath: string): Promise<void> {
  const { readFile } = await import('fs/promises');
  const raw = await readFile(filePath, 'utf-8');
  await writeMarkdown(filePath, raw);
}

export function buildCourseSummaryMd(
  title: string,
  topics: { title: string; lessons: { title: string; difficulty: number }[] }[]
): string {
  let md = `# ${title}\n\n`;
  for (const topic of topics) {
    md += `## ${topic.title}\n\n`;
    for (const lesson of topic.lessons) {
      const stars = '*'.repeat(lesson.difficulty) + '-'.repeat(5 - lesson.difficulty);
      md += `- ${lesson.title}  ${stars}\n`;
    }
    md += '\n';
  }
  return md;
}
