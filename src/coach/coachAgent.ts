import * as vscode from 'vscode';
import { LearningPreferences, SidebarResponse } from '../types';
import { PreferencesStore } from '../progress/preferencesStore';
import { CourseManager } from '../courses/courseManager';
import { CourseProfileStore } from '../progress/courseProfileStore';
import { AdaptiveEngine } from '../progress/adaptiveEngine';
import { AIClient } from '../ai/client';
import { CoachEvent, CoachEventBus } from './coachEventBus';
import { CoachStateStore } from './coachState';
import { CoachSuggestion, SuggestionStore } from './suggestionStore';
import { SessionLogger } from './sessionLogger';
import { LearningPlanStore } from './learningPlanStore';

/**
 * CoachAgent：Active Coach 的中央协调器。
 *
 * 职责（Phase 2A）：
 * - 启动 5 分钟主 tick，把所有 Loop 的 tick() 调一遍
 * - 桥接 EventBus 上的事件到 Loop.onEvent + SessionLogger
 * - 提供节流通道（toast / banner）给 Loop 用
 * - 收口 pushSuggestion：写 SuggestionStore + 推 sidebar
 *
 * 不实现具体 Loop。Loop 的实现（DailyBrief/Idle/SR/Metacog/Drift）在 Phase 3。
 */

export type CoachLoopName = 'dailyBrief' | 'idle' | 'sr' | 'metacog' | 'drift';

export interface CoachLoop {
  name: CoachLoopName | string;
  /** 主 tick 周期回调。可选。 */
  tick?: () => Promise<void>;
  /** 事件回调。可选。 */
  onEvent?: (event: CoachEvent) => Promise<void>;
}

export interface CoachAgentDeps {
  bus: CoachEventBus;
  prefs: PreferencesStore;
  state: CoachStateStore;
  suggestions: SuggestionStore;
  sessions: SessionLogger;
  plans: LearningPlanStore;
  courseManager: CourseManager;
  courseProfileStore: CourseProfileStore;
  adaptiveEngine: AdaptiveEngine;
  ai: AIClient;
  /** 把消息推回 sidebar webview。SidebarProvider 注入。 */
  postToSidebar: (msg: SidebarResponse) => void;
  /** 显示 vscode toast。 */
  showToast: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const TICK_INTERVAL_MS = 5 * 60 * 1000;

interface ChannelCounter {
  count: number;
  hourStart: number;
}

interface ThrottleConfig {
  maxToastPerHour: number;
  maxBannerPerHour: number;
}

interface CoachPrefShape {
  active?: boolean;
  loops?: Partial<Record<CoachLoopName, boolean>>;
  throttle?: Partial<ThrottleConfig>;
}

const DEFAULT_THROTTLE: ThrottleConfig = {
  maxToastPerHour: 3,
  maxBannerPerHour: 6,
};

const DEFAULT_LOOP_FLAGS: Record<CoachLoopName, boolean> = {
  dailyBrief: true,
  idle: true,
  sr: true,
  metacog: true,
  drift: true,
};

export class CoachAgent implements vscode.Disposable {
  private readonly loops: CoachLoop[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private started = false;

  private readonly counters: Record<'toast' | 'banner', ChannelCounter> = {
    toast: { count: 0, hourStart: Date.now() },
    banner: { count: 0, hourStart: Date.now() },
  };

  constructor(private readonly deps: CoachAgentDeps) {}

  /** 启动：订阅 bus + 启动主 tick。重复调用是 no-op。 */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // 1) 把所有事件喂给 SessionLogger（活动流）
    this.disposables.push(
      this.deps.bus.onAny((event) => {
        try {
          this.deps.sessions.recordActivity({
            kind: event.kind,
            subject: event.subject,
            topicId: event.topicId,
            lessonId: event.lessonId,
            meta: event.meta,
          });
        } catch (err) {
          console.error('[CoachAgent] sessionLogger.recordActivity error:', err);
        }
      }),
    );

    // 2) 把所有事件转发给所有 loop（onEvent 是可选的）。
    //    Phase 3 的多个 Loop 关心不同事件（grade-submitted / webview-visibility-changed / editor-typing / lesson-opened ...），
    //    所以这里直接订阅 onAny。SessionLogger 已经独立通过自己的 onAny 订阅，不会冲突。
    this.disposables.push(
      this.deps.bus.onAny(async (event) => {
        await this.fanOutEvent(event);
      }),
    );

    // 3) 启动 5min 主 tick
    this.tickTimer = setInterval(() => {
      this.runTick().catch((err) => {
        console.error('[CoachAgent] tick error:', err);
      });
    }, TICK_INTERVAL_MS);
    if (typeof this.tickTimer.unref === 'function') {
      this.tickTimer.unref();
    }

    // 4) 自动注册 Phase 3 的 5 个 Loop。延迟 require 避开循环依赖。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { registerAllLoops } = require('./loops/index') as typeof import('./loops/index');
      registerAllLoops(this);
    } catch (err) {
      console.error('[CoachAgent] registerAllLoops error:', err);
    }

    // 启动日志在 dev 时仍有用，但 prod 不该泄露到 user-facing console
  }

  /** Loop 在 Phase 3 通过这个 hook 注册自己。Phase 2A 留空可用。 */
  registerLoop(loop: CoachLoop): void {
    this.loops.push(loop);
  }

