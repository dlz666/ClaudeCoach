import * as fs from 'fs/promises';
import * as path from 'path';
import { Subject } from '../types';
import { ensureDir } from '../utils/fileSystem';
import { StoragePathResolver } from '../storage/pathResolver';
import { CoachEvent, CoachEventBus } from './coachEventBus';

/**
 * 学习会话与活动日志记录器。
 *
 * - 一个 session = 用户一段连续的"在场学习"。trigger 决定开始原因。
 * - 每条 activity entry 是一次更细粒度的事件（打字、点开讲义、批改等）。
 * - 内存维护一个 200 条的环形缓冲；同时按天 jsonl 落盘。
 * - 每小时 flush 一次（背景 setInterval）。
 */

export type StudySessionTrigger = 'webview-visible' | 'editor-open' | 'manual';

export interface StudySession {
  id: string;
  trigger: StudySessionTrigger;
  startedAt: string;
  endedAt?: string;
  activeMillis: number;
  lessonsTouched: string[];
  subjectsTouched: Subject[];
  /** 更新计数：方便后续 brief 用，无需重读全部 activity。 */
  eventCounts: Record<string, number>;
}

export interface LearnerActivityEntry {
  at: string;
  /** 一般直接用 CoachEvent.kind，但也接受 logger 自己合成的字符串。 */
  kind: string;
  subject?: Subject;
  topicId?: string;
  lessonId?: string;
  meta?: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 60 * 60 * 1000; // 1h
const RING_CAPACITY = 200;
const ACTIVITY_GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5min 内算同一 activity 块

function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resolveActivityLogPath(paths: StoragePathResolver, day: string): string {
  return path.join(paths.appDir, 'coach', 'activity', `${day}.jsonl`);
}

function resolveSessionLogPath(paths: StoragePathResolver, day: string): string {
  return path.join(paths.appDir, 'coach', 'sessions', `${day}.jsonl`);
}

function newSessionId(): string {
  return `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionLogger {
  private current: StudySession | null = null;
  private readonly ring: LearnerActivityEntry[] = [];
  private readonly pendingActivity: LearnerActivityEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;

  constructor(
    private readonly paths: StoragePathResolver,
    private readonly bus: CoachEventBus,
  ) {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[SessionLogger] flush error:', err);
      });
    }, FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  /** 启动新会话。如果已有进行中的 session，先结束它。 */
  startSession(trigger: StudySessionTrigger): string {
    if (this.current) {
      // 异步收尾，不阻塞调用方
      void this.endSession();
    }
    const id = newSessionId();
    const now = new Date().toISOString();
    this.current = {
      id,
      trigger,
      startedAt: now,
      activeMillis: 0,
      lessonsTouched: [],
      subjectsTouched: [],
      eventCounts: {},
    };
    this.lastActivityAt = Date.now();
    return id;
  }

  /** 记录一次活动。同时更新 session 的统计 + 进入 pending 待 flush。 */
  recordActivity(entry: Omit<LearnerActivityEntry, 'at'>): void {
    const full: LearnerActivityEntry = {
      ...entry,
      at: new Date().toISOString(),
    };

    // 内存环
    this.ring.push(full);
    if (this.ring.length > RING_CAPACITY) {
      this.ring.shift();
    }

    this.pendingActivity.push(full);

    if (this.current) {
      const now = Date.now();
      if (this.lastActivityAt > 0 && now - this.lastActivityAt < ACTIVITY_GAP_THRESHOLD_MS) {
        this.current.activeMillis += now - this.lastActivityAt;
      }
      this.lastActivityAt = now;

      this.current.eventCounts[full.kind] = (this.current.eventCounts[full.kind] ?? 0) + 1;
      if (full.lessonId && !this.current.lessonsTouched.includes(full.lessonId)) {
        this.current.lessonsTouched.push(full.lessonId);
      }
      if (full.subject && !this.current.subjectsTouched.includes(full.subject)) {
        this.current.subjectsTouched.push(full.subject);
      }
    }
  }

  /** 当前 session 的快照（不可变拷贝）。无 session 时返回 null。 */
  getCurrentSession(): StudySession | null {
    if (!this.current) {
      return null;
    }
    return {
      ...this.current,
      lessonsTouched: [...this.current.lessonsTouched],
      subjectsTouched: [...this.current.subjectsTouched],
      eventCounts: { ...this.current.eventCounts },
    };
  }

  /** 结束当前 session：写入 session jsonl，并把待写 activity 一并 flush。 */
  async endSession(): Promise<void> {
    const cur = this.current;
    if (!cur) {
      return;
    }
    cur.endedAt = new Date().toISOString();
    this.current = null;

    try {
      const file = resolveSessionLogPath(this.paths, todayKey(new Date(cur.startedAt)));
      await ensureDir(path.dirname(file));
      await fs.appendFile(file, JSON.stringify(cur) + '\n', 'utf-8');
    } catch (err) {
      console.error('[SessionLogger] endSession write error:', err);
    }

    await this.flush();
  }

  /**
   * 取最近 N 条活动。优先从内存环读，环不够再从今天日志补。
   * 注：跨天合并不做（成本太高），调用方一般只关心 last few hours。
   */
  async recentActivity(limit: number): Promise<LearnerActivityEntry[]> {
    if (limit <= 0) {
      return [];
    }
    const fromRing = this.ring.slice(-limit);
    if (fromRing.length >= limit) {
      return fromRing;
    }

    const need = limit - fromRing.length;
    const file = resolveActivityLogPath(this.paths, todayKey());
    let disk: LearnerActivityEntry[] = [];
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      disk = lines
        .map((l) => {
          try {
            return JSON.parse(l) as LearnerActivityEntry;
          } catch {
            return null;
          }
        })
        .filter((x): x is LearnerActivityEntry => x !== null);
    } catch {
      disk = [];
    }

    // 排除已经在内存里的（用 at+kind 粗略去重）
    const seen = new Set(fromRing.map((e) => `${e.at}|${e.kind}`));
    const diskSlice = disk
      .filter((e) => !seen.has(`${e.at}|${e.kind}`))
      .slice(-need);

    return [...diskSlice, ...fromRing];
  }

  /** Coach 优雅停机时调用，停掉 timer + 写出剩余 pending。 */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.endSession();
  }

  /** 把 pendingActivity 一次性追加到当天 jsonl。 */
  private async flush(): Promise<void> {
    if (this.pendingActivity.length === 0) {
      return;
    }
    // 按 at 的日期分桶（极少数情况可能跨日）
    const buckets = new Map<string, LearnerActivityEntry[]>();
    const drained = this.pendingActivity.splice(0, this.pendingActivity.length);
    for (const e of drained) {
      const day = todayKey(new Date(e.at));
      let bucket = buckets.get(day);
      if (!bucket) {
        bucket = [];
        buckets.set(day, bucket);
      }
      bucket.push(e);
    }

    for (const [day, entries] of buckets) {
      const file = resolveActivityLogPath(this.paths, day);
      try {
        await ensureDir(path.dirname(file));
        const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.appendFile(file, body, 'utf-8');
      } catch (err) {
        console.error('[SessionLogger] flush write error:', err);
        // 写失败回滚到 pending，下次再试
        this.pendingActivity.push(...entries);
      }
    }
  }
}
