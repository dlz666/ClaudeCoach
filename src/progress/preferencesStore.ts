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
  },
  language: {
    content: 'zh',
    exercises: 'zh',
    codeComments: 'zh',
  },
};

export class PreferencesStore {
  private readonly paths = getStoragePathResolver();

  async get(): Promise<LearningPreferences> {
    const current = await readJson<LearningPreferences>(this.paths.learningPreferencesPath);
    if (current) {
      return current;
    }

    const legacy = await readJson<LearningPreferences>(this.paths.legacyLearningPreferencesPath);
    if (legacy) {
      await writeJson(this.paths.learningPreferencesPath, legacy);
      return legacy;
    }

    return { ...DEFAULT_PREFERENCES };
  }

  async save(prefs: LearningPreferences): Promise<void> {
    await writeJson(this.paths.learningPreferencesPath, prefs);
  }
}
