import {
  DailyBriefEntry,
  LearningPreferences,
  Subject,
  CourseTag,
} from '../../types';
import { AIClient } from '../../ai/client';
import { CourseManager } from '../../courses/courseManager';
import { CourseProfileStore } from '../../progress/courseProfileStore';
import { PreferencesStore } from '../../progress/preferencesStore';
import { CoachAgent, CoachLoop } from '../coachAgent';
import { CoachEvent, CoachEventBus } from '../coachEventBus';
import { LearningPlanStore } from '../learningPlanStore';
import { SessionLogger } from '../sessionLogger';
import { SpacedRepetitionStore } from '../spacedRepetitionStore';
import { CoachStateStore } from '../coachState';
import { DailyBriefCache, todayDateKey } from '../dailyBriefCache';

/**
 * Loop 1: DailyBrief
 *
 * 触发：webview 变可见时
 * 行为：当日有缓存（cacheStrategy='per-day'）→ 直接 post；否则调 AI 生成 brief 并缓存
 * 失败回退：纯模板 brief
 */

export interface DailyBriefDeps {
  agent: CoachAgent;
  bus: CoachEventBus;
  prefs: PreferencesStore;
  state: CoachStateStore;
  plans: LearningPlanStore;
  sessions: SessionLogger;
  courseManager: CourseManager;
  courseProfileStore: CourseProfileStore;
  ai: AIClient;
  sr: SpacedRepetitionStore;
  cache: DailyBriefCache;
  postToSidebar: (entry: DailyBriefEntry) => void;
}

interface CoachPrefShape {
  dailyBrief?: { cacheStrategy?: 'per-day' | 'always-fresh' };
}

function readCacheStrategy(prefs: LearningPreferences): 'per-day' | 'always-fresh' {
  const coach = (prefs as unknown as { coach?: CoachPrefShape }).coach ?? {};
  return coach.dailyBrief?.cacheStrategy ?? 'per-day';
}

