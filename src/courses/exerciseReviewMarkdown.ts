import type { Exercise, GradeResult } from '../types';

export const EXERCISE_REVIEW_SCORE_MARKER = '> **Score: ';

function markerId(exerciseId: string): string {
  return String(exerciseId || 'exercise').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeText(value: unknown): string {
  return String(value ?? '').replace(/-->/g, '—>');
}

function quoteMarkdown(value: unknown, fallback = '（未记录）'): string {
  const text = safeText(value).trim() || fallback;
  return text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function listMarkdown(items: string[] | undefined): string {
  return (items ?? [])
    .map((item) => safeText(item).trim())
    .filter(Boolean)
    .map((item) => `- ${item.replace(/\r?\n/g, ' ')}`)
    .join('\n');
}

function tableCell(value: unknown): string {
  return safeText(value).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();
}

function exerciseNumber(exercise: Exercise): number | null {
  const match = String(exercise.id || '').match(/(\d+)\s*$/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function buildExerciseReviewBlock(
  exercise: Exercise,
  result: GradeResult,
  studentAnswer: string,
): string {
  const id = markerId(exercise.id);
  const dimensions = Array.isArray(result.dimensionScores) ? result.dimensionScores : [];
  const strengths = listMarkdown(result.strengths);
  const weaknesses = listMarkdown(result.weaknesses);
  const correctionItems = [
    result.errorDiagnosis ? `- **关键诊断：** ${safeText(result.errorDiagnosis).replace(/\r?\n/g, ' ')}` : '',
    result.correction ? `- **最小修正：** ${safeText(result.correction).replace(/\r?\n/g, ' ')}` : '',
    result.nextStep ? `- **下一步：** ${safeText(result.nextStep).replace(/\r?\n/g, ' ')}` : '',
  ].filter(Boolean).join('\n');
  const gradedAt = result.gradedAt ? result.gradedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '';

  const parts = [
    `<!-- CLAUDECOACH_REVIEW_START:${id} -->`,
    `### 最近一次批改 · ${Math.max(0, Math.min(100, Number(result.score) || 0))}/100`,
    '',
    `${EXERCISE_REVIEW_SCORE_MARKER}${Math.max(0, Math.min(100, Number(result.score) || 0))}/100**  `,
    gradedAt ? `> 批改时间：${gradedAt}  ` : '',
    `> 本次使用提示：${Math.max(0, Number(result.hintsUsed) || 0)} 次`,
    '',
    '#### 你的答案',
    '',
    quoteMarkdown(studentAnswer),
    '',
    '#### 教练反馈',
    '',
    quoteMarkdown(result.feedback, '（暂无文字反馈）'),
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');

  if (dimensions.length) {
    parts.push(
      '',
      '#### 评分维度',
      '',
      '| 维度 | 得分 | 反馈 |',
      '| --- | ---: | --- |',
      ...dimensions.map((item) =>
        `| ${tableCell(item.name)} | ${Math.max(0, Math.min(100, Number(item.score) || 0))} | ${tableCell(item.comment || '')} |`
      ),
    );
  }
  if (strengths) parts.push('', '#### 做得好的地方', '', strengths);
  if (weaknesses) parts.push('', '#### 需要改进', '', weaknesses);
  if (correctionItems) parts.push('', '#### 订正重点', '', correctionItems);
  parts.push('', `<!-- CLAUDECOACH_REVIEW_END:${id} -->`);
  return parts.join('\n').trim();
}

export function upsertExerciseReviewMarkdown(
  markdown: string,
  exercise: Exercise,
  result: GradeResult,
  studentAnswer: string,
): string {
  const source = String(markdown || '').replace(/\r\n/g, '\n').trimEnd();
  const id = markerId(exercise.id);
  const block = buildExerciseReviewBlock(exercise, result, studentAnswer);
  const existing = new RegExp(
    `<!-- CLAUDECOACH_REVIEW_START:${escapeRegExp(id)} -->[\\s\\S]*?<!-- CLAUDECOACH_REVIEW_END:${escapeRegExp(id)} -->`,
  );
  if (existing.test(source)) {
    return `${source.replace(existing, block).trimEnd()}\n`;
  }

  const number = exerciseNumber(exercise);
  const heading = number === null
    ? null
    : new RegExp(`^##\\s+第\\s*${number}\\s*题(?:\\s|\\(|$)[^\\n]*$`, 'm').exec(source);
  if (!heading || heading.index === undefined) {
    const fallbackNumber = number ?? 1;
    return `${source}\n\n## 第 ${fallbackNumber} 题\n\n${exercise.prompt}\n\n${block}\n\n---\n`;
  }

  const sectionStart = heading.index + heading[0].length;
  const nextHeadingMatch = /^##\s+第\s*\d+\s*题(?:\s|\(|$)[^\n]*$/m.exec(source.slice(sectionStart));
  const sectionEnd = nextHeadingMatch ? sectionStart + nextHeadingMatch.index : source.length;
  const section = source.slice(sectionStart, sectionEnd);
  const separatorMatch = /^---\s*$/m.exec(section);
  let insertAt = separatorMatch ? sectionStart + separatorMatch.index : sectionEnd;

  // Replace feedback written by the legacy Markdown scanner, which had no stable markers.
  const legacyMarker = section.lastIndexOf(`\n${EXERCISE_REVIEW_SCORE_MARKER}`);
  if (legacyMarker >= 0 && (!separatorMatch || legacyMarker < separatorMatch.index)) {
    insertAt = sectionStart + legacyMarker + 1;
    const legacyEnd = separatorMatch ? sectionStart + separatorMatch.index : sectionEnd;
    return `${source.slice(0, insertAt).trimEnd()}\n\n${block}\n\n${source.slice(legacyEnd).trimStart()}\n`;
  }

  return `${source.slice(0, insertAt).trimEnd()}\n\n${block}\n\n${source.slice(insertAt).trimStart()}\n`;
}