  /**
   * 节流：返回 false 时调用方应静默。
   * 同时检查 DND（do not disturb）和当小时计数。
   * 调用并 OK 后会自增计数（"准入"语义）。
   */
  canEmit(channel: 'toast' | 'banner'): boolean {
    // Note: 这是同步 API，所以 DND 用 cache 的 state（CoachStateStore.get 内部有 cache）。
    // 但 cache 第一次读需异步，因此第一次启动后 first canEmit 可能 race。
    // 为简单起见，DND 用同步快照：调用方应在 start() 后才用 canEmit。
    if (this.isDoNotDisturbActive()) {
      return false;
    }

    const cfg = this.getThrottleConfig();
    const now = Date.now();
    const counter = this.counters[channel];
    if (now - counter.hourStart >= 60 * 60 * 1000) {
      counter.hourStart = now;
      counter.count = 0;
    }

    const cap = channel === 'toast' ? cfg.maxToastPerHour : cfg.maxBannerPerHour;
    if (counter.count >= cap) {
      return false;
    }

    counter.count += 1;
    return true;
  }

  /**
   * 发布一条 suggestion：
   * - 一律调 SuggestionStore.upsert（持久化）
   * - 当 channel 是 toast/banner 时走节流；inline 直接放过
   * - 节流通过则同时 markDispatched 并推送到 sidebar
   */
  async pushSuggestion(
    s: Omit<CoachSuggestion, 'id' | 'createdAt' | 'dispatchedAt' | 'dismissedAt' | 'actedAt'>,
  ): Promise<void> {
    const draft: CoachSuggestion = {
      ...s,
      id: '',
      createdAt: '',
    };

    const persisted = await this.deps.suggestions.upsert(draft);

    let canDispatch = true;
    if (s.channel === 'toast' || s.channel === 'banner') {
      canDispatch = this.canEmit(s.channel);
    }

    if (!canDispatch) {
      // 仅持久化，不推送
      return;
    }

    try {
      await this.deps.suggestions.markDispatched(persisted.id);
    } catch (err) {
      console.error('[CoachAgent] markDispatched error:', err);
    }

    try {
      this.deps.postToSidebar({
        type: 'coachSuggestions' as SidebarResponse['type'],
        // 用类型断言绕开 SidebarResponse 的 closed union（Phase 2A 阶段，
        // SidebarProvider 在自己的整合 PR 里会扩展 SidebarResponse 把 'coachSuggestions' 加进去）。
        data: [persisted],
      } as unknown as SidebarResponse);
    } catch (err) {
      console.error('[CoachAgent] postToSidebar error:', err);
    }
  }

  /** Loop 是否启用：受 prefs.coach.active 总开关 + 单独 loop flag 控制。 */
  async isLoopEnabled(loopName: CoachLoopName): Promise<boolean> {
    const prefs = await this.deps.prefs.get();
    const coach = this.readCoachPref(prefs);
    if (coach.active === false) {
      return false;
    }
    const flag = coach.loops?.[loopName];
    if (typeof flag === 'boolean') {
      return flag;
    }
    return DEFAULT_LOOP_FLAGS[loopName];
  }

  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    this.disposables.length = 0;
    this.started = false;
  }

  private async runTick(): Promise<void> {
    for (const loop of this.loops) {
      if (!loop.tick) {
        continue;
      }
      try {
        await loop.tick();
      } catch (err) {
        console.error('[CoachAgent] loop %s tick error:', loop.name, err);
      }
    }
  }

  private async fanOutEvent(event: CoachEvent): Promise<void> {
    for (const loop of this.loops) {
      if (!loop.onEvent) {
        continue;
      }
      try {
        await loop.onEvent(event);
      } catch (err) {
        console.error('[CoachAgent] loop %s onEvent error:', loop.name, err);
      }
    }
  }

  private isDoNotDisturbActive(): boolean {
    // 用 fire-and-forget 拿最新 state，但同步检查依赖 cache。
    // CoachStateStore.get 第一次会读盘；为简化此处只用一次缓存值。
    // 这里宽容地返回 false（unknown 视为未勿扰）；调用 setDoNotDisturb 时 cache 会更新。
    // 注：CoachStateStore 内部有 cache，所以只要 state 在 start 之后被读过一次，就准确。
    // (start 不强制读 state，但 sidebar 一般会先 get 一次)
    let until: string | null = null;
    try {
      // 通过 unsound 的 typed access 直接拿到内部 cache
      const cache = (this.deps.state as unknown as { cache: { doNotDisturbUntil: string | null } | null }).cache;
      until = cache?.doNotDisturbUntil ?? null;
    } catch {
      until = null;
    }
    if (!until) {
      return false;
    }
    const t = Date.parse(until);
    if (Number.isNaN(t)) {
      return false;
    }
    return t > Date.now();
  }

  private getThrottleConfig(): ThrottleConfig {
    // 这个调用本来是同步，所以拿 prefs 也要小心。
    // 简化：维护一份"上次拿到的 prefs"快照，初始用默认。
    // 实际在生产里可以 prime 一次，再在 prefs 改动时刷新。
    // Phase 2A：先固定用默认值，后续可在 SidebarProvider 整合时往这边塞。
    return DEFAULT_THROTTLE;
  }

  private readCoachPref(prefs: LearningPreferences): CoachPrefShape {
    const anyPrefs = prefs as unknown as { coach?: CoachPrefShape };
    return anyPrefs.coach ?? {};
  }
}
