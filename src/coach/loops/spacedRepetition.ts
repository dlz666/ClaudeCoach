import { Subject, WrongQuestion } from '../../types';
import { CourseManager } from '../../courses/courseManager';
import { CoachAgent, CoachLoop } from '../coachAgent';
import { CoachEvent } from '../coachEventBus';
import { CoachStateStore } from '../coachState';
import { SpacedRepetitionStore } from '../spacedRepetitionStore';

/**
 * Loop 3: SpacedRepetition
 *
 * - onEvent('grade-submitted')
 *   - score < 70 → 把对应错题加入 SR 队列（可能是新增）
 *   - score >= 90 → 视作复习成功，调 recordReview(quality=5)
 * - tick（每天首次）：dueItems > 0 → 推 sr-due banner
 */

export interface SpacedRepetitionLoopDeps {
  agent: CoachAgent;
  state: CoachStateStore;
  courseManager: CourseManager;
  sr: SpacedRepetitionStore;
}

const SCORE_FAIL = 70;
const SCORE_PERFECT = 90;
const QUALITY_PERFECT = 5;

function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createSpacedRepetitionLoop(
  deps: SpacedRepetitionLoopDeps,
): CoachLoop {
  let lastDueCheckDateKey: string | null = null;

  async function findRecentWrongQuestionForLesson(
    subject: Subject,
    lessonId: string,
    exerciseId?: string,
  ): Promise<WrongQuestion | null> {
    try {
      const list = await deps.courseManager.listWrongQuestions(subject, {
        onlyUnresolved: false,
        limit: 50,
      });
      // 同 lesson + (优先) 同 exercise
      const sameLesson = list.filter((q) => q.lessonId === lessonId);
      if (exerciseId) {
        const exact = sameLesson.find((q) => q.exerciseId === exerciseId);
        if (exact) return exact;
      }
      sameLesson.sort((a, b) => b.lastAttemptedAt.localeCompare(a.lastAttemptedAt));
      return sameLesson[0] ?? null;
    } catch (err) {
      console.error('[SRLoop] listWrongQuestions error:', err);
      return null;
    }
  }

  async function pushSrDueIfAny(): Promise<void> {
    try {
      const enabled = await deps.agent.isLoopEnabled('sr');
      if (!enabled) {
        return;
      }
      const courses = await deps.courseManager.getAllCourses();
      const dueBySubject = new Map<Subject, number>();
      let total = 0;
      for (const c of courses) {
        try {
          const items = await deps.sr.dueItems(c.subject);
          if (items.length > 0) {
            dueBySubject.set(c.subject, items.length);
            total += items.length;
          }
        } catch (err) {
          console.error('[SRLoop] dueItems error for', c.subject, err);
        }
      }
      if (total === 0) {
        return;
      }
      const dateKey = todayKey();
      // 取数量最多的 subject 推
      let topSubject: Subject | undefined;
      let topCount = 0;
      for (const [s, n] of dueBySubject) {
        if (n > topCount) {
          topCount = n;
          topSubject = s;
        }
      }
      if (!topSubject) {
        return;
      }
      // 找一个能跳转的 lesson
      let topicId = '';
      let lessonId = '';
      let lessonTitle = '';
      try {
        const items = await deps.sr.dueItems(topSubject);
        if (items.length > 0) {
          topicId = items[0].topicId;
          lessonId = items[0].lessonId;
        }
        if (lessonId) {
          const outline = await deps.courseManager.getCourseOutline(topSubject);
          const topic = outline?.topics.find((t) => t.id === topicId);
          const lesson = topic?.lessons.find((l) => l.id === lessonId);
          lessonTitle = lesson?.title ?? lessonId;
        }
      } catch (err) {
        console.error('[SRLoop] resolve lesson error:', err);
      }

      await deps.agent.pushSuggestion({
        dedupKey: `sr-due-${topSubject}-${dateKey}`,
        source: 'spacedRepetition',
        channel: 'banner',
        urgency: total >= 5 ? 'medium' : 'low',
        status: 'preview',
        title: `${topSubject}：有 ${topCount} 道复习题待重做`,
        body: '间隔重复到期，做一组复习巩固一下吧。',
        subject: topSubject,
        topicId: topicId || undefined,
        lessonId: lessonId || undefined,
        payload: {
          dueCount: topCount,
          totalDueAcrossSubjects: total,
          actionLabel: `复习 ${Math.min(topCount, 5)} 道`,
          command: 'practiceWrongQuestions',
          commandArgs: {
            subject: topSubject,
            topicId,
            lessonId,
            lessonTitle,
            count: Math.min(topCount, 5),
          },
        },
      } as unknown as Parameters<CoachAgent['pushSuggestion']>[0]);

      try {
        const stateNow = await deps.state.get();
        stateNow.lastSrCheckAt = new Date().toISOString();
        await deps.state.save(stateNow);
      } catch (err) {
        console.error('[SRLoop] state.save error:', err);
      }
    } catch (err) {
      console.error('[SRLoop] pushSrDueIfAny error:', err);
    }
  }

  return {
    name: 'sr',
    async onEvent(event: CoachEvent): Promise<void> {
      if (event.kind !== 'grade-submitted') {
        return;
      }
      try {
        const enabled = await deps.agent.isLoopEnabled('sr');
        if (!enabled) {
          return;
        }
        const subject = event.subject;
        const lessonId = event.lessonId;
        if (!subject || !lessonId) {
          return;
        }
        const meta = (event.meta ?? {}) as {
          score?: number;
          exerciseId?: string;
        };
        const score = typeof meta.score === 'number' ? meta.score : NaN;

        if (Number.isFinite(score) && score < SCORE_FAIL) {
          const wq = await findRecentWrongQuestionForLesson(
            subject,
            lessonId,
            meta.exerciseId,
          );
          if (wq) {
            await deps.sr.add(subject, wq);
          }
        } else if (Number.isFinite(score) && score >= SCORE_PERFECT) {
          // 找队列中同 exerciseId / 同 lesson 的 item，回写一次成功复习
          const items = await deps.sr.list(subject);
          const target = items.find(
            (it) =>
              it.lessonId === lessonId &&
              (!meta.exerciseId ||
                it.sourceWrongQuestionId.toLowerCase().includes(String(meta.exerciseId).toLowerCase())),
          );
          if (target) {
            await deps.sr.recordReview(subject, target.id, QUALITY_PERFECT);
          }
        }
      } catch (err) {
        console.error('[SRLoop] onEvent error:', err);
      }
    },
    async tick(): Promise<void> {
      try {
        const dateKey = todayKey();
        if (lastDueCheckDateKey === dateKey) {
          return;
        }
        lastDueCheckDateKey = dateKey;
        await pushSrDueIfAny();
      } catch (err) {
        console.error('[SRLoop] tick error:', err);
      }
    },
  };
}