function yesterdayKey(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createDailyBriefLoop(deps: DailyBriefDeps): CoachLoop {
  let lastRunDateKey: string | null = null;

  async function generateAndPost(subject?: Subject): Promise<void> {
    const enabled = await deps.agent.isLoopEnabled('dailyBrief');
    if (!enabled) {
      return;
    }

    const dateKey = todayDateKey();
    const prefs = await deps.prefs.get();
    const strategy = readCacheStrategy(prefs);

    if (strategy === 'per-day') {
      const hit = await deps.cache.get(dateKey, subject);
      if (hit) {
        try {
          deps.postToSidebar(hit);
        } catch (err) {
          console.error('[DailyBriefLoop] postToSidebar (cache) error:', err);
        }
        lastRunDateKey = dateKey;
        return;
      }
    }

    const entry = await buildBrief(deps, dateKey, subject);
    try {
      await deps.cache.put(entry);
    } catch (err) {
      console.error('[DailyBriefLoop] cache.put error:', err);
    }
    try {
      deps.postToSidebar(entry);
    } catch (err) {
      console.error('[DailyBriefLoop] postToSidebar error:', err);
    }

    try {
      const stateNow = await deps.state.get();
      stateNow.lastBriefAt = new Date().toISOString();
      await deps.state.save(stateNow);
    } catch (err) {
      console.error('[DailyBriefLoop] state.save error:', err);
    }

    lastRunDateKey = dateKey;
  }

  return {
    name: 'dailyBrief',
    async onEvent(event: CoachEvent): Promise<void> {
      if (event.kind !== 'webview-visibility-changed' && (event.kind as string) !== 'webview-visible') {
        return;
      }
      // visibility 事件 meta 可能携带 visible flag；保守处理：只在变可见时触发
      const meta = (event.meta ?? {}) as { visible?: boolean };
      if (typeof meta.visible === 'boolean' && meta.visible === false) {
        return;
      }
      // 当日只跑一次
      const dateKey = todayDateKey();
      if (lastRunDateKey === dateKey) {
        return;
      }
      try {
        await generateAndPost(event.subject);
      } catch (err) {
        console.error('[DailyBriefLoop] onEvent error:', err);
      }
    },
    async tick(): Promise<void> {
      // 兜底：如果当天没跑过且 lastBriefAt 不是今天 → 跑一次
      try {
        const dateKey = todayDateKey();
        if (lastRunDateKey === dateKey) {
          return;
        }
        const stateNow = await deps.state.get();
        if (stateNow.lastBriefAt) {
          const lbk = todayDateKey(new Date(stateNow.lastBriefAt));
          if (lbk === dateKey) {
            lastRunDateKey = dateKey;
            return;
          }
        }
        await generateAndPost(undefined);
      } catch (err) {
        console.error('[DailyBriefLoop] tick error:', err);
      }
    },
  };
}

/** fallback 时按课程教学法 tag 选择"昨日回顾"模板。 */
function buildYesterdayRecapByTag(tag: CourseTag | null, activityCount: number, lessonCount: number): string {
  if (activityCount === 0) {
    if (tag === 'language') return '昨天没有打卡，今天来点轻量的：5 个新词或一段短听力。';
    if (tag === 'exam-prep') return '昨天没刷题。距离考试越近，断档越伤；今天先做半套真题热身。';
    if (tag === 'cs-skill') return '昨天没敲键盘。今天就跑一个 demo，先把状态找回来。';
    if (tag === 'math-foundation' || tag === 'math-advanced') return '昨天没动数学。今天先回顾一个核心定义+一道例题。';
    return '昨天暂无学习记录，今天从一个轻量目标开始。';
  }
  if (tag === 'language') return `昨天打卡 ${activityCount} 次，涉及 ${lessonCount} 个单元。连续性比强度更重要。`;
  if (tag === 'cs-skill') return `昨天有 ${activityCount} 次操作，涉及 ${lessonCount} 个课时。今天的目标是把昨天写过的代码再跑一遍。`;
  if (tag === 'cs-theory') return `昨天过了 ${lessonCount} 个课时（${activityCount} 次活动）。今天可以挑一个昨天接触的算法手推一遍。`;
  if (tag === 'math-foundation' || tag === 'math-advanced')
    return `昨天接触了 ${lessonCount} 个章节（${activityCount} 次活动）。今天选其中一节做严谨证明。`;
  if (tag === 'exam-prep') return `昨天有 ${activityCount} 次刷题/查考点。今天用计时模考检验一下手感。`;
  if (tag === 'humanities') return `昨天读了 ${lessonCount} 个章节。今天挑一个观点，写一段反方论证。`;
  return `昨天有 ${activityCount} 条学习活动，涉及 ${lessonCount} 个课时。`;
}

/** fallback 时按 tag 选择"今日 3 条建议"模板。 */
function buildTodaySuggestionsByTag(
  tag: CourseTag | null,
  srDueCount: number,
  planProgress: { completedMilestones: number; totalMilestones: number; daysAhead: number } | undefined,
): string[] {
  const suggestions: string[] = [];

  if (srDueCount > 0) {
    if (tag === 'language') suggestions.push(`复习 ${srDueCount} 个旧词（趁还没忘透）。`);
    else if (tag === 'exam-prep') suggestions.push(`先把 ${srDueCount} 道错题再刷一遍。`);
    else suggestions.push(`完成 ${srDueCount} 道间隔重复题。`);
  }

  if (planProgress && planProgress.daysAhead < 0) {
    suggestions.push(`计划落后 ${Math.abs(planProgress.daysAhead)} 天，今天追一个里程碑。`);
  } else {
    if (tag === 'cs-skill') suggestions.push('挑一个昨天没跑通的代码，今天搞定它。');
    else if (tag === 'cs-theory') suggestions.push('选一个算法手推一遍复杂度分析。');
    else if (tag === 'math-foundation' || tag === 'math-advanced') suggestions.push('挑一个本章定理写出严谨证明。');
    else if (tag === 'language') suggestions.push('练 10 分钟听力或写 100 字短文输出。');
    else if (tag === 'exam-prep') suggestions.push('限时做半套真题，重点看错题归因。');
    else if (tag === 'humanities') suggestions.push('挑一段引文做思辨笔记。');
    else suggestions.push('推进当前主题的下一节讲义。');
  }

  if (tag === 'cs-skill') suggestions.push('阅读一段官方文档（不超过 15 分钟）。');
  else if (tag === 'language') suggestions.push('挑 5 个高频词汇做今日新增。');
  else if (tag === 'exam-prep') suggestions.push('整理今日错题：错在概念还是粗心。');
  else suggestions.push('做一道你最近薄弱的题型。');

  return suggestions.slice(0, 3);
}

async function buildBrief(
  deps: DailyBriefDeps,
  dateKey: string,
  subject?: Subject,
): Promise<DailyBriefEntry> {
  // 1) 昨日活动
  const yKey = yesterdayKey();
  let yesterdayActivityCount = 0;
  let recentLessons: string[] = [];
  try {
    const recent = await deps.sessions.recentActivity(80);
    const yEntries = recent.filter((e) => e.at.startsWith(yKey));
    yesterdayActivityCount = yEntries.length;
    const lessons = new Set<string>();
    for (const e of yEntries) {
      if (e.lessonId) lessons.add(e.lessonId);
    }
    recentLessons = Array.from(lessons).slice(0, 5);
  } catch (err) {
    console.error('[DailyBriefLoop] sessions.recentActivity error:', err);
  }

  // 2) SR due
  let srDueCount = 0;
  const srSubjects: Subject[] = [];
  try {
    if (subject) {
      srSubjects.push(subject);
    } else {
      const courses = await deps.courseManager.getAllCourses();
      for (const c of courses) {
        srSubjects.push(c.subject);
      }
    }
    for (const s of srSubjects) {
      try {
        const due = await deps.sr.dueItems(s);
        srDueCount += due.length;
      } catch (err) {
        console.error('[DailyBriefLoop] sr.dueItems error for', s, err);
      }
    }
  } catch (err) {
    console.error('[DailyBriefLoop] enumerate subjects error:', err);
  }

  // 3) Plan 进度
  let planProgress: DailyBriefEntry['planProgress'];
  let planContextLines: string[] = [];
  try {
    const planSubjects: Subject[] = subject ? [subject] : await deps.plans.listSubjects();
    if (planSubjects.length > 0) {
      const target = planSubjects[0];
      const plan = await deps.plans.get(target);
      if (plan) {
        const drift = await deps.plans.computeDrift(target, new Date());
        const total = plan.milestones.length;
        const done = plan.milestones.filter((m) => m.status === 'done').length;
        planProgress = {
          completedMilestones: done,
          totalMilestones: total,
          daysAhead: drift.daysAhead,
        };
        planContextLines.push(
          `Plan(${target}): ${done}/${total} done, daysAhead=${drift.daysAhead}, missed=${drift.missedMilestones.length}`,
        );
        if (drift.nextMilestone) {
          planContextLines.push(
            `Next milestone: ${drift.nextMilestone.title ?? drift.nextMilestone.topicId ?? ''} by ${drift.nextMilestone.expectedDoneBy}`,
          );
        }
      }
    }
  } catch (err) {
    console.error('[DailyBriefLoop] plan progress error:', err);
  }

  // 4) recentEvents
  const recentEventsLines: string[] = [];
  try {
    if (subject) {
      const profile = await deps.courseProfileStore.getProfile(subject);
      for (const e of profile.recentEvents.slice(0, 5)) {
        recentEventsLines.push(`- ${e.type}: ${e.summary}`);
      }
    }
  } catch (err) {
    console.error('[DailyBriefLoop] recentEvents error:', err);
  }

  // 5) 调 AI
  let yesterdayRecap = '';
  let todaySuggestions: string[] = [];

  try {
    const enabled = (await deps.agent.isLoopEnabled('dailyBrief'));
    if (enabled) {
      const userPayload = {
        dateKey,
        subject: subject ?? null,
        yesterdayActivityCount,
        recentLessons,
        srDueCount,
        planProgressText: planContextLines.join(' | '),
        recentEvents: recentEventsLines,
      };
      const messages = [
        {
          role: 'system' as const,
          content:
            '你是 ClaudeCoach 学习教练。基于以下数据生成今日学习建议：1) 昨日活动 / 2) SR due / 3) Plan 进度 / 4) recentEvents。' +
            '严格输出 JSON 对象：{ "yesterdayRecap": string, "todaySuggestions": string[3], "srDueCount": number, "planProgress": { "completedMilestones": number, "totalMilestones": number, "daysAhead": number } | null }。' +
            'todaySuggestions 必须是 3 条具体可执行的中文建议，每条 ≤ 40 字。',
        },
        {
          role: 'user' as const,
          content: JSON.stringify(userPayload),
        },
      ];
      const ai = await deps.ai.chatJson<{
        yesterdayRecap?: string;
        todaySuggestions?: string[];
        srDueCount?: number;
        planProgress?: DailyBriefEntry['planProgress'];
      }>(messages);
      yesterdayRecap = typeof ai.yesterdayRecap === 'string' ? ai.yesterdayRecap : '';
      todaySuggestions = Array.isArray(ai.todaySuggestions)
        ? ai.todaySuggestions.slice(0, 3).filter((s) => typeof s === 'string')
        : [];
    }
  } catch (err) {
    console.error('[DailyBriefLoop] AI generation failed, falling back:', err);
  }

  // 6) 模板回退（按课程教学法 tag 切换话术风格）
  let primaryTag: CourseTag | null = null;
  if (subject) {
    try {
      const outline = await deps.courseManager.getCourseOutline(subject);
      const tags = (outline?.tags ?? []) as CourseTag[];
      // 多 tag 时取第一个作为话术主导
      primaryTag = tags[0] ?? null;
    } catch (err) {
      console.warn('[DailyBriefLoop] read tags failed:', err);
    }
  }

  if (!yesterdayRecap) {
    yesterdayRecap = buildYesterdayRecapByTag(primaryTag, yesterdayActivityCount, recentLessons.length);
  }
  if (todaySuggestions.length === 0) {
    todaySuggestions = buildTodaySuggestionsByTag(primaryTag, srDueCount, planProgress);
  }

  return {
    dateKey,
    subject,
    generatedAt: new Date().toISOString(),
    yesterdayRecap,
    todaySuggestions: todaySuggestions.slice(0, 3),
    srDueCount,
    planProgress,
  };
}
