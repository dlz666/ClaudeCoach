import * as fs from 'fs/promises';
import * as path from 'path';
import { Subject } from '../types';
import { ensureDir } from '../utils/fileSystem';
import { StoragePathResolver } from '../storage/pathResolver';

/**
 * Coach Suggestion：Coach 想推给用户的一条建议（toast / banner / inline 都可能用）。
 *
 * 存储是"逻辑覆盖"的 jsonl：
 * - 同一个 dedupKey 的最新条目代表"该建议的最终状态"
 * - status 之间的状态机：preview → dispatched → (acted | dismissed)
 * - list/getActive 时按 id（与 dedupKey）做去重，取每条 id 的最后一行
 */

export type CoachSuggestionStatus = 'preview' | 'dispatched' | 'acted' | 'dismissed';

export type CoachSuggestionChannel = 'toast' | 'banner' | 'inline';

export type CoachSuggestionUrgency = 'low' | 'medium' | 'high';

export interface CoachSuggestion {
  id: string;
  /** 用于跨次 emit 去重，例如 'idle-nudge-2026-04-27'。 */
  dedupKey: string;
  source: string;
  channel: CoachSuggestionChannel;
  urgency: CoachSuggestionUrgency;
  status: CoachSuggestionStatus;
  title: string;
  body?: string;
  subject?: Subject;
  topicId?: string;
  lessonId?: string;
  /** ISO；超过 expiresAt 时算失效，getActive 不返回。 */
  expiresAt?: string;
  /** 任意可序列化附加数据，例如跳转 lessonId、推荐题数。 */
  payload?: Record<string, unknown>;
  createdAt: string;
  dispatchedAt?: string;
  dismissedAt?: string;
  actedAt?: string;
}

function resolveSuggestionsPath(paths: StoragePathResolver): string {
  return path.join(paths.appDir, 'coach', 'suggestions.jsonl');
}

function urgencyRank(u: CoachSuggestionUrgency): number {
  return u === 'high' ? 2 : u === 'medium' ? 1 : 0;
}

function generateSuggestionId(): string {
  return `sug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SuggestionStore {
  constructor(private readonly paths: StoragePathResolver) {}

  /** 读取所有 suggestion（已应用最后一次 status 的逻辑覆盖）。 */
  async list(): Promise<CoachSuggestion[]> {
    const file = resolveSuggestionsPath(this.paths);
    const raw = await this.readAllLines(file);
    if (raw.length === 0) {
      return [];
    }

    // 按 id 取最后一条（jsonl 后写后赢）
    const byId = new Map<string, CoachSuggestion>();
    for (const line of raw) {
      const parsed = this.tryParse(line);
      if (parsed) {
        byId.set(parsed.id, parsed);
      }
    }
    return Array.from(byId.values());
  }

  /**
   * 写入一条 suggestion。
   * - 如果未指定 id，自动生成。
   * - 如果 dedupKey 已存在且其最后状态为 'preview'，复用旧 id（实现"覆盖"）。
   * - 否则作为新条目追加。
   */
  async upsert(s: CoachSuggestion): Promise<CoachSuggestion> {
    const all = await this.list();
    let target: CoachSuggestion = { ...s };

    if (!target.id) {
      target.id = generateSuggestionId();
    }
    if (!target.createdAt) {
      target.createdAt = new Date().toISOString();
    }

    if (target.dedupKey) {
      const existing = all.find(
        (x) => x.dedupKey === target.dedupKey && x.status === 'preview',
      );
      if (existing) {
        target.id = existing.id;
        target.createdAt = existing.createdAt;
      }
    }

    await this.appendLine(target);
    return target;
  }

  async markDispatched(id: string): Promise<void> {
    await this.transition(id, (s) => {
      s.status = 'dispatched';
      s.dispatchedAt = new Date().toISOString();
    });
  }

  async markDismissed(id: string): Promise<void> {
    await this.transition(id, (s) => {
      s.status = 'dismissed';
      s.dismissedAt = new Date().toISOString();
    });
  }

  async markActed(id: string): Promise<void> {
    await this.transition(id, (s) => {
      s.status = 'acted';
      s.actedAt = new Date().toISOString();
    });
  }

  /**
   * 取所有"未 dismiss / 未 acted / 未过期"的 suggestion，
   * 按 urgency desc + createdAt desc 排序。
   */
  async getActive(): Promise<CoachSuggestion[]> {
    const now = Date.now();
    const all = await this.list();
    const active = all.filter((s) => {
      if (s.status === 'dismissed' || s.status === 'acted') {
        return false;
      }
      if (s.expiresAt) {
        const t = Date.parse(s.expiresAt);
        if (!Number.isNaN(t) && t < now) {
          return false;
        }
      }
      return true;
    });

    active.sort((a, b) => {
      const u = urgencyRank(b.urgency) - urgencyRank(a.urgency);
      if (u !== 0) {
        return u;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

    return active;
  }

  /**
   * 清理：
   * - 已过期（expiresAt 早于 now）的条目
   * - dismissed 超过 7 天的条目
   * 物理重写整个 jsonl 文件，只保留有效条目最后状态。
   */
  async compact(): Promise<void> {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const all = await this.list();
    const kept = all.filter((s) => {
      if (s.expiresAt) {
        const t = Date.parse(s.expiresAt);
        if (!Number.isNaN(t) && t < now) {
          return false;
        }
      }
      if (s.status === 'dismissed' && s.dismissedAt) {
        const t = Date.parse(s.dismissedAt);
        if (!Number.isNaN(t) && t < sevenDaysAgo) {
          return false;
        }
      }
      return true;
    });

    const file = resolveSuggestionsPath(this.paths);
    await ensureDir(path.dirname(file));
    const body = kept.map((s) => JSON.stringify(s)).join('\n');
    await fs.writeFile(file, body ? body + '\n' : '', 'utf-8');
  }

  private async transition(
    id: string,
    mutate: (s: CoachSuggestion) => void,
  ): Promise<void> {
    const all = await this.list();
    const cur = all.find((x) => x.id === id);
    if (!cur) {
      return;
    }
    const next = { ...cur };
    mutate(next);
    await this.appendLine(next);
  }

  private async appendLine(s: CoachSuggestion): Promise<void> {
    const file = resolveSuggestionsPath(this.paths);
    await ensureDir(path.dirname(file));
    await fs.appendFile(file, JSON.stringify(s) + '\n', 'utf-8');
  }

  private async readAllLines(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  }

  private tryParse(line: string): CoachSuggestion | null {
    try {
      return JSON.parse(line) as CoachSuggestion;
    } catch {
      return null;
    }
  }
}
