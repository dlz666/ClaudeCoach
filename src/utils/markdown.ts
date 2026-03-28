import * as vscode from 'vscode';
import { writeText } from './fileSystem';

/**
 * Fix LaTeX formatting from AI output.
 *
 * Rules:
 * - Inline $...$: no spaces inside the $ delimiters, always stays on one line
 * - Line-only single-$ blocks are promoted to display math
 * - Block $$...$$ stays on its own lines without blank lines inside
 * - A standalone "=" line inside a $$...$$ block is merged onto the previous formula line
 * - Malformed single-$ segments are repaired into either valid math or plain text
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
  md = normalizeInlineMathSegments(md);
  md = promoteStandaloneMathLines(md);
  md = stripOrphanDollarLines(md);
  md = splitInlineHeadings(md);
  md = repairPlainTextMathLines(md);

  md = trimInlineMathDelimiters(md);
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

    result.push('$$');
    result.push(normalizeBlockMath(inner.join('\n')));
    result.push('$$');
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
        result += finalizeSingleDollarFragment(buffer);
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
      result += finalizeSingleDollarFragment(buffer);
      buffer = '';
      inMath = false;
      newlineCount = 0;
    }
  }

  if (inMath) {
    result += finalizeSingleDollarFragment(buffer);
  }

  return result;
}

function normalizeInlineMathSegments(md: string): string {
  return md.replace(/(?<!\$)\$([^$\n]*)\$(?!\$)/g, (_m, inner) => finalizeSingleDollarFragment(inner));
}

function finalizeSingleDollarFragment(raw: string): string {
  const normalizedRaw = raw.replace(/\r\n/g, '\n').trim();
  if (!normalizedRaw) {
    return '';
  }

  const collapsed = collapseInlineMath(normalizedRaw).trim();
  if (!collapsed) {
    return '';
  }

  if (normalizedRaw.includes('\n') && !shouldDowngradeInlineMath(collapsed)) {
    return `$$\n${normalizeBlockMath(normalizedRaw)}\n$$`;
  }

  if (shouldDowngradeInlineMath(collapsed)) {
    return repairPlainTextFromMath(collapsed);
  }

  return `$${collapsed}$`;
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

    const needBefore = /[\u4e00-\u9fffA-Za-z0-9_)\]}.，。！？；：:;,]/.test(prev);
    const needAfter = /[\u4e00-\u9fffA-Za-z0-9_(\[{*-]/.test(next);

    return `${needBefore ? ' ' : ''}${match}${needAfter ? ' ' : ''}`;
  });
}

function shouldDowngradeInlineMath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (/^\d+[.)、]?$/.test(trimmed)) {
    return true;
  }

  if (/^[，。！？；：,.!?;:、（）()[\]{}\-—\s]+$/.test(trimmed)) {
    return true;
  }

  if (/(\*\*|__|`)/.test(trimmed)) {
    return true;
  }

  if (/(^|[\s])#{1,6}\s|(^|[\s])---($|[\s])/.test(trimmed)) {
    return true;
  }

  if (trimmed.includes('#') && !trimmed.includes('\\#')) {
    return true;
  }

  const cjkCount = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const mathSignals = countMathSignals(trimmed);

  if (cjkCount === 0) {
    return mathSignals === 0;
  }

  if (/^(第[\u4e00-\u9fff0-9]+题|解答|证明|例题|命题|结论)/.test(trimmed)) {
    return true;
  }

  if (/[。！？；：]/.test(trimmed)) {
    return true;
  }

  if (cjkCount >= 2 && mathSignals < 2) {
    return true;
  }

  return cjkCount >= 6;
}

function countMathSignals(text: string): number {
  let score = 0;

  if (/\\[A-Za-z]+/.test(text)) {
    score += 3;
  }
  if (/[=<>+\-*/^_]/.test(text)) {
    score += 2;
  }
  if (/[{}]/.test(text)) {
    score += 1;
  }
  if (/[∀∃¬∧∨→↔≤≥≠]/.test(text)) {
    score += 3;
  }
  if (/^[A-Za-z]([A-Za-z0-9]|[_^][A-Za-z0-9{}]+)*$/.test(text)) {
    score += 1;
  }
  if (/^[A-Za-z][A-Za-z0-9]*\([^)]*\)$/.test(text)) {
    score += 2;
  }
  if (/^\d+$/.test(text)) {
    score += 1;
  }

  return score;
}

function repairPlainTextFromMath(text: string): string {
  let repaired = text.trim();

  repaired = repaired.replace(/\s*---\s*/g, '\n\n---\n\n');
  repaired = repaired.replace(/\s*(#{1,6}\s*)/g, '\n\n$1');
  repaired = repaired.replace(/([^\n])\s+(#{1,6}\s*)/g, '$1\n\n$2');
  repaired = repaired.replace(/\s+([，。！？；：,.!?;:、])/g, '$1');
  repaired = repaired.replace(/([（([{])\s+/g, '$1');
  repaired = repaired.replace(/\s+([）)\]}])/g, '$1');
  repaired = restoreInlineMathFragments(repaired);
  repaired = repaired.replace(/\n{3,}/g, '\n\n');

  return repaired.trim();
}

function promoteStandaloneMathLines(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      result.push(line);
      continue;
    }

    if (inFence || !looksLikeStandaloneMathLine(trimmed)) {
      result.push(line);
      continue;
    }

    if (result.length && result[result.length - 1].trim()) {
      result.push('');
    }
    result.push('$$');
    result.push(trimmed);
    result.push('$$');
    result.push('');
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function looksLikeStandaloneMathLine(line: string): boolean {
  if (!line || line.includes('$')) {
    return false;
  }

  if (/^(#{1,6}|>|- |\* |\+ |\d+\.)/.test(line)) {
    return false;
  }

  if (/[`#]/.test(line)) {
    return false;
  }

  if (/[\u4e00-\u9fff]{2,}/.test(line)) {
    return false;
  }

  if (/\\[A-Za-z]+/.test(line)) {
    return true;
  }

  return /[=<>+\-*/^_]/.test(line) && /[A-Za-z0-9]/.test(line);
}

function restoreInlineMathFragments(text: string): string {
  let repaired = text;

  repaired = repaired.replace(/\\mathbb\{[^{}\n]+\}/g, (expr) => `$${expr.trim()}$`);
  repaired = repaired.replace(
    /\\(?:forall|exists|neg)(?:\s+[A-Za-z])*(?:\\,\s*)?(?:(?:\\(?:forall|exists|neg)(?:\s+[A-Za-z])*(?:\\,\s*)?)*)\([^()\n]*\)/g,
    (expr) => `$${expr.trim()}$`,
  );

  return repaired;
}

function stripOrphanDollarLines(md: string): string {
  return md
    .split('\n')
    .filter(line => line.trim() !== '$')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function splitInlineHeadings(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let inFence = false;
  let inBlockMath = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (!inFence && trimmed === '$$') {
      inBlockMath = !inBlockMath;
      result.push(line);
      continue;
    }

    if (inFence || inBlockMath || /^\s*#{1,6}\s/.test(line)) {
      result.push(line);
      continue;
    }

    result.push(...line.replace(/([^\n])\s+(#{1,6}\s+)/g, '$1\n\n$2').split('\n'));
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function repairPlainTextMathLines(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let inFence = false;
  let inBlockMath = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (!inFence && trimmed === '$$') {
      inBlockMath = !inBlockMath;
      result.push(line);
      continue;
    }

    if (inFence || inBlockMath || line.includes('$')) {
      result.push(line);
      continue;
    }

    result.push(restoreInlineMathFragments(line));
  }

  return result.join('\n');
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
