import * as vscode from 'vscode';
import { Subject } from '../types';

/**
 * Coach 内部事件总线（发布/订阅）。
 *
 * 这一层只负责把"用户的学习行为 / 系统检测到的状态"广播给所有订阅者，
 * 不做任何业务判断。Loop 与 SessionLogger 都在这上面挂钩。
 */

export type CoachEventKind =
  | 'grade-submitted'
  | 'grade-batch-completed'
  | 'auto-diagnosis-ran'
  | 'lesson-opened'
  | 'webview-visibility-changed'
  | 'editor-typing'
  | 'idle-detected'
  | 'inline-edit-applied';

export interface CoachEvent {
  kind: CoachEventKind;
  /** ISO 时间戳，由 emit() 在调用方未填时自动补齐。 */
  at: string;
  subject?: Subject;
  topicId?: string;
  lessonId?: string;
  meta?: Record<string, unknown>;
}

export type CoachEventListener = (event: CoachEvent) => void | Promise<void>;

export class CoachEventBus {
  private readonly listeners = new Map<CoachEventKind, Set<CoachEventListener>>();
  private readonly anyListeners = new Set<CoachEventListener>();

  /** 订阅指定类型的事件。返回 Disposable 以便方便统一回收。 */
  on(kind: CoachEventKind, listener: CoachEventListener): vscode.Disposable {
    let bucket = this.listeners.get(kind);
    if (!bucket) {
      bucket = new Set<CoachEventListener>();
      this.listeners.set(kind, bucket);
    }
    bucket.add(listener);
    return new vscode.Disposable(() => {
      const cur = this.listeners.get(kind);
      if (!cur) {
        return;
      }
      cur.delete(listener);
      if (cur.size === 0) {
        this.listeners.delete(kind);
      }
    });
  }

  /** 订阅所有事件（用于活动流记录）。 */
  onAny(listener: CoachEventListener): vscode.Disposable {
    this.anyListeners.add(listener);
    return new vscode.Disposable(() => {
      this.anyListeners.delete(listener);
    });
  }

  /** 触发事件。所有 listener 错误都会被吞掉并打印 console，以免单点出错拖垮总线。 */
  emit(event: CoachEvent): void {
    const normalized: CoachEvent = {
      ...event,
      at: event.at || new Date().toISOString(),
    };

    const targeted = this.listeners.get(normalized.kind);
    if (targeted) {
      for (const fn of targeted) {
        this.dispatch(fn, normalized);
      }
    }

    for (const fn of this.anyListeners) {
      this.dispatch(fn, normalized);
    }
  }

  private dispatch(listener: CoachEventListener, event: CoachEvent): void {
    try {
      const ret = listener(event);
      if (ret && typeof (ret as Promise<void>).then === 'function') {
        (ret as Promise<void>).catch((err: unknown) => {
          console.error('[CoachEventBus] async listener error:', err);
        });
      }
    } catch (err) {
      console.error('[CoachEventBus] sync listener error:', err);
    }
  }
}
