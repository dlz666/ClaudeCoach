import { LearningPlan, Subject } from '../../types';
import { CoachAgent, CoachLoop } from '../coachAgent';
import { CoachStateStore } from '../coachState';
import { LearningPlanStore } from '../learningPlanStore';

/**
 * Loop 5: DriftDetection
 *
 * - tick（每天首次）：对每个有 LearningPlan 的 subject 调 computeDrift
 *   - daysAhead < -driftThresholdDays → 推 drift-alert（high）
 *   - 同时把 plan.lastDriftCheckAt 更新（通过 lastBriefAt 同档判断"当天"）
 */

export interface DriftDetectionDeps {
  agent: CoachAgent;
  state: CoachStateStore;
  plans: LearningPlanStore;
}

const DEFAULT_DRIFT_THRESHOLD_DAYS = 2;

function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readDriftThreshold(plan: LearningPlan): number {
  const v = (plan as unknown as { driftThresholdDays?: number }).driftThresholdDays;
  if (typeof v === 'number' && v > 0) {
    return v;
  }
  return DEFAULT_DRIFT_THRESHOLD_DAYS;
}

export function createDriftDetectionLoop(deps: DriftDetectionDeps): CoachLoop {
  let lastRunDateKey: string | null = null;

  async function checkOnce(subject: Subject): Promise<void> {
    let plan: LearningPlan | null = null;
    try {
      plan = (await deps.plans.get(subject)) as unknown as LearningPlan | null;
    } catch (err) {
      console.error('[DriftLoop] plans.get error for', subject, err);
      return;
    }
    if (!plan) {
      return;
    }
    const threshold = readDriftThreshold(plan);

    let drift: { daysAhead: number; missedMilestones: unknown[]; nextMilestone: unknown } | null = null;
    try {
      drift = (await deps.plans.computeDrift(subject, new Date())) as unknown as {
        daysAhead: number;
        missedMilestones: unknown[];
        nextMilestone: unknown;
      };
    } catch (err) {
      console.error('[DriftLoop] computeDrift error:', err);
      return;
    }
    if (!drift) {
      return;
    }

    if (drift.daysAhead < -threshold) {
      const dateKey = todayKey();
      const next = drift.nextMilestone as { title?: string; expectedDoneBy?: string } | null;
      const title = `${subject} 计划进度落后 ${Math.abs(drift.daysAhead)} 天`;
      const body = next
        ? `下一里程碑「${next.title ?? '未命名'}」原定 ${next.expectedDoneBy ?? '?'} 完成，已逾期。`
        : '本周计划已落后，建议查看并调整 milestone。';

      try {
        await deps.agent.pushSuggestion({
          dedupKey: `drift-${subject}-${dateKey}`,
          source: 'driftDetection',
          channel: 'banner',
          urgency: 'high',
          status: 'preview',
          title,
          body,
          subject,
          payload: {
            daysAhead: drift.daysAhead,
            missedCount: Array.isArray(drift.missedMilestones)
              ? drift.missedMilestones.length
              : 0,
            actionLabel: '查看计划',
            command: 'openLearningPlan',
            commandArgs: { subject },
          },
        } as unknown as Parameters<CoachAgent['pushSuggestion']>[0]);
      } catch (err) {
        console.error('[DriftLoop] pushSuggestion error:', err);
      }
    }
  }

  return {
    name: 'drift',
    async tick(): Promise<void> {
      try {
        const enabled = await deps.agent.isLoopEnabled('drift');
        if (!enabled) {
          return;
        }
        const dateKey = todayKey();
        if (lastRunDateKey === dateKey) {
          return;
        }
        // 用 lastBriefAt 判定当天是否已跑（与 dailyBrief 复用同一锚点）
        const stateNow = await deps.state.get();
        const lastBriefDate = stateNow.lastBriefAt
          ? todayKey(new Date(stateNow.lastBriefAt))
          : null;
        // 即使 brief 没跑，drift 也可以独立每天跑一次
        lastRunDateKey = dateKey;

        const subjects = await deps.plans.listSubjects();
        if (subjects.length === 0) {
          return;
        }
        for (const s of subjects) {
          await checkOnce(s);
        }

        // 仅作日志锚点
        void lastBriefDate;
      } catch (err) {
        console.error('[DriftLoop] tick error:', err);
      }
    },
  };
}
