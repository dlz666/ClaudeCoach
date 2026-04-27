import {
  SpacedRepetitionItem,
  SpacedRepetitionQueue,
  Subject,
  WrongQuestion,
} from '../types';
import { readJson, writeJson } from '../utils/fileSystem';
import { StoragePathResolver } from '../storage/pathResolver';

/**
 * 间隔重复（SR）队列持久化。
 *
 * - 每个 subject 一份 JSON，落在 pathResolver.spacedRepetitionQueuePath(subject)
 * - 复用 WrongQuestion 作为来源（sourceWrongQuestionId 关联）
 * - 算法：简化 SM-2，由 recordReview 维护 ease/interval/nextDueAt
 */

const INITIAL_INTERVAL_DAYS = 1;
const INITIAL_EASE = 2.5;
const MIN_EASE = 1.3;
const DAY_MS = 24 * 60 * 60 * 1000;

function newItemId(): string {
  return `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyQueue(subject: Subject): SpacedRepetitionQueue {
  return {
    schemaVersion: 1,
    subject,
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

export class SpacedRepetitionStore {
  constructor(private readonly paths: StoragePathResolver) {}

  /** 读取队列。文件不存在时返回 emptyQueue。 */
  async getQueue(subject: Subject): Promise<SpacedRepetitionQueue> {
    const file = this.paths.spacedRepetitionQueuePath(subject);
    const raw = await readJson<SpacedRepetitionQueue>(file);
    if (!raw) {
      return emptyQueue(subject);
    }
    return {
      schemaVersion: raw.schemaVersion ?? 1,
      subject: raw.subject ?? subject,
      items: Array.isArray(raw.items) ? raw.items : [],
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
    };
  }

  async saveQueue(queue: SpacedRepetitionQueue): Promise<void> {
    const next: SpacedRepetitionQueue = {
      ...queue,
      schemaVersion: queue.schemaVersion ?? 1,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.paths.spacedRepetitionQueuePath(queue.subject), next);
  }

  /** 列表（直接返回当前快照）。 */
  async list(subject: Subject): Promise<SpacedRepetitionItem[]> {
    const q = await this.getQueue(subject);
    return q.items.slice();
  }

  /** 当前到期项。 */
  async dueItems(subject: Subject, now: Date = new Date()): Promise<SpacedRepetitionItem[]> {
    const items = await this.list(subject);
    const t = now.getTime();
    return items.filter((it) => {
      const due = Date.parse(it.nextDueAt);
      if (Number.isNaN(due)) {
        return true;
      }
      return due <= t;
    });
  }

  /** 把一道错题加入队列。如果已存在同 sourceWrongQuestionId 则跳过。 */
  async add(subject: Subject, wq: WrongQuestion): Promise<SpacedRepetitionItem | null> {
    const queue = await this.getQueue(subject);
    const existing = queue.items.find((it) => it.sourceWrongQuestionId === wq.id);
    if (existing) {
      return null;
    }
    const now = Date.now();
    const item: SpacedRepetitionItem = {
      id: newItemId(),
      sourceWrongQuestionId: wq.id,
      subject,
      topicId: wq.topicId,
      lessonId: wq.lessonId,
      repetitionCount: 0,
      easeFactor: INITIAL_EASE,
      intervalDays: INITIAL_INTERVAL_DAYS,
      nextDueAt: new Date(now + INITIAL_INTERVAL_DAYS * DAY_MS).toISOString(),
      lastReviewedAt: null,
      lastQuality: undefined,
    };
    queue.items.push(item);
    await this.saveQueue(queue);
    return item;
  }

  /**
   * 记录一次复习，按 SM-2 简化版更新 ease/interval/nextDueAt。
   * @param itemId SR item id（不是 sourceWrongQuestionId）
   * @param quality 0..5
   */
  async recordReview(
    subject: Subject,
    itemId: string,
    quality: number,
  ): Promise<SpacedRepetitionItem | null> {
    const queue = await this.getQueue(subject);
    const idx = queue.items.findIndex((it) => it.id === itemId);
    if (idx < 0) {
      return null;
    }

    const cur = { ...queue.items[idx] };
    const q = Math.max(0, Math.min(5, Math.round(quality)));

    if (q < 3) {
      cur.repetitionCount = 0;
      cur.intervalDays = INITIAL_INTERVAL_DAYS;
      cur.easeFactor = Math.max(MIN_EASE, cur.easeFactor - 0.2);
    } else {
      cur.repetitionCount = (cur.repetitionCount ?? 0) + 1;
      // SM-2 ease 调整公式
      const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
      cur.easeFactor = Math.max(MIN_EASE, cur.easeFactor + delta);
      const baseInterval = cur.intervalDays > 0 ? cur.intervalDays : INITIAL_INTERVAL_DAYS;
      cur.intervalDays = Math.max(1, Math.round(baseInterval * cur.easeFactor));
    }

    const now = Date.now();
    cur.lastReviewedAt = new Date(now).toISOString();
    cur.lastQuality = q;
    cur.nextDueAt = new Date(now + cur.intervalDays * DAY_MS).toISOString();

    queue.items[idx] = cur;
    await this.saveQueue(queue);
    return cur;
  }

  /** 按 sourceWrongQuestionId 找。一道错题最多对应一个 SR item。 */
  async findBySourceId(
    subject: Subject,
    sourceWrongQuestionId: string,
  ): Promise<SpacedRepetitionItem | null> {
    const items = await this.list(subject);
    return items.find((it) => it.sourceWrongQuestionId === sourceWrongQuestionId) ?? null;
  }

  /** 按 lesson + exercise 关联反查（grade 反馈循环用）。 */
  async findByExercise(
    subject: Subject,
    lessonId: string,
    exerciseId: string,
  ): Promise<SpacedRepetitionItem | null> {
    const items = await this.list(subject);
    return (
      items.find(
        (it) =>
          it.lessonId === lessonId &&
          it.sourceWrongQuestionId.toLowerCase().includes(exerciseId.toLowerCase()),
      ) ?? null
    );
  }
}
