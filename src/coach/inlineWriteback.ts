import * as fs from 'fs/promises';
import * as path from 'path';
import { writeMarkdown } from '../utils/markdown';
import { getDataDirectory } from '../config';

/**
 * One precise write-back into a lecture markdown file.
 *
 * 调用者必须自己确定的事情：
 *   - 哪个文件
 *   - 哪一段行范围（0-indexed, **闭区间**，与 VS Code Position.line 语义一致）
 *   - 用户实际选中的文本（原 markdown，不是渲染后的 HTML）
 *   - 要写入的内容
 *   - 写回模式（见下面 mode 定义）
 *
 * ⚠ **行号语义注意**：本模块对外契约是闭区间。`lectureWebviewProvider` 收到的
 * webview 行号是 markdown-it `token.map` 风格的半开区间，必须在 provider 里
 * 转成闭区间后再传进来，绝对不要在这里隐式假设。
 */
export interface WritebackInput {
  filePath: string;
  selectionText: string;
  /** 闭区间起点，0-indexed。 */
  sourceLineStart: number;
  /** 闭区间终点，0-indexed（即所选 block 的最后一行）。 */
  sourceLineEnd: number;
  newContent: string;
  /**
   * - `replace`：在选区行的内容里精确定位 `selectionText` 后替换。**找不到时
   *   直接 fail**，不再静默吞掉整段选区行（旧行为会丢内容）。如果调用方希望
   *   失败时降级为追加，传 `allowFallbackAppend: true`。
   * - `insertAfter`：在选区文本之后插入。给老的 VS Code 编辑器内联补充用，
   *   此时调用方保证 `selectionText` 就是当前那一行的内容，indexOf 必中。
   *   找不到匹配时退化为在所选行块末尾插入（保持原内容不丢）。
   * - `appendBelowBlock`：**不修改选区原文**，把 newContent 作为兄弟块插入
   *   到所选 block 的紧后方（即 `sourceLineEnd + 1` 行起），上下用空行分隔。
   *   这是"提问 → 把回答存到讲义"/"记想法"等 non-destructive 操作的唯一安全
   *   写法。selectionText 在此模式下仅作元信息记录，可空。
   */
  /**
   * - `replace` / `insertAfter` / `appendBelowBlock`：选区范围内的写回（见下）
   * - `replaceWholeDocument`：**整篇覆盖**写回。忽略 sourceLineStart / sourceLineEnd /
   *   selectionText，把 newContent 当作完整新文件内容写盘。**必须**先备份到 .bak。
   *   用于"全文 rewrite"场景（如"补更多例题"、"改成更严谨风格"等用户对整篇讲义的整体重塑）。
   */
  mode: 'replace' | 'insertAfter' | 'appendBelowBlock' | 'replaceWholeDocument';
  /**
   * 仅 `mode: 'replace'` 时生效。默认 false：找不到选区文本时 fail。
   * true：找不到时降级为 `appendBelowBlock`，并设置 warning。
   */
  allowFallbackAppend?: boolean;
}

