import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Subject } from '../types';

function expandHome(inputPath: string): string {
  return inputPath.replace(/^~/, os.homedir());
}

function getConfiguredRoot(): string {
  const config = vscode.workspace.getConfiguration('claudeCoach');
  const custom = config.get<string>('dataDirectory', '').trim();
  if (!custom) {
    return path.join(os.homedir(), 'ClaudeCoach');
  }

  const expanded = expandHome(custom);
  return path.basename(expanded).toLowerCase() === 'courses'
    ? path.dirname(expanded)
    : expanded;
}

function getConfiguredLegacyRoot(): string {
  const config = vscode.workspace.getConfiguration('claudeCoach');
  const custom = config.get<string>('dataDirectory', '').trim();
  if (!custom) {
    return path.join(os.homedir(), 'ClaudeCoach', 'courses');
  }

  const expanded = expandHome(custom);
  return path.basename(expanded).toLowerCase() === 'courses'
    ? expanded
    : path.join(expanded, 'courses');
}

export function sanitizeSegment(value: string, fallback = 'item'): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function extractAsciiSlug(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (!value) {
      continue;
    }

    const slug = sanitizeSegment(
      value
        .replace(/\b(topic|lesson|chapter|section|unit)\b/gi, ' ')
        .replace(/\d+/g, ' ')
    , '');

    if (slug) {
      return slug;
    }
  }

  return '';
}

function formatTwoDigits(value: number): string {
  return String(Math.max(1, value)).padStart(2, '0');
}

export function buildTopicCode(chapterNumber: number, title: string, fallbackId?: string): string {
  const slug = extractAsciiSlug(title, fallbackId) || 'topic';
  return `${formatTwoDigits(chapterNumber)}-chapter-${slug}`;
}

export function buildLessonCode(
  chapterNumber: number,
  lessonNumber: number,
  title: string,
  fallbackId?: string
): string {
  const slug = extractAsciiSlug(title, fallbackId) || 'lesson';
  return `${formatTwoDigits(chapterNumber)}-${formatTwoDigits(lessonNumber)}-${slug}`;
}

