import { TokenBudget, TopicSummary, GradeResult } from '../types';

/** Estimate token count: ~4 chars per token for English, ~2 for Chinese */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const ch of text) {
    count += ch.charCodeAt(0) > 127 ? 0.5 : 0.25;
  }
  return Math.ceil(count);
}

export function createBudget(contextWindow: number, fixedPromptText: string): TokenBudget {
  const reserveForOutput = 4000;
  const fixedPromptTokens = estimateTokens(fixedPromptText);
  return {
    modelContextWindow: contextWindow,
    reserveForOutput,
    fixedPromptTokens,
    availableForHistory: Math.max(0, Math.floor(contextWindow * 0.6) - reserveForOutput - fixedPromptTokens),
  };
}

/** Select history data that fits within the token budget. Prioritizes topic summaries over raw grades. */
export function selectHistoryForPrompt(
  budget: TokenBudget,
  summaries: TopicSummary[],
  grades: GradeResult[]
): { summariesText: string; gradesText: string } {
  let remaining = budget.availableForHistory;

  // First: topic summaries (high information density)
  let summariesText = '';
  for (const s of summaries) {
    const line = `[${s.subject}/${s.topicId}] 平均分${s.averageScore}，${s.totalSessions}次练习，错误类型：${JSON.stringify(s.mistakeTypes)}\n`;
    const tokens = estimateTokens(line);
    if (tokens > remaining) { break; }
    summariesText += line;
    remaining -= tokens;
  }

  // Then: recent grades (most recent first)
  let gradesText = '';
  const sorted = [...grades].sort((a, b) => b.gradedAt.localeCompare(a.gradedAt));
  for (const g of sorted) {
    const line = `[${g.exerciseId}] 得分${g.score}，优点：${g.strengths.join('、')}，不足：${g.weaknesses.join('、')}\n`;
    const tokens = estimateTokens(line);
    if (tokens > remaining) { break; }
    gradesText += line;
    remaining -= tokens;
  }

  return { summariesText, gradesText };
}
