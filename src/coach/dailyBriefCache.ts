import {
  DailyBriefCache as DailyBriefCacheState,
  DailyBriefEntry,
  Subject,
} from '../types';
import { readJson, writeJson } from '../utils/fileSystem';
import { StoragePathResolver } from '../storage/pathResolver';

/**
 * 每日 brief 当日缓存。
 *
 * - 单文件 JSON：pathResolver.coachDailyBriefCachePath
 * - key 是 `${dateKey}#${subject ?? '__all__'}`
 * - 仅保留最近 14 天，超过即丢弃
 */

const RETAIN_DAYS = 14;

function entryKey(dateKey: string, subject?: Subject): string {
  return `${dateKey}#${subject ?? '__all__'}`;
}

function emptyState(): DailyBriefCacheState {
  return { schemaVersion: 1, entries: [] };
}

export class DailyBriefCache {
  constructor(private readonly paths: StoragePathResolver) {}

  private async load(): Promise<DailyBriefCacheState> {
    const raw = await readJson<DailyBriefCacheState>(this.paths.coachDailyBriefCachePath);
    if (!raw) {
      return emptyState();
    }
    return {
      schemaVersion: raw.schemaVersion ?? 1,
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    };
  }

  /** 读：命中返回条目，未命中返回 null。 */
  async get(dateKey: string, subject?: Subject): Promise<DailyBriefEntry | null> {
    const state = await this.load();
    const k = entryKey(dateKey, subject);
    return (
      state.entries.find((e) => entryKey(e.dateKey, e.subject) === k) ?? null
    );
  }

  /** 写：覆盖旧条目（同 dateKey + subject）。同时按 RETAIN_DAYS 修剪过老条目。 */
  async put(entry: DailyBriefEntry): Promise<void> {
    const state = await this.load();
    const k = entryKey(entry.dateKey, entry.subject);
    const filtered = state.entries.filter(
      (e) => entryKey(e.dateKey, e.subject) !== k,
    );
    filtered.push(entry);

    const cutoffMs = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    const kept = filtered.filter((e) => {
      const t = Date.parse(e.dateKey);
      if (Number.isNaN(t)) {
        return true;
      }
      return t >= cutoffMs;
    });

    const next: DailyBriefCacheState = {
      schemaVersion: 1,
      entries: kept,
    };
    await writeJson(this.paths.coachDailyBriefCachePath, next);
  }
}

/** 给定时间生成 YYYY-MM-DD 风格 dateKey。 */
export function todayDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
