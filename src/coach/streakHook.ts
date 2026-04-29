import {
  CourseOutline,
  FeedbackWeaknessTag,
  Subject,
} from '../types';
import { AdaptiveEngine } from '../progress/adaptiveEngine';
import { CoachAgent } from './coachAgent';
import { CoachEventBus } from './coachEventBus';

/**
 * Phase 3B：批改完成后的 Coach 联动入口。
 *
 * 一次调用做四件事：
 *  1) emit `grade-submitted` 事件给所有 Loop（onEvent 拓展点）
 *  2) streak 检测：连续 ≥3 推 streak-up / streak-down suggestion
 *  3) 跨课时 weakness tag 关联：同 tag 出现在 ≥3 个不同 topic → related-lesson suggestion
 *  4) 全部出错时不 throw，仅 console
 */

export interface RecordGradeForCoachArgs {
  subject: Subject;
  topicId: string;
  topicTitle?: string;
  lessonId: string;
  lessonTitle?: string;
  score: number;
  weaknessTags: FeedbackWeaknessTag[];
  adaptiveEngine: AdaptiveEngine;
  bus: CoachEventBus;
  agent: CoachAgent;
  outline?: CourseOutline | null;
}

const SCORE_HIGH = 80;
const SCORE_LOW = 50;
const STREAK_TRIGGER = 3;
const WEAKNESS_TOPIC_TRIGGER = 3;

/** Suggestion 持久化 shape（与 SuggestionStore 内部 shape 对齐）。 */
type StoreSuggestionDraft = {
  dedupKey: string;
  source: string;
  channel: 'toast' | 'banner' | 'inline';
  urgency: 'low' | 'medium' | 'high';
  status: 'preview';
  title: string;
  body?: string;
  subject?: Subject;
  topicId?: string;
  lessonId?: string;
  expiresAt?: string;
  payload?: Record<string, unknown>;
};

/** 安全地推一条 suggestion；CoachAgent 内部 shape 与 types.ts 不完全对齐，统一 cast 过去。 */
async function pushSuggestionSafely(agent: CoachAgent, draft: StoreSuggestionDraft): Promise<void> {
  try {
    await agent.pushSuggestion(draft as unknown as Parameters<CoachAgent['pushSuggestion']>[0]);
  } catch (err) {
    console.error('[streakHook] pushSuggestion error:', err);
  }
}

function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function recordGradeForCoach(args: RecordGradeForCoachArgs): Promise<void> {
  const {
    subject,
    topicId,
    topicTitle,
    lessonId,
    lessonTitle,
    score,
    weaknessTags,
    adaptiveEngine,
    bus,
    agent,
    outline,
  } = args;

  // 1) emit
  try {
    bus.emit({
      kind: 'grade-submitted',
      at: new Date().toISOString(),
      subject,
      topicId,
      lessonId,
      meta: {
        score,
        weaknessTags,
        topicTitle,
        lessonTitle,
      },
    });
  } catch (err) {
    console.error('[streakHook] bus.emit error:', err);
  }

  // 2) streak
  try {
    const direction: 'up' | 'down' | 'reset' =
      score >= SCORE_HIGH ? 'up' : score <= SCORE_LOW ? 'down' : 'reset';
    const result = await adaptiveEngine.updateStreak(subject, direction);
    if (
      result.count >= STREAK_TRIGGER &&
      result.direction &&
      direction !== 'reset'
    ) {
      const isUp = result.direction === 'up';
      const dateKey = todayKey();
      await pushSuggestionSafely(agent, {
        dedupKey: `streak-${result.direction}-${subject}-${dateKey}`,
        source: 'streakHook',
        channel: isUp ? 'toast' : 'banner',
        urgency: isUp ? 'low' : 'medium',
        status: 'preview',
        title: isUp
          ? `连续答对 ${result.count} 题，状态不错`
          : `连续 ${result.count} 题失分，需要降速`,
        body: isUp
          ? '可以挑战一下更难的练习，或推进到下一节。'
          : '建议回看讲义、做一道基础题再继续。',
        subject,
        topicId,
        lessonId,
        payload: {
          streak: result.count,
          direction: result.direction,
          // Evidence trail：让用户能看见"为什么我看到这条"
          evidence: [
            {
              kind: 'streak',
              ref: `${result.direction}×${result.count}`,
              summary: isUp
                ? `最近 ${result.count} 道题分数 ≥ ${SCORE_HIGH}（连对触发）`
                : `最近 ${result.count} 道题分数 ≤ ${SCORE_LOW}（连错触发）`,
              createdAt: new Date().toISOString(),
            },
            {
              kind: 'grade',
              ref: `${topicId}/${lessonId}`,
              summary: `当前题 ${score}/100 — ${lessonTitle ?? lessonId}`,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    }
  } catch (err) {
    console.error('[streakHook] streak error:', err);
  }

  // 3) 跨课时 weakness tag 关联
  if (Array.isArray(weaknessTags) && weaknessTags.length > 0) {
    for (const tag of weaknessTags) {
      try {
        const occurCount = await adaptiveEngine.recordWeaknessTagOccurrence(
          subject,
          tag,
          topicId,
        );
        if (occurCount >= WEAKNESS_TOPIC_TRIGGER) {
          const otherTopicTitles = collectTopicTitles(outline ?? null, topicId).slice(0, 3);
          const dateKey = todayKey();
          await pushSuggestionSafely(agent, {
            dedupKey: `related-lesson-${subject}-${tag}-${dateKey}`,
            source: 'streakHook',
            channel: 'banner',
            urgency: 'medium',
            status: 'preview',
            title: `「${tag}」类失误已跨 ${occurCount} 个主题`,
            body: otherTopicTitles.length > 0
              ? `相关主题：${otherTopicTitles.join('、')}。建议做一次该类型的串题复习。`
              : '建议做一次该类型的串题复习。',
            subject,
            topicId,
            lessonId,
            payload: {
              weaknessTag: tag,
              topicCount: occurCount,
              evidence: [
                {
                  kind: 'weakness-tag',
                  ref: tag,
                  summary: `"${tag}" 类弱点已在 ${occurCount} 个不同章节出现`,
                  createdAt: new Date().toISOString(),
                },
                ...otherTopicTitles.slice(0, 3).map((t) => ({
                  kind: 'grade' as const,
                  ref: t,
                  summary: `章节"${t}"也出现过 "${tag}" 弱点`,
                  createdAt: new Date().toISOString(),
                })),
              ],
            },
          });
        }
      } catch (err) {
        console.error('[streakHook] weaknessTag error:', err);
      }
    }
  }
}

function collectTopicTitles(outline: CourseOutline | null, excludeTopicId: string): string[] {
  if (!outline?.topics) {
    return [];
  }
  return outline.topics
    .filter((t) => t.id !== excludeTopicId)
    .map((t) => t.title)
    .filter((title): title is string => typeof title === 'string' && title.length > 0);
}
