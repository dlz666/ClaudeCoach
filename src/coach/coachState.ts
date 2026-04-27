import * as path from 'path';
import { Subject } from '../types';
import { readJson, writeJson } from '../utils/fileSystem';
import { StoragePathResolver } from '../storage/pathResolver';

/**
 * Coach 的运行时状态，部分内存 + 落盘到 `appDir/coach/state.json`。
 *
 * 不要把这个跟 SuggestionStore / SessionLogger 混淆：
 * - 这里只放"全局开关 / 计数 / 最近 tick 时间"等小信息
 * - suggestion / activity / session 各自有自己的存储
 */
export interface CoachStreak {
  count: number;
  direction: 'up' | 'down';
}

export interface CoachState {
  doNotDisturbUntil: string | null;
  streaks: Record<Subject, CoachStreak>;
  lastBriefAt: string | null;
  lastIdleNudgeAt: string | null;
  lastSrCheckAt: string | null;
}

const DEFAULT_STATE: CoachState = {
  doNotDisturbUntil: null,
  streaks: {},
  lastBriefAt: null,
  lastIdleNudgeAt: null,
  lastSrCheckAt: null,
};

/** 拼接 coach 目录下的状态文件路径。pathResolver 不允许改，这里自己拼。 */
function resolveCoachStatePath(paths: StoragePathResolver): string {
  return path.join(paths.appDir, 'coach', 'state.json');
}

export class CoachStateStore {
  private cache: CoachState | null = null;

  constructor(private readonly paths: StoragePathResolver) {}

  /** 读取（带缓存）。文件不存在时返回默认状态。 */
  async get(): Promise<CoachState> {
    if (this.cache) {
      return this.cloneState(this.cache);
    }
    const file = await readJson<Partial<CoachState>>(resolveCoachStatePath(this.paths));
    const merged: CoachState = {
      ...DEFAULT_STATE,
      ...(file ?? {}),
      streaks: { ...DEFAULT_STATE.streaks, ...(file?.streaks ?? {}) },
    };
    this.cache = merged;
    return this.cloneState(merged);
  }

  async save(state: CoachState): Promise<void> {
    this.cache = this.cloneState(state);
    await writeJson(resolveCoachStatePath(this.paths), state);
  }

  async setDoNotDisturb(until: string | null): Promise<void> {
    const cur = await this.get();
    cur.doNotDisturbUntil = until;
    await this.save(cur);
  }

  async getStreak(subject: Subject): Promise<CoachStreak> {
    const cur = await this.get();
    return cur.streaks[subject] ?? { count: 0, direction: 'up' };
  }

  /**
   * 更新 streak。direction='reset' 直接归零并视为 up 方向。
   * 同方向递增；换方向则把 count 重置为 1 并切方向。
   */
  async updateStreak(
    subject: Subject,
    direction: 'up' | 'down' | 'reset',
  ): Promise<CoachStreak> {
    const cur = await this.get();
    const prev = cur.streaks[subject] ?? { count: 0, direction: 'up' as const };
    let next: CoachStreak;
    if (direction === 'reset') {
      next = { count: 0, direction: 'up' };
    } else if (direction === prev.direction) {
      next = { count: prev.count + 1, direction };
    } else {
      next = { count: 1, direction };
    }
    cur.streaks[subject] = next;
    await this.save(cur);
    return { ...next };
  }

  private cloneState(state: CoachState): CoachState {
    return {
      doNotDisturbUntil: state.doNotDisturbUntil,
      streaks: { ...state.streaks },
      lastBriefAt: state.lastBriefAt,
      lastIdleNudgeAt: state.lastIdleNudgeAt,
      lastSrCheckAt: state.lastSrCheckAt,
    };
  }
}
