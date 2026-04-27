import * as path from 'path';
import * as vscode from 'vscode';
import { LearningPreferences } from '../../types';
import { PreferencesStore } from '../../progress/preferencesStore';
import { CoachAgent, CoachLoop } from '../coachAgent';
import { CoachEvent } from '../coachEventBus';

/**
 * Loop 2: IdleCoach
 *
 * - 监听 'editor-typing' 事件维护每个文件的 lastTypingAt
 * - tick（5min）查 vscode.window.activeTextEditor，是讲义/练习路径且 idle 超过阈值
 *   → 推一条 idle-nudge banner suggestion（同文件每天最多 1 次）
 */

export interface IdleCoachDeps {
  agent: CoachAgent;
  prefs: PreferencesStore;
}

interface CoachPrefShape {
  idleThresholdMinutes?: number;
}

const DEFAULT_IDLE_THRESHOLD_MIN = 8;

function readIdleThresholdMin(prefs: LearningPreferences): number {
  const coach = (prefs as unknown as { coach?: CoachPrefShape }).coach ?? {};
  const v = coach.idleThresholdMinutes;
  if (typeof v === 'number' && v > 0) {
    return v;
  }
  return DEFAULT_IDLE_THRESHOLD_MIN;
}

function isCoachInterestingPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  if (norm.endsWith('.md')) {
    // 讲义：包含 lessons/ 或 topics/ 段
    if (norm.includes('/lessons/') || norm.includes('/topics/') || norm.includes('/exercises/')) {
      return true;
    }
  }
  if (norm.includes('/exercises/')) {
    return true;
  }
  return false;
}

function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createIdleCoachLoop(deps: IdleCoachDeps): CoachLoop {
  const lastTypingAt = new Map<string, number>();
  const dispatchedToday = new Set<string>(); // dedupKey set

  return {
    name: 'idle',
    async onEvent(event: CoachEvent): Promise<void> {
      if (event.kind !== 'editor-typing') {
        return;
      }
      const meta = (event.meta ?? {}) as { filePath?: string };
      if (!meta.filePath) {
        return;
      }
      lastTypingAt.set(meta.filePath, Date.now());
    },
    async tick(): Promise<void> {
      try {
        const enabled = await deps.agent.isLoopEnabled('idle');
        if (!enabled) {
          return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const filePath = editor.document.uri.fsPath;
        if (!filePath || !isCoachInterestingPath(filePath)) {
          return;
        }
        const prefs = await deps.prefs.get();
        const thresholdMin = readIdleThresholdMin(prefs);
        const last = lastTypingAt.get(filePath);
        const referenceTime = last ?? Date.now();
        if (!last) {
          // 首次见这个文件就 record now，避免立即触发
          lastTypingAt.set(filePath, referenceTime);
          return;
        }
        const idleMs = Date.now() - referenceTime;
        if (idleMs < thresholdMin * 60 * 1000) {
          return;
        }

        const dateKey = todayKey();
        const dedupKey = `idle-${filePath}-${dateKey}`;
        if (dispatchedToday.has(dedupKey)) {
          return;
        }

        const fileName = path.basename(filePath);
        await deps.agent.pushSuggestion({
          dedupKey,
          source: 'idleCoach',
          channel: 'banner',
          urgency: 'low',
          status: 'preview',
          title: `卡在「${fileName}」上有一会儿了`,
          body: '需要我提示思路或换一道相关题吗？',
          payload: { filePath, idleMinutes: Math.round(idleMs / 60000) },
        } as unknown as Parameters<CoachAgent['pushSuggestion']>[0]);

        dispatchedToday.add(dedupKey);
        // 推完后重置 last，避免下一个 tick 立即重复（dedupKey 已经挡住了，但时间也清掉更稳）
        lastTypingAt.set(filePath, Date.now());
      } catch (err) {
        console.error('[IdleCoachLoop] tick error:', err);
      }
    },
  };
}