function getWorkspaceFolderPath(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function getWorkspaceStorageId(): string {
  const folderPath = getWorkspaceFolderPath();
  if (!folderPath) {
    return 'default-workspace';
  }

  const folderName = sanitizeSegment(path.basename(folderPath), 'workspace');
  const hash = createHash('sha1').update(folderPath.toLowerCase()).digest('hex').slice(0, 8);
  return `${folderName}-${hash}`;
}

export class StoragePathResolver {
  readonly storageRoot = getConfiguredRoot();
  readonly legacyDataRoot = getConfiguredLegacyRoot();
  readonly workspaceId = getWorkspaceStorageId();

  get appDir(): string {
    return path.join(this.storageRoot, 'app');
  }

  get appAIProfilesPath(): string {
    return path.join(this.appDir, 'ai', 'profiles.json');
  }

  get legacyAIProfilesPath(): string {
    return path.join(this.legacyDataRoot, 'ai-profiles.json');
  }

  get userProfilePath(): string {
    return path.join(this.appDir, 'user', 'profile.json');
  }

  get legacyUserProfilePath(): string {
    return path.join(this.legacyDataRoot, 'profile.json');
  }

  get learningPreferencesPath(): string {
    return path.join(this.appDir, 'preferences', 'learning.json');
  }

  get legacyLearningPreferencesPath(): string {
    return path.join(this.legacyDataRoot, 'learning-preferences.json');
  }

  get diagnosticsDir(): string {
    return path.join(this.appDir, 'diagnostics');
  }

  get diagnosisLatestPath(): string {
    return path.join(this.diagnosticsDir, 'latest.json');
  }

  get diagnosisHistoryDir(): string {
    return path.join(this.diagnosticsDir, 'history');
  }

  get diagnosisReportPath(): string {
    return path.join(this.diagnosticsDir, 'diagnosis-report.md');
  }

  diagnosisSubjectDir(subject: Subject): string {
    return path.join(this.diagnosticsDir, sanitizeSegment(subject, 'course'));
  }

  diagnosisLatestPathForSubject(subject: Subject): string {
    return path.join(this.diagnosisSubjectDir(subject), 'latest.json');
  }

  diagnosisHistoryDirForSubject(subject: Subject): string {
    return path.join(this.diagnosisSubjectDir(subject), 'history');
  }

  diagnosisReportPathForSubject(subject: Subject): string {
    return path.join(
      this.diagnosisSubjectDir(subject),
      `${sanitizeSegment(subject, 'course')}-diagnosis-report.md`
    );
  }

  get legacyDiagnosisDir(): string {
    return path.join(this.legacyDataRoot, 'diagnosis');
  }

  get libraryDir(): string {
    return path.join(this.storageRoot, 'library');
  }

  get materialsDir(): string {
    return path.join(this.libraryDir, 'materials');
  }

  get materialsIndexPath(): string {
    return path.join(this.materialsDir, 'index.json');
  }

  get legacyMaterialsDir(): string {
    return path.join(this.legacyDataRoot, 'materials');
  }

  get legacyMaterialsIndexPath(): string {
    return path.join(this.legacyMaterialsDir, 'index.json');
  }

  materialSubjectDir(subject: Subject): string {
    return path.join(this.materialsDir, subject);
  }

  materialDir(subject: Subject, materialId: string): string {
    return path.join(this.materialSubjectDir(subject), materialId);
  }

  materialSourcePath(subject: Subject, materialId: string, fileName: string): string {
    return path.join(this.materialDir(subject, materialId), `source${path.extname(fileName)}`);
  }

  materialTextPath(subject: Subject, materialId: string): string {
    return path.join(this.materialDir(subject, materialId), 'extracted.txt');
  }

  materialSummaryPath(subject: Subject, materialId: string): string {
    return path.join(this.materialDir(subject, materialId), 'summary.json');
  }

  materialMetaPath(subject: Subject, materialId: string): string {
    return path.join(this.materialDir(subject, materialId), 'meta.json');
  }

  get workspaceRoot(): string {
    return path.join(this.storageRoot, 'workspaces', this.workspaceId);
  }

  get workspaceMetaPath(): string {
    return path.join(this.workspaceRoot, 'meta.json');
  }

  get workspaceAIDir(): string {
    return path.join(this.workspaceRoot, 'ai');
  }

  get workspaceAIOverridePath(): string {
    return path.join(this.workspaceAIDir, 'override.json');
  }

  get workspaceCoursesDir(): string {
    return path.join(this.workspaceRoot, 'courses');
  }

  courseSubjectDir(subject: Subject): string {
    return path.join(this.workspaceCoursesDir, subject);
  }

  courseOutlinePath(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'outline.json');
  }

  courseSummaryPath(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'summary.md');
  }

  courseTopicsDir(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'topics');
  }

  courseTopicDir(subject: Subject, topicId: string): string {
    return path.join(this.courseTopicsDir(subject), topicId);
  }

  courseTopicSummaryPath(subject: Subject, topicId: string): string {
    return path.join(this.courseTopicDir(subject, topicId), 'summary.json');
  }

  courseLessonsDir(subject: Subject, topicId: string): string {
    return path.join(this.courseTopicDir(subject, topicId), 'lessons');
  }

  courseLessonPath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.courseLessonsDir(subject, topicId), `${lessonId}.md`);
  }

  courseExercisesDir(subject: Subject, topicId: string): string {
    return path.join(this.courseTopicDir(subject, topicId), 'exercises');
  }

  courseExerciseSessionDir(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.courseExercisesDir(subject, topicId), lessonId);
  }

  courseExercisePromptPath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.courseExerciseSessionDir(subject, topicId, lessonId), 'prompt.md');
  }

  courseExerciseJsonPath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.courseExerciseSessionDir(subject, topicId, lessonId), 'prompt.json');
  }

  courseExerciseGradePath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.courseExerciseSessionDir(subject, topicId, lessonId), 'grade.json');
  }

  courseExerciseFeedbackPath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.courseExerciseSessionDir(subject, topicId, lessonId), 'feedback.md');
  }

  legacySubjectDir(subject: Subject): string {
    return path.join(this.legacyDataRoot, subject);
  }

  legacyCourseOutlinePath(subject: Subject): string {
    return path.join(this.legacySubjectDir(subject), 'course-outline.json');
  }

  legacyCourseSummaryPath(subject: Subject): string {
    return path.join(this.legacySubjectDir(subject), 'course-summary.md');
  }

  legacyTopicDir(subject: Subject, topicId: string): string {
    return path.join(this.legacySubjectDir(subject), topicId);
  }

  legacyTopicSummaryPath(subject: Subject, topicId: string): string {
    return path.join(this.legacyTopicDir(subject, topicId), 'topic-summary.json');
  }

  legacyLessonPath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.legacyTopicDir(subject, topicId), `${lessonId}.md`);
  }

  legacyExercisesDir(subject: Subject, topicId: string): string {
    return path.join(this.legacyTopicDir(subject, topicId), 'exercises');
  }

  legacyExercisePromptPath(subject: Subject, topicId: string, sessionId: string): string {
    return path.join(this.legacyExercisesDir(subject, topicId), `${sessionId}.md`);
  }

  legacyExerciseJsonPath(subject: Subject, topicId: string, sessionId: string): string {
    return path.join(this.legacyExercisesDir(subject, topicId), `${sessionId}.json`);
  }

  legacyExerciseGradePath(subject: Subject, topicId: string, sessionId: string): string {
    return path.join(this.legacyExercisesDir(subject, topicId), `${sessionId}-grade.json`);
  }

  legacyExerciseFeedbackPath(subject: Subject, topicId: string, sessionId: string): string {
    return path.join(this.legacyExercisesDir(subject, topicId), `${sessionId}-grade-feedback.md`);
  }
}

export function getStoragePathResolver(): StoragePathResolver {
  return new StoragePathResolver();
}
