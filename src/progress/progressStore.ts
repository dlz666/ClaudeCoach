import { StudentProfile, Subject } from '../types';
import { readJson, writeJson } from '../utils/fileSystem';
import { getStoragePathResolver } from '../storage/pathResolver';

const DEFAULT_PROFILE: StudentProfile = {
  name: '同学',
  level: 'beginner',
  subjects: ['calculus', 'linear-algebra', 'discrete-math', 'react'],
  goals: ['打好数学基础', '掌握前端开发'],
  startDate: new Date().toISOString(),
  totalSessions: 0,
  totalExercises: 0,
};

export class ProgressStore {
  private readonly paths = getStoragePathResolver();

  async getProfile(): Promise<StudentProfile> {
    const current = await readJson<StudentProfile>(this.paths.userProfilePath);
    if (current) {
      return current;
    }

    const legacy = await readJson<StudentProfile>(this.paths.legacyUserProfilePath);
    if (legacy) {
      await writeJson(this.paths.userProfilePath, legacy);
      return legacy;
    }

    return { ...DEFAULT_PROFILE };
  }

  async saveProfile(profile: StudentProfile): Promise<void> {
    await writeJson(this.paths.userProfilePath, profile);
  }

  async incrementSession(): Promise<void> {
    const profile = await this.getProfile();
    profile.totalSessions++;
    await this.saveProfile(profile);
  }

  async incrementExercises(count: number): Promise<void> {
    const profile = await this.getProfile();
    profile.totalExercises += count;
    await this.saveProfile(profile);
  }
}
