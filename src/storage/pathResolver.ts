import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { Subject } from '../types';

const DEFAULT_WORKSPACE_STORAGE_ID = 'default-workspace';

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

export function getWorkspaceStorageId(): string {
  // Keep all workspace-scoped artifacts under the shared default workspace so
  // existing local courses and overrides remain visible across extension runs.
  return DEFAULT_WORKSPACE_STORAGE_ID;
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

  /** 单个资料的向量索引文件（per-material .vec.json）。 */
  materialVectorIndexPath(subject: Subject, materialId: string): string {
    return path.join(this.materialDir(subject, materialId), 'vector-index.json');
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

  courseProfilePath(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'profile.json');
  }

  /** Per-subject 错题本：未掌握题目集合，用于复习 + 出题注入。 */
  wrongQuestionsPath(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'wrong-questions.json');
  }

  /** Per-subject 自适应触发器状态：记录"距上次诊断的批改数"，用于阈值触发。 */
  adaptiveTriggerPath(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'adaptive-trigger.json');
  }

  /** Per-subject 间隔重复队列（SR）。 */
  spacedRepetitionQueuePath(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'sr-queue.json');
  }

  // ===== 备考模式路径 =====

  /** Per-subject 备考会话根目录。 */
  examPrepSubjectDir(subject: Subject): string {
    return path.join(this.courseSubjectDir(subject), 'exam-prep');
  }

  examSessionDir(subject: Subject, sessionId: string): string {
    return path.join(this.examPrepSubjectDir(subject), sessionId);
  }

  /** 单个备考会话的元数据（含 paperAnalyses / variantSets / submissions 引用）。 */
  examSessionMetaPath(subject: Subject, sessionId: string): string {
    return path.join(this.examSessionDir(subject, sessionId), 'session.json');
  }

  examSessionVariantSetPath(subject: Subject, sessionId: string, variantSetId: string): string {
    return path.join(this.examSessionDir(subject, sessionId), 'variants', `${variantSetId}.json`);
  }

  examSessionSubmissionDir(subject: Subject, sessionId: string, submissionId: string): string {
    return path.join(this.examSessionDir(subject, sessionId), 'submissions', submissionId);
  }

  examSessionSubmissionPath(subject: Subject, sessionId: string, submissionId: string): string {
    return path.join(this.examSessionSubmissionDir(subject, sessionId, submissionId), 'submission.json');
  }

  examSessionSubmissionImagePath(subject: Subject, sessionId: string, submissionId: string, fileName: string): string {
    return path.join(this.examSessionSubmissionDir(subject, sessionId, submissionId), fileName);
  }

  /** 全局备考会话索引（让 listExamSessions 不用扫所有 subject 目录）。 */
  get examSessionsIndexPath(): string {
    return path.join(this.appDir, 'exam-sessions-index.json');
  }

  /** Coach 全局目录：plans / sessions / suggestions / activity / brief cache。 */
  get coachDir(): string {
    return path.join(this.appDir, 'coach');
  }

  get coachPlansDir(): string {
    return path.join(this.coachDir, 'plans');
  }

  coachPlanPath(subject: Subject): string {
    return path.join(this.coachPlansDir, `${sanitizeSegment(subject, 'subject')}.json`);
  }

  get coachSessionsDir(): string {
    return path.join(this.coachDir, 'sessions');
  }

  coachSessionLogPath(dateKey: string): string {
    return path.join(this.coachSessionsDir, `${dateKey}.jsonl`);
  }

  get coachSuggestionsPath(): string {
    return path.join(this.coachDir, 'suggestions.jsonl');
  }

  get coachActivityDir(): string {
    return path.join(this.coachDir, 'activity');
  }

  coachActivityLogPath(dateKey: string): string {
    return path.join(this.coachActivityDir, `${dateKey}.jsonl`);
  }

  get coachDailyBriefCachePath(): string {
    return path.join(this.coachDir, 'daily-brief-cache.json');
  }

  /** Metacognition 答题记录（用户对追问的回答），按 subject 分文件 */
  coachMetacogPath(subject: Subject): string {
    return path.join(this.coachDir, 'metacog', `${sanitizeSegment(subject, 'subject')}.jsonl`);
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
    return path.join(this.courseExerciseSessionDir(subject, topicId, lessonId), '练习.md');
  }

  /** 旧文件名 prompt.md，用于一次性懒迁移到 `练习.md`。 */
  legacyCourseExercisePromptPath(subject: Subject, topicId: string, lessonId: string): string {
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
