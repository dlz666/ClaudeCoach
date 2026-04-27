import * as path from 'path';
import { Subject } from '../types';
import { ensureDir, listFiles, readJson, writeJson } from '../utils/fileSystem';
import { sanitizeSegment, StoragePathResolver } from '../storage/pathResolver';
import * as fs from 'fs/promises';

/**
 * LearningPlan：用户对某学科的学习规划。Phase 2A 只做 CRUD + drift 计算，
 * 不做 AI 自动拆解（那是 Phase 3 DriftLoop 的事）。
 */

export type PlanMilestoneStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

export interface PlanMilestone {
  id: string;
  title: string;
  description?: string;
  /** 关联到 outline 的 topicId / lessonId（可选）。 */
  topicId?: string;
  lessonId?: string;
  /** 期望完成日期，ISO（YYYY-MM-DD 或全 ISO）。drift 计算依赖它。 */
  expectedDoneBy: string;
  status: PlanMilestoneStatus;
  doneAt?: string;
  notes?: string;
}

export interface LearningPlan {
  schemaVersion: number;
  subject: Subject;
  title: string;
  goal?: string;
  startedAt: string;
  expectedFinishBy?: string;
  milestones: PlanMilestone[];
  updatedAt: string;
}

function resolvePlansDir(paths: StoragePathResolver): string {
  return path.join(paths.appDir, 'coach', 'plans');
}

function resolvePlanPath(paths: StoragePathResolver, subject: Subject): string {
  const slug = sanitizeSegment(subject, 'plan');
  return path.join(resolvePlansDir(paths), `${slug}.json`);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function diffDays(target: Date, now: Date): number {
  const ms = startOfDay(target) - startOfDay(now);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function tryParseDate(value: string): Date | null {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    return null;
  }
  return new Date(t);
}

export class LearningPlanStore {
  constructor(private readonly paths: StoragePathResolver) {}

  /** 读取某学科的 plan。文件不存在或格式错时返回 null。 */
  async get(subject: Subject): Promise<LearningPlan | null> {
    const file = resolvePlanPath(this.paths, subject);
    return await readJson<LearningPlan>(file);
  }

  async save(plan: LearningPlan): Promise<void> {
    const file = resolvePlanPath(this.paths, plan.subject);
    const next: LearningPlan = {
      ...plan,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(file, next);
  }

  async delete(subject: Subject): Promise<void> {
    const file = resolvePlanPath(this.paths, subject);
    try {
      await fs.unlink(file);
    } catch {
      // 文件不存在 → 视为成功
    }
  }

  /** 扫描 plans 目录，返回所有有 plan 的学科。 */
  async listSubjects(): Promise<Subject[]> {
    const dir = resolvePlansDir(this.paths);
    await ensureDir(dir);
    const names = await listFiles(dir, '.json');
    const subjects: Subject[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      const plan = await readJson<LearningPlan>(file);
      if (plan?.subject && !subjects.includes(plan.subject)) {
        subjects.push(plan.subject);
      }
    }
    return subjects;
  }

  /**
   * 计算偏差：
   * - missedMilestones：今天前应该 done 但仍然 pending/in-progress 的 milestone
   * - nextMilestone：下一个 pending milestone（按 expectedDoneBy 升序）
   * - daysAhead：nextMilestone.expectedDoneBy - today，单位天。负数 = 落后。
   *   没有 nextMilestone 时返回 0。
   */
  async computeDrift(
    subject: Subject,
    now: Date,
  ): Promise<{
    daysAhead: number;
    missedMilestones: PlanMilestone[];
    nextMilestone: PlanMilestone | null;
  }> {
    const plan = await this.get(subject);
    if (!plan) {
      return { daysAhead: 0, missedMilestones: [], nextMilestone: null };
    }

    const todayMs = startOfDay(now);

    const missed: PlanMilestone[] = [];
    const pendingForNext: { m: PlanMilestone; t: number }[] = [];
    for (const m of plan.milestones) {
      const due = tryParseDate(m.expectedDoneBy);
      if (!due) {
        continue;
      }
      const dueMs = startOfDay(due);
      const undone = m.status === 'pending' || m.status === 'in-progress';
      if (undone && dueMs < todayMs) {
        missed.push(m);
      }
      if (m.status === 'pending') {
        pendingForNext.push({ m, t: dueMs });
      }
    }

    pendingForNext.sort((a, b) => a.t - b.t);
    const nextMilestone = pendingForNext.length > 0 ? pendingForNext[0].m : null;

    let daysAhead = 0;
    if (nextMilestone) {
      const due = tryParseDate(nextMilestone.expectedDoneBy);
      if (due) {
        daysAhead = diffDays(due, now);
      }
    }

    return { daysAhead, missedMilestones: missed, nextMilestone };
  }
}
