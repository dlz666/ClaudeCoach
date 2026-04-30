import { LearningPreferences } from '../types';
import { readJson, writeJson } from '../utils/fileSystem';
import { getStoragePathResolver } from '../storage/pathResolver';

const DEFAULT_PREFERENCES: LearningPreferences = {
  difficulty: {
    global: 'basic',
    perSubject: {},
    exerciseMix: { easy: 30, medium: 50, hard: 20 },
  },
  pace: {
    dailyGoalMinutes: 60,
    exercisesPerSession: 5,
    speed: 'medium',
    reviewEveryNLessons: 3,
    restDays: [],
    studyTimeSlots: ['morning', 'afternoon', 'evening'],
  },
  language: {
    content: 'zh',
    exercises: 'zh',
    codeComments: 'zh',
  },
  aiStyle: {
    lessonDetail: 'standard',
    feedbackTone: 'encouraging',
    explanationStyles: ['example-first', 'intuition-first'],
    mathSymbol: 'english-standard',
    exerciseTypeMix: { multipleChoice: 30, freeResponse: 50, code: 20 },
    includeProofs: true,
    includeHistory: false,
  },
  retrieval: {
    defaultGrounding: true,
    strictness: 'inclusive',
    citeSources: true,
    maxExcerpts: 4,
    embedding: {
      // 默认关闭，需要用户在设置页主动启用 + 填 baseUrl/token；首次启用时弹一次性
      // 索引构建提示
      enabled: false,
      // 默认建议值：硅基流动免费 bge-m3
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiToken: '',
      model: 'BAAI/bge-m3',
      dimension: 1024,
      hybridWeight: 0.5,
    },
    // Vision API：用云端多模态 LLM 把 PDF 直接转 markdown（含 LaTeX 公式）
    // 实测 Qwen3-VL-8B 31s/页 + 5 并发 ≈ 6s/页等效，质量胜 marker
    vision: {
      enabled: false,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiToken: '',
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      concurrency: 5,
      dpi: 200,
      maxTokens: 6000,
    },
  },
  ui: {
    fontSize: 14,
    defaultTab: 'learn',
    expandCourseTree: true,
    showEmoji: true,
    theme: 'auto',
  },
  coach: {
    active: true,
    loops: {
      dailyBrief: true,
      idle: true,
      sr: true,
      metacog: true,
      drift: true,
    },
    notifications: {
      toastLevel: 'high-urgency-only',
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
    },
    throttle: {
      maxToastsPerHour: 1,
      maxBannersPerHour: 4,
    },
    doNotDisturbUntil: null,
    idleThresholdMinutes: 8,
    sr: {
      variantStrategy: 'ai-variant',
    },
    dailyBrief: {
      cacheStrategy: 'per-day',
    },
    lecture: {
      viewerMode: 'lecture-webview',
      applyMode: 'preview-confirm',
      syncSourceEditor: false,
      highlightChangesMs: 5000,
    },
  },
};

/** 深合并：用户保存的 prefs 缺字段时用默认值补齐。 */
function mergePreferences(stored: Partial<LearningPreferences> | null | undefined): LearningPreferences {
  if (!stored) {
    return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)) as LearningPreferences;
  }
  return {
    difficulty: {
      global: stored.difficulty?.global ?? DEFAULT_PREFERENCES.difficulty.global,
      perSubject: stored.difficulty?.perSubject ?? DEFAULT_PREFERENCES.difficulty.perSubject,
      exerciseMix: stored.difficulty?.exerciseMix ?? DEFAULT_PREFERENCES.difficulty.exerciseMix,
    },
    pace: {
      ...DEFAULT_PREFERENCES.pace,
      ...(stored.pace ?? {}),
    },
    language: {
      ...DEFAULT_PREFERENCES.language,
      ...(stored.language ?? {}),
    },
    aiStyle: {
      ...DEFAULT_PREFERENCES.aiStyle!,
      ...(stored.aiStyle ?? {}),
      exerciseTypeMix: {
        ...DEFAULT_PREFERENCES.aiStyle!.exerciseTypeMix!,
        ...(stored.aiStyle?.exerciseTypeMix ?? {}),
      },
    },
    retrieval: {
      ...DEFAULT_PREFERENCES.retrieval!,
      ...(stored.retrieval ?? {}),
      embedding: {
        ...DEFAULT_PREFERENCES.retrieval!.embedding!,
        ...(stored.retrieval?.embedding ?? {}),
      },
      vision: {
        ...DEFAULT_PREFERENCES.retrieval!.vision!,
        ...(stored.retrieval?.vision ?? {}),
      },
    },
    ui: {
      ...DEFAULT_PREFERENCES.ui!,
      ...(stored.ui ?? {}),
    },
    coach: {
      ...DEFAULT_PREFERENCES.coach!,
      ...(stored.coach ?? {}),
      loops: {
        ...DEFAULT_PREFERENCES.coach!.loops!,
        ...(stored.coach?.loops ?? {}),
      },
      notifications: {
        ...DEFAULT_PREFERENCES.coach!.notifications!,
        ...(stored.coach?.notifications ?? {}),
      },
      throttle: {
        ...DEFAULT_PREFERENCES.coach!.throttle!,
        ...(stored.coach?.throttle ?? {}),
      },
      sr: {
        ...DEFAULT_PREFERENCES.coach!.sr!,
        ...(stored.coach?.sr ?? {}),
      },
      dailyBrief: {
        ...DEFAULT_PREFERENCES.coach!.dailyBrief!,
        ...(stored.coach?.dailyBrief ?? {}),
      },
      lecture: {
        ...DEFAULT_PREFERENCES.coach!.lecture!,
        ...(stored.coach?.lecture ?? {}),
      },
    },
  };
}

export class PreferencesStore {
  private readonly paths = getStoragePathResolver();

  async get(): Promise<LearningPreferences> {
    const current = await readJson<Partial<LearningPreferences>>(this.paths.learningPreferencesPath);
    if (current) {
      return mergePreferences(current);
    }

    const legacy = await readJson<Partial<LearningPreferences>>(this.paths.legacyLearningPreferencesPath);
    if (legacy) {
      const merged = mergePreferences(legacy);
      await writeJson(this.paths.learningPreferencesPath, merged);
      return merged;
    }

    return mergePreferences(null);
  }

  async save(prefs: LearningPreferences): Promise<void> {
    const normalized = mergePreferences(prefs);
    await writeJson(this.paths.learningPreferencesPath, normalized);
  }

  /** 单独恢复某个分组的默认值。 */
  async resetGroup(group: keyof LearningPreferences): Promise<LearningPreferences> {
    const current = await this.get();
    const next = JSON.parse(JSON.stringify(current)) as LearningPreferences;
    (next as any)[group] = JSON.parse(JSON.stringify((DEFAULT_PREFERENCES as any)[group]));
    await this.save(next);
    return next;
  }

  async resetAll(): Promise<LearningPreferences> {
    const fresh = mergePreferences(null);
    await this.save(fresh);
    return fresh;
  }

  async exportRaw(): Promise<LearningPreferences> {
    return this.get();
  }

  async importRaw(input: unknown): Promise<LearningPreferences> {
    if (!input || typeof input !== 'object') {
      throw new Error('导入的偏好数据不是对象。');
    }
    const merged = mergePreferences(input as Partial<LearningPreferences>);
    await this.save(merged);
    return merged;
  }
}