export interface WritebackResult {
  ok: boolean;
  appliedRange?: { startLine: number; endLine: number };
  errorMessage?: string;
  warning?: string;
  /** 若成功且写了备份，给出备份文件绝对路径，方便前端 surface "可撤销"。 */
  backupPath?: string;
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

/**
 * 写入前把当前磁盘内容备份到 `<file>.bak`（单档滚动，无版本号）。
 * 失败不抛——备份只是兜底，不要因为权限/磁盘问题阻塞主流程。
 */
async function writeBackup(filePath: string, currentRaw: string): Promise<string | undefined> {
  const backupPath = filePath + '.bak';
  try {
    await fs.writeFile(backupPath, currentRaw, 'utf-8');
    return backupPath;
  } catch {
    return undefined;
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

  // ===== replaceWholeDocument：整篇覆盖（早返回，跳过 slice/match 逻辑）=====
  if (input.mode === 'replaceWholeDocument') {
    const backupPath = await writeBackup(input.filePath, raw);
    try {
      await writeMarkdown(input.filePath, input.newContent);
    } catch (error) {
      return {
        ok: false,
        errorMessage: `整篇写回失败：${(error as Error).message}`,
        backupPath,
      };
    }
    const newLineCount = input.newContent.split('\n').length;
    return {
      ok: true,
      appliedRange: { startLine: 0, endLine: Math.max(0, newLineCount - 1) },
      backupPath,
    };
  }

  const eol = detectEol(raw);
  const lines = splitLines(raw, eol);

  const startLine = clamp(input.sourceLineStart, 0, Math.max(0, lines.length - 1));
  const endLine = clamp(input.sourceLineEnd, startLine, Math.max(0, lines.length - 1));

  const sliceLines = lines.slice(startLine, endLine + 1);
  const sliceText = sliceLines.join(eol);

  const trimmedSelection = (input.selectionText ?? '').trim();
  let warning: string | undefined;
  let effectiveMode: WritebackInput['mode'] = input.mode;

  // ===== replace：必须精确匹配，否则 fail =====
  // ===== insertAfter：legacy 路径，匹配上=选区紧后插入；匹配不上=块末插入 =====
  // ===== appendBelowBlock：完全不动选区，块末插入，永远安全 =====

  let nextSliceText: string;

  if (effectiveMode === 'replace') {
    if (!trimmedSelection) {
      return {
        ok: false,
        errorMessage: '替换模式需要明确的选区文本，但收到空选区。',
      };
    }
    const matchStart = sliceText.indexOf(trimmedSelection);
    if (matchStart < 0) {
      if (!input.allowFallbackAppend) {
        return {
          ok: false,
          errorMessage:
            '未能在选区行内精确匹配到选中文本（可能是渲染后的 HTML 与原 Markdown 不一致）。' +
            '为防止误删原文，已拒绝替换。可改用「提问」模式或「记想法」模式以追加方式写入。',
        };
      }
      // 用户明确允许降级 → 转 appendBelowBlock
      warning = '未在选区行内精确匹配到选中文本，已改为在所选 block 末尾追加。';
      effectiveMode = 'appendBelowBlock';
      nextSliceText = sliceText;
    } else {
      const matchEnd = matchStart + trimmedSelection.length;
      nextSliceText =
        sliceText.slice(0, matchStart) +
        input.newContent +
        sliceText.slice(matchEnd);
    }
  } else if (effectiveMode === 'insertAfter') {
    if (trimmedSelection) {
      const matchStart = sliceText.indexOf(trimmedSelection);
      if (matchStart >= 0) {
        const matchEnd = matchStart + trimmedSelection.length;
        nextSliceText =
          sliceText.slice(0, matchEnd) +
          eol + eol +
          input.newContent +
          sliceText.slice(matchEnd);
      } else {
        // 找不到 → 退化为块末插入（之前是"行末插入"，差异不大但语义更清晰）
        warning = '未在选区行内精确匹配到选中文本，已在所选行末尾插入。';
        nextSliceText = sliceText + eol + eol + input.newContent;
      }
    } else {
      // 空选区：直接在块末插入
      nextSliceText = sliceText + eol + eol + input.newContent;
    }
  } else {
    // appendBelowBlock：完全不修改选区文本，块末原样保留
    nextSliceText = sliceText;
  }

  // ===== 拼回完整文件 =====

  let merged: string[];
  // 记录 appendBelowBlock 实际写入的"内容行数"，用于回报 appliedRange
  let appendBodyLineCount = 0;
  if (effectiveMode === 'appendBelowBlock') {
    // 选区原样 + 块后插入 newContent，前后各夹一个空行保证块边界。
    // 先把 newContent 自身首尾的空行 trim 掉，避免叠加产生 4+ 连续空行。
    const before = lines.slice(0, endLine + 1);
    const after = lines.slice(endLine + 1);
    const trimmedNew = input.newContent.replace(/^\n+|\n+$/g, '');
    const bodyLines = trimmedNew.split(eol);
    appendBodyLineCount = bodyLines.length;
    const inserted = ['', ...bodyLines, ''];
    merged = [...before, ...inserted, ...after];
  } else {
    const before = lines.slice(0, startLine);
    const after = lines.slice(endLine + 1);
    merged = [...before, ...nextSliceText.split(eol), ...after];
  }

  const finalText = merged.join(eol);

  // ===== 写回前先备份当前内容 =====
  const backupPath = await writeBackup(input.filePath, raw);

  try {
    // writeMarkdown runs through fixLatex(), which we want for AI output.
    await writeMarkdown(input.filePath, finalText);
  } catch (error) {
    return {
      ok: false,
      errorMessage: `写回讲义失败：${(error as Error).message}`,
      backupPath,
    };
  }

  // 计算返回给前端的 appliedRange（用于高亮）
  let appliedStart: number;
  let appliedEnd: number;
  if (effectiveMode === 'appendBelowBlock') {
    // before[length] = endLine+1，紧接 inserted[0]='' 在该行；
    // inserted[1] 才是新内容首行，落在 index endLine+2 处。
    appliedStart = endLine + 2;
    appliedEnd = appliedStart + Math.max(0, appendBodyLineCount - 1);
  } else {
    appliedStart = startLine;
    const newSliceLineCount = nextSliceText.split(eol).length;
    appliedEnd = startLine + Math.max(0, newSliceLineCount - 1);
  }

  return {
    ok: true,
    appliedRange: {
      startLine: appliedStart,
      endLine: appliedEnd,
    },
    warning,
    backupPath,
  };
}
