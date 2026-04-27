import { CoachAgent } from '../coachAgent';
import { DailyBriefCache } from '../dailyBriefCache';
import { SpacedRepetitionStore } from '../spacedRepetitionStore';
import { getStoragePathResolver } from '../../storage/pathResolver';
import { createDailyBriefLoop } from './dailyBrief';
import { createIdleCoachLoop } from './idleCoach';
import { createSpacedRepetitionLoop } from './spacedRepetition';
import { createMetacognitionLoop } from './metacognition';
import { createDriftDetectionLoop } from './driftDetection';

/**
 * 注册所有 5 个 Loop 到给定的 CoachAgent。
 *
 * 复用 agent.deps（通过受控的 internal accessor），避免重新构造 store。
 * 资源（cache / SR store）每个 process 共用一份。
 */

interface CoachAgentInternals {
  deps: {
    bus: import('../coachEventBus').CoachEventBus;
    prefs: import('../../progress/preferencesStore').PreferencesStore;
    state: import('../coachState').CoachStateStore;
    suggestions: import('../suggestionStore').SuggestionStore;
    sessions: import('../sessionLogger').SessionLogger;
    plans: import('../learningPlanStore').LearningPlanStore;
    courseManager: import('../../courses/courseManager').CourseManager;
    courseProfileStore: import('../../progress/courseProfileStore').CourseProfileStore;
    adaptiveEngine: import('../../progress/adaptiveEngine').AdaptiveEngine;
    ai: import('../../ai/client').AIClient;
    postToSidebar: (msg: import('../../types').SidebarResponse) => void;
    showToast: (level: 'info' | 'warn' | 'error', message: string) => void;
  };
}

export function registerAllLoops(agent: CoachAgent): void {
  // 通过 unsound typed access 拿到 deps（避免改 CoachAgent 公开 API）
  const deps = (agent as unknown as CoachAgentInternals).deps;
  if (!deps) {
    console.error('[registerAllLoops] CoachAgent has no deps; skipped');
    return;
  }

  const paths = getStoragePathResolver();
  const sr = new SpacedRepetitionStore(paths);
  const briefCache = new DailyBriefCache(paths);

  const postBriefToSidebar = (entry: import('../../types').DailyBriefEntry): void => {
    try {
      deps.postToSidebar({ type: 'dailyBrief', data: entry });
    } catch (err) {
      console.error('[registerAllLoops] postToSidebar dailyBrief error:', err);
    }
  };

  const dailyBrief = createDailyBriefLoop({
    agent,
    bus: deps.bus,
    prefs: deps.prefs,
    state: deps.state,
    plans: deps.plans,
    sessions: deps.sessions,
    courseManager: deps.courseManager,
    courseProfileStore: deps.courseProfileStore,
    ai: deps.ai,
    sr,
    cache: briefCache,
    postToSidebar: postBriefToSidebar,
  });

  const idleCoach = createIdleCoachLoop({
    agent,
    prefs: deps.prefs,
  });

  const spacedRepetition = createSpacedRepetitionLoop({
    agent,
    state: deps.state,
    courseManager: deps.courseManager,
    sr,
  });

  const metacognition = createMetacognitionLoop({ agent });

  const drift = createDriftDetectionLoop({
    agent,
    state: deps.state,
    plans: deps.plans,
  });

  for (const loop of [dailyBrief, idleCoach, spacedRepetition, metacognition, drift]) {
    try {
      agent.registerLoop(loop);
    } catch (err) {
      console.error('[registerAllLoops] registerLoop %s error:', loop.name, err);
    }
  }
}
