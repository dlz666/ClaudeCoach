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

/**
 * 判断一个 slug 是否是"塌缩占位符"——AI 生成大纲时若 topic/lesson 标题是纯中文，
 * slug 会退成字面 `topic` / `lesson` / `section` / `unit` / `chapter`，导致同一门课
 * 所有章/节目录名长得一样（如 01-chapter-topic / 02-chapter-topic …）。
 * 这些词本身不带任何语义信息，应当视为"没拿到真 slug"，强制走唯一化 fallback。
 */
export function isCollapsedPlaceholderSlug(slug: string | undefined | null): boolean {
  if (!slug) return true;
  const s = String(slug).trim().toLowerCase();
  // 纯占位词（topic/lesson/chapter/section/unit）或纯数字（如 "1", "01"）或空
  return /^(topic|lesson|chapter|section|unit|item|\d+|)$/.test(s);
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

    // 拒收塌缩占位符：sanitizeSegment 兜底成 'item' 的，或剥离后只剩占位词的，
    // 都不算"真 slug"，让调用方走唯一化 fallback。
    if (slug && !isCollapsedPlaceholderSlug(slug)) {
      return slug;
    }
  }

  return '';
}

function formatTwoDigits(value: number): string {
  return String(Math.max(1, value)).padStart(2, '0');
}

export function buildTopicCode(chapterNumber: number, title: string, fallbackId?: string): string {
  const slug = extractAsciiSlug(title, fallbackId) || `topic-${formatTwoDigits(chapterNumber)}`;
  return `${formatTwoDigits(chapterNumber)}-chapter-${slug}`;
}

export function buildLessonCode(
  chapterNumber: number,
  lessonNumber: number,
  title: string,
  fallbackId?: string
): string {
  const slug = extractAsciiSlug(title, fallbackId) || `lesson-${formatTwoDigits(chapterNumber)}-${formatTwoDigits(lessonNumber)}`;
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

  /**
   * Marker 输出的 markdown（含 LaTeX 公式 / 章节 ## / 表格 / 代码块）。
   * 与 .txt 互斥优先级：读取时 .md 优先；只有 marker 走过的资料才会有 .md。
   */
  materialMarkdownPath(subject: Subject, materialId: string): string {
    return path.join(this.materialDir(subject, materialId), 'extracted.md');
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

  // ===== Projects (TDD-style learning) =====
  // 布局：~/ClaudeCoach/workspaces/<wsId>/projects/<subject>/<projectId>/
  //         ├─ .coach-meta.json      （ProjectMeta：状态、createdAt、testCommand 等）
  //         ├─ .coach-spec.json      （ProjectSpec：AI 生成的完整规约，含 files / todos）
  //         ├─ README.md             （AI 写的 user-facing README）
  //         ├─ TODO.md               （AI 写的 user-facing TODO 列表）
  //         └─ <project 自己的文件>  （boilerplate / test 骨架 / user-stub 实现文件）
  // 全局索引：~/ClaudeCoach/app/projects-index.json（让 listProjects 不用扫所有 subject）

  get workspaceProjectsDir(): string {
    return path.join(this.workspaceRoot, 'projects');
  }

  projectSubjectDir(subject: string): string {
    return path.join(this.workspaceProjectsDir, sanitizeSegment(subject, 'subject'));
  }

  projectDir(subject: string, projectId: string): string {
    return path.join(this.projectSubjectDir(subject), projectId);
  }

  projectMetaPath(subject: string, projectId: string): string {
    return path.join(this.projectDir(subject, projectId), '.coach-meta.json');
  }

  projectSpecPath(subject: string, projectId: string): string {
    return path.join(this.projectDir(subject, projectId), '.coach-spec.json');
  }

  /** 全局 project 索引：projectId → {subject, dir} 映射，避免扫盘。 */
  get projectsIndexPath(): string {
    return path.join(this.appDir, 'projects-index.json');
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
