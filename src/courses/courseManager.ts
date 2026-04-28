import * as fs from 'fs/promises';
import * as path from 'path';
import { CourseOutline, LessonMeta, Subject, TopicOutline, TopicSummary, WrongQuestion, WrongQuestionBook } from '../types';
import { readJson, writeJson, ensureDir, fileExists } from '../utils/fileSystem';
import { StoragePathResolver, buildLessonCode, buildTopicCode, getStoragePathResolver } from '../storage/pathResolver';

export class CourseManager {
  private readonly paths: StoragePathResolver;
  private static readonly TOPIC_CODE_PATTERN = /^\d{2}-chapter-[a-z0-9-]+$/;
  private static readonly LESSON_CODE_PATTERN = /^\d{2}-\d{2}-[a-z0-9-]+$/;

  constructor() {
    this.paths = getStoragePathResolver();
  }

  private async listDirectoryNames(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      return [];
    }
  }

  private resolveTopicCode(topic: TopicOutline, chapterNumber: number): string {
    const candidate = String(topic.code ?? topic.id ?? '').trim().toLowerCase();
    if (CourseManager.TOPIC_CODE_PATTERN.test(candidate)) {
      return candidate;
    }

    return buildTopicCode(chapterNumber, topic.title, topic.code ?? topic.id);
  }

  private resolveLessonCode(lesson: LessonMeta, chapterNumber: number, lessonNumber: number): string {
    const candidate = String(lesson.code ?? lesson.id ?? '').trim().toLowerCase();
    if (CourseManager.LESSON_CODE_PATTERN.test(candidate)) {
      return candidate;
    }

    return buildLessonCode(chapterNumber, lessonNumber, lesson.title, lesson.code ?? lesson.id);
  }

  private normalizeLesson(subject: Subject, topicCode: string, topicIndex: number, lesson: LessonMeta, lessonIndex: number): LessonMeta {
    const chapterNumber = topicIndex + 1;
    const lessonNumber = lessonIndex + 1;
    const lessonCode = this.resolveLessonCode(lesson, chapterNumber, lessonNumber);

    return {
      ...lesson,
      id: lessonCode,
      code: lessonCode,
      chapterNumber,
      lessonNumber,
      slug: lessonCode.split('-').slice(2).join('-'),
      difficulty: Number.isFinite(lesson.difficulty) ? Number(lesson.difficulty) : 1,
      status: lesson.status ?? 'not-started',
      filePath: this.getLessonPath(subject, topicCode, lessonCode),
    };
  }

  private normalizeTopic(subject: Subject, topic: TopicOutline, topicIndex: number): TopicOutline {
    const chapterNumber = topicIndex + 1;
    const topicCode = this.resolveTopicCode(topic, chapterNumber);

    return {
      ...topic,
      id: topicCode,
      code: topicCode,
      chapterNumber,
      slug: topicCode.split('-').slice(2).join('-'),
      lessons: (topic.lessons ?? []).map((lesson, lessonIndex) =>
        this.normalizeLesson(subject, topicCode, topicIndex, lesson, lessonIndex)
      ),
    };
  }

  normalizeOutline(subject: Subject, outline: CourseOutline): CourseOutline {
    const createdAt = outline.createdAt || new Date().toISOString();
    return {
      ...outline,
      subject,
      createdAt,
      topics: (outline.topics ?? []).map((topic, topicIndex) => this.normalizeTopic(subject, topic, topicIndex)),
    };
  }

  async saveCourseOutline(subject: Subject, outline: CourseOutline): Promise<string> {
    const normalized = this.normalizeOutline(subject, outline);
    const outlinePath = this.paths.courseOutlinePath(subject);

    await ensureDir(this.paths.courseSubjectDir(subject));
    await ensureDir(this.paths.courseTopicsDir(subject));
    await writeJson(outlinePath, normalized);

    for (const topic of normalized.topics) {
      await ensureDir(this.paths.courseTopicDir(subject, topic.id));
      await ensureDir(this.paths.courseLessonsDir(subject, topic.id));
      await ensureDir(this.paths.courseExercisesDir(subject, topic.id));
    }

    return outlinePath;
  }

  async clearCourseContent(subject: Subject): Promise<void> {
    await fs.rm(this.paths.courseSubjectDir(subject), { recursive: true, force: true });
  }

  async applyFullRebuild(subject: Subject, nextOutline: CourseOutline): Promise<CourseOutline> {
    const normalizedNext = this.normalizeOutline(subject, nextOutline);
    await this.clearCourseContent(subject);
    await this.saveCourseOutline(subject, normalizedNext);
    return normalizedNext;
  }

  async applyPartialRebuild(
    subject: Subject,
    currentOutline: CourseOutline,
    nextOutline: CourseOutline,
    selection: { startIndex: number; endIndex: number },
  ): Promise<CourseOutline> {
    const normalizedCurrent = this.normalizeOutline(subject, currentOutline);
    const normalizedNext = this.normalizeOutline(subject, nextOutline);

    const replacedTopics = normalizedCurrent.topics.slice(selection.startIndex, selection.endIndex + 1);
    for (const topic of replacedTopics) {
      await fs.rm(this.paths.courseTopicDir(subject, topic.id), { recursive: true, force: true });
    }

    const replacementCount = normalizedNext.topics.length - (normalizedCurrent.topics.length - replacedTopics.length);
    const retainedMappings: Array<{ oldTopic: TopicOutline; newTopic: TopicOutline }> = [];

    for (let index = 0; index < selection.startIndex; index += 1) {
      const oldTopic = normalizedCurrent.topics[index];
      const newTopic = normalizedNext.topics[index];
      if (oldTopic && newTopic) {
        retainedMappings.push({ oldTopic, newTopic });
      }
    }

    const newSuffixStart = selection.startIndex + replacementCount;
    for (
      let oldIndex = selection.endIndex + 1, newIndex = newSuffixStart;
      oldIndex < normalizedCurrent.topics.length && newIndex < normalizedNext.topics.length;
      oldIndex += 1, newIndex += 1
    ) {
      const oldTopic = normalizedCurrent.topics[oldIndex];
      const newTopic = normalizedNext.topics[newIndex];
      if (oldTopic && newTopic) {
        retainedMappings.push({ oldTopic, newTopic });
      }
    }

    const stagedTopicMappings = [];
    for (const [index, mapping] of retainedMappings.entries()) {
      const currentTopicDir = mapping.oldTopic.id === mapping.newTopic.id
        ? this.paths.courseTopicDir(subject, mapping.oldTopic.id)
        : await this.stagePathIfNeeded(
            this.paths.courseTopicDir(subject, mapping.oldTopic.id),
            `topic-${index}-${mapping.oldTopic.id}`,
          );
      stagedTopicMappings.push({ ...mapping, currentTopicDir });
    }

    for (const mapping of stagedTopicMappings) {
      await this.movePathIfNeeded(mapping.currentTopicDir, this.paths.courseTopicDir(subject, mapping.newTopic.id));
      await this.migrateRetainedTopicArtifacts(subject, mapping.oldTopic, mapping.newTopic);
    }

    await this.saveCourseOutline(subject, normalizedNext);
    return normalizedNext;
  }

  private buildStagingPath(sourcePath: string, label: string): string {
    const directory = path.dirname(sourcePath);
    const baseName = path.basename(sourcePath);
    const safeLabel = label.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'move';
    return path.join(directory, `.__cc-stage__${safeLabel}__${baseName}`);
  }

  private async stagePathIfNeeded(sourcePath: string, label: string): Promise<string> {
    if (!await fileExists(sourcePath)) {
      return sourcePath;
    }

    const stagedPath = this.buildStagingPath(sourcePath, label);
    await fs.rm(stagedPath, { recursive: true, force: true });
    await fs.rename(sourcePath, stagedPath);
    return stagedPath;
  }

  private async movePathIfNeeded(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath || !await fileExists(sourcePath)) {
      return;
    }

    await ensureDir(path.dirname(targetPath));
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.rename(sourcePath, targetPath);
  }

  private async migrateRetainedTopicArtifacts(subject: Subject, oldTopic: TopicOutline, newTopic: TopicOutline): Promise<void> {
    const lessonsDir = this.paths.courseLessonsDir(subject, newTopic.id);
    const exercisesDir = this.paths.courseExercisesDir(subject, newTopic.id);

    await ensureDir(this.paths.courseTopicDir(subject, newTopic.id));
    await ensureDir(lessonsDir);
    await ensureDir(exercisesDir);

    const lessonPairs = oldTopic.lessons.map((oldLesson, index) => ({
      oldLesson,
      newLesson: newTopic.lessons[index] ?? null,
    })).filter((pair): pair is { oldLesson: LessonMeta; newLesson: LessonMeta } => !!pair.newLesson);

    const stagedLessonPaths = new Map<string, string>();
    const stagedExerciseDirs = new Map<string, string>();

    for (const [index, { oldLesson, newLesson }] of lessonPairs.entries()) {
      if (oldLesson.id === newLesson.id) {
        continue;
      }

      stagedLessonPaths.set(
        oldLesson.id,
        await this.stagePathIfNeeded(
          path.join(lessonsDir, `${oldLesson.id}.md`),
          `lesson-${newTopic.id}-${index}-${oldLesson.id}`,
        ),
      );
      stagedExerciseDirs.set(
        oldLesson.id,
        await this.stagePathIfNeeded(
          path.join(exercisesDir, oldLesson.id),
          `exercise-${newTopic.id}-${index}-${oldLesson.id}`,
        ),
      );
    }

    for (const { oldLesson, newLesson } of lessonPairs) {
      const sourceLessonPath = stagedLessonPaths.get(oldLesson.id) ?? path.join(lessonsDir, `${oldLesson.id}.md`);
      const targetLessonPath = path.join(lessonsDir, `${newLesson.id}.md`);
      await this.movePathIfNeeded(sourceLessonPath, targetLessonPath);

      const sourceExerciseDir = stagedExerciseDirs.get(oldLesson.id) ?? path.join(exercisesDir, oldLesson.id);
      const targetExerciseDir = path.join(exercisesDir, newLesson.id);
      await this.movePathIfNeeded(sourceExerciseDir, targetExerciseDir);
    }
  }

  private async copyLegacyFileIfMissing(sourcePath: string, targetPath: string): Promise<void> {
    if (!await fileExists(sourcePath) || await fileExists(targetPath)) {
      return;
    }

    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  }

  private buildLegacySessionId(courseTitle: string, topicTitle: string, lessonTitle: string): string {
    const sanitize = (value: string) => value.replace(/[\\/:*?"<>|\s]/g, '_');
    return `${sanitize(courseTitle || '')}_${sanitize(topicTitle || '')}_${sanitize(lessonTitle || '')}`;
  }

  private findLegacyTopic(legacyOutline: CourseOutline, migratedTopic: TopicOutline, topicIndex: number): TopicOutline | null {
    return legacyOutline.topics.find(topic => topic.title === migratedTopic.title)
      ?? legacyOutline.topics[topicIndex]
      ?? null;
  }

  private findLegacyLesson(legacyTopic: TopicOutline, migratedLesson: LessonMeta, lessonIndex: number): LessonMeta | null {
    return legacyTopic.lessons.find(lesson => lesson.title === migratedLesson.title)
      ?? legacyTopic.lessons[lessonIndex]
      ?? null;
  }

  private async migrateLegacyCourseArtifacts(subject: Subject, legacyOutline: CourseOutline, migratedOutline: CourseOutline): Promise<void> {
    await this.copyLegacyFileIfMissing(
      this.paths.legacyCourseSummaryPath(subject),
      this.paths.courseSummaryPath(subject)
    );

    for (const [topicIndex, migratedTopic] of migratedOutline.topics.entries()) {
      const legacyTopic = this.findLegacyTopic(legacyOutline, migratedTopic, topicIndex);
      if (!legacyTopic) {
        continue;
      }

      await this.copyLegacyFileIfMissing(
        this.paths.legacyTopicSummaryPath(subject, legacyTopic.id),
        this.getTopicSummaryPath(subject, migratedTopic.id)
      );

      for (const [lessonIndex, migratedLesson] of migratedTopic.lessons.entries()) {
        const legacyLesson = this.findLegacyLesson(legacyTopic, migratedLesson, lessonIndex);
        if (!legacyLesson) {
          continue;
        }

        await this.copyLegacyFileIfMissing(
          this.paths.legacyLessonPath(subject, legacyTopic.id, legacyLesson.id),
          this.getLessonPath(subject, migratedTopic.id, migratedLesson.id)
        );

        const legacySessionId = this.buildLegacySessionId(
          legacyOutline.title,
          legacyTopic.title,
          legacyLesson.title
        );

        await this.copyLegacyFileIfMissing(
          this.paths.legacyExercisePromptPath(subject, legacyTopic.id, legacySessionId),
          this.getExercisePath(subject, migratedTopic.id, migratedLesson.id)
        );
        await this.copyLegacyFileIfMissing(
          this.paths.legacyExerciseJsonPath(subject, legacyTopic.id, legacySessionId),
          this.getExerciseJsonPath(subject, migratedTopic.id, migratedLesson.id)
        );
        await this.copyLegacyFileIfMissing(
          this.paths.legacyExerciseGradePath(subject, legacyTopic.id, legacySessionId),
          this.getGradePath(subject, migratedTopic.id, migratedLesson.id)
        );
        await this.copyLegacyFileIfMissing(
          this.paths.legacyExerciseFeedbackPath(subject, legacyTopic.id, legacySessionId),
          this.getFeedbackPath(subject, migratedTopic.id, migratedLesson.id)
        );
      }
    }
  }

  async getCourseOutline(subject: Subject): Promise<CourseOutline | null> {
    const nextOutline = await readJson<CourseOutline>(this.paths.courseOutlinePath(subject));
    if (nextOutline) {
      return this.normalizeOutline(subject, nextOutline);
    }

    const legacyOutline = await readJson<CourseOutline>(this.paths.legacyCourseOutlinePath(subject));
    if (!legacyOutline) {
      return null;
    }

    const migratedOutline = this.normalizeOutline(subject, legacyOutline);
    await this.saveCourseOutline(subject, migratedOutline);
    await this.migrateLegacyCourseArtifacts(subject, legacyOutline, migratedOutline);
    return migratedOutline;
  }

  async getAllCourses(): Promise<CourseOutline[]> {
    const subjects = new Set<string>();

    for (const subject of await this.listDirectoryNames(this.paths.workspaceCoursesDir)) {
      subjects.add(subject);
    }
    for (const subject of await this.listDirectoryNames(this.paths.legacyDataRoot)) {
      subjects.add(subject);
    }

    const courses: CourseOutline[] = [];
    for (const subject of subjects) {
      const outline = await this.getCourseOutline(subject);
      if (outline) {
        courses.push(outline);
      }
    }

    return courses;
  }

  /** 更新课程教学法 tag（多选）。会写回 outline.json。 */
  async setCourseTags(subject: Subject, tags: import('../types').CourseTag[]): Promise<boolean> {
    const outline = await this.getCourseOutline(subject);
    if (!outline) return false;
    outline.tags = Array.from(new Set(tags));
    await this.saveCourseOutline(subject, outline);
    return true;
  }

  async deleteCourse(subject: Subject): Promise<void> {
    for (const filePath of [this.paths.courseOutlinePath(subject), this.paths.legacyCourseOutlinePath(subject)]) {
      try {
        await fs.unlink(filePath);
      } catch {
        // Ignore if the outline file is already missing.
      }
    }
  }

  getCourseSummaryPath(subject: Subject): string {
    return this.paths.courseSummaryPath(subject);
  }

  getLessonPath(subject: Subject, topicId: string, lessonId: string): string {
    return this.paths.courseLessonPath(subject, topicId, lessonId);
  }

  getExercisePath(subject: Subject, topicId: string, sessionId: string): string {
    return this.paths.courseExercisePromptPath(subject, topicId, sessionId);
  }

  getExerciseJsonPath(subject: Subject, topicId: string, sessionId: string): string {
    return this.paths.courseExerciseJsonPath(subject, topicId, sessionId);
  }

  getFeedbackPath(subject: Subject, topicId: string, sessionId: string): string {
    return this.paths.courseExerciseFeedbackPath(subject, topicId, sessionId);
  }

  async getDeterministicSessionId(subject: Subject, topicId: string, lessonId: string): Promise<string> {
    const outline = await this.getCourseOutline(subject);
    return outline?.topics.find(topic => topic.id === topicId)?.lessons.find(lesson => lesson.id === lessonId)?.id ?? lessonId;
  }

  async getExerciseFiles(subject: Subject, topicId: string): Promise<string[]> {
    const sessions = await this.listDirectoryNames(this.paths.courseExercisesDir(subject, topicId));
    return sessions
      .map(sessionId => this.getExercisePath(subject, topicId, sessionId))
      .filter(Boolean);
  }

  async getLessonExerciseFiles(subject: Subject, topicId: string, lessonId: string): Promise<string[]> {
    const promptPath = this.getExercisePath(subject, topicId, lessonId);
    return await fileExists(promptPath) ? [promptPath] : [];
  }

  getGradePath(subject: Subject, topicId: string, sessionId: string): string {
    return this.paths.courseExerciseGradePath(subject, topicId, sessionId);
  }

  getTopicSummaryPath(subject: Subject, topicId: string): string {
    return this.paths.courseTopicSummaryPath(subject, topicId);
  }

  async getTopicSummary(subject: Subject, topicId: string): Promise<TopicSummary | null> {
    const current = await readJson<TopicSummary>(this.getTopicSummaryPath(subject, topicId));
    if (current) {
      return current;
    }

    const outline = await this.getCourseOutline(subject);
    const topic = outline?.topics.find(item => item.id === topicId);
    if (!topic) {
      return null;
    }

    const legacyTopic = (await readJson<CourseOutline>(this.paths.legacyCourseOutlinePath(subject)))
      ?.topics.find(item => item.title === topic.title);

    if (!legacyTopic) {
      return null;
    }

    const legacy = await readJson<TopicSummary>(this.paths.legacyTopicSummaryPath(subject, legacyTopic.id));
    if (!legacy) {
      return null;
    }

    await writeJson(this.getTopicSummaryPath(subject, topicId), {
      ...legacy,
      topicId,
      subject,
    });
    return {
      ...legacy,
      topicId,
      subject,
    };
  }

  async updateTopicSummary(subject: Subject, topicId: string, score: number, mistakes: string[]): Promise<void> {
    const summaryPath = this.getTopicSummaryPath(subject, topicId);
    let summary = await this.getTopicSummary(subject, topicId);
    if (!summary) {
      summary = { topicId, subject, totalSessions: 0, averageScore: 0, scores: [], mistakeTypes: {}, lastUpdated: '' };
    }

    summary.scores.push(score);
    summary.totalSessions++;
    summary.averageScore = summary.scores.reduce((a, b) => a + b, 0) / summary.scores.length;
    for (const mistake of mistakes) {
      summary.mistakeTypes[mistake] = (summary.mistakeTypes[mistake] ?? 0) + 1;
    }
    summary.lastUpdated = new Date().toISOString();

    await writeJson(summaryPath, summary);
  }

  private parseExerciseSections(markdown: string): Array<{ answer: string; alreadyGraded: boolean }> {
    const result: Array<{ answer: string; alreadyGraded: boolean }> = [];
    const parts = markdown.split(/^(##\s+[^\n]+)/m);

    for (let index = 1; index < parts.length; index += 2) {
      const section = (parts[index] || '') + (parts[index + 1] || '');
      const alreadyGraded = section.includes('> **Score: ');
      let answer = '';

      const answerMatch = section.match(/>\s*[^\n]*\n([\s\S]*?)(?:\n---|\n##\s|$)/);
      if (answerMatch) {
        answer = answerMatch[1].trim();
        const markerIndex = answer.indexOf('> **Score: ');
        if (markerIndex >= 0) {
          answer = answer.slice(0, markerIndex).trim();
        }
      }

      if (!answer) {
        const codeMatch = section.match(/```[^\n]*\n([\s\S]*?)```/);
        if (codeMatch) {
          const code = codeMatch[1].trim();
          if (code && !/write your code here|\/\/\s*请在此处写出你的代码/i.test(code)) {
            answer = code;
          }
        }
      }

      result.push({ answer, alreadyGraded });
    }

    return result;
  }

  /** 一次性懒迁移：把旧 `prompt.md` 重命名为 `练习.md`。安静失败。 */
  async migrateExerciseMarkdownNameIfNeeded(subject: Subject, topicId: string, lessonId: string): Promise<void> {
    const newPath = this.paths.courseExercisePromptPath(subject, topicId, lessonId);
    const legacyPath = this.paths.legacyCourseExercisePromptPath(subject, topicId, lessonId);
    if (await fileExists(newPath)) {
      return;
    }
    if (!await fileExists(legacyPath)) {
      return;
    }
    try {
      await fs.rename(legacyPath, newPath);
    } catch {
      // 静默失败：迁移失败时旧文件仍可用，不阻断功能。
    }
  }

  private async resolveLessonStatus(
    subject: Subject,
    topicId: string,
    lessonId: string,
    currentStatus?: LessonMeta['status'],
  ): Promise<LessonMeta['status']> {
    await this.migrateExerciseMarkdownNameIfNeeded(subject, topicId, lessonId);
    const lessonPath = this.getLessonPath(subject, topicId, lessonId);
    const exercisePath = this.getExercisePath(subject, topicId, lessonId);
    const [lessonExists, exerciseExists] = await Promise.all([
      fileExists(lessonPath),
      fileExists(exercisePath),
    ]);

    if (exerciseExists) {
      try {
        const markdown = await fs.readFile(exercisePath, 'utf-8');
        const sections = this.parseExerciseSections(markdown);
        if (sections.length > 0 && sections.every(section => section.answer.trim() && section.alreadyGraded)) {
          return 'completed';
        }
      } catch {
        // Fall through to file-based status.
      }
    }

    if (currentStatus === 'completed') {
      return 'completed';
    }

    return lessonExists || exerciseExists ? 'in-progress' : 'not-started';
  }

  async updateLessonStatus(subject: Subject, topicId: string, lessonId: string, status: LessonMeta['status']): Promise<boolean> {
    const outline = await this.getCourseOutline(subject);
    if (!outline) {
      return false;
    }

    const lesson = outline.topics
      .find(topic => topic.id === topicId)
      ?.lessons.find(item => item.id === lessonId);

    if (!lesson || lesson.status === status) {
      return false;
    }

    lesson.status = status;
    await this.saveCourseOutline(subject, outline);
    return true;
  }

  async markLessonCompleted(subject: Subject, topicId: string, lessonId: string): Promise<boolean> {
    return this.updateLessonStatus(subject, topicId, lessonId, 'completed');
  }

  async resetLessonProgress(subject: Subject, topicId: string, lessonId: string): Promise<void> {
    const lessonPath = this.getLessonPath(subject, topicId, lessonId);
    const exerciseDir = path.dirname(this.getExercisePath(subject, topicId, lessonId));

    await Promise.all([
      fs.rm(lessonPath, { force: true }),
      fs.rm(exerciseDir, { recursive: true, force: true }),
    ]);

    await this.updateLessonStatus(subject, topicId, lessonId, 'not-started');
  }

  async syncLessonStatus(subject: Subject, topicId: string, lessonId: string): Promise<LessonMeta['status'] | null> {
    const outline = await this.getCourseOutline(subject);
    if (!outline) {
      return null;
    }

    const lesson = outline.topics
      .find(topic => topic.id === topicId)
      ?.lessons.find(item => item.id === lessonId);

    if (!lesson) {
      return null;
    }

    const nextStatus = await this.resolveLessonStatus(subject, topicId, lessonId, lesson.status);
    if (lesson.status !== nextStatus) {
      lesson.status = nextStatus;
      await this.saveCourseOutline(subject, outline);
    }

    return nextStatus;
  }

  async syncLessonStatuses(subject?: Subject): Promise<void> {
    const outlines = subject
      ? [await this.getCourseOutline(subject)]
      : await this.getAllCourses();

    for (const outline of outlines) {
      if (!outline) {
        continue;
      }

      let changed = false;

      for (const topic of outline.topics) {
        for (const lesson of topic.lessons) {
          const nextStatus = await this.resolveLessonStatus(outline.subject, topic.id, lesson.id, lesson.status);
          if (lesson.status !== nextStatus) {
            lesson.status = nextStatus;
            changed = true;
          }
        }
      }

      if (changed) {
        await this.saveCourseOutline(outline.subject, outline);
      }
    }
  }

  async lessonExists(subject: Subject, topicId: string, lessonId: string): Promise<boolean> {
    return fileExists(this.getLessonPath(subject, topicId, lessonId));
  }

  // ===== Wrong question book =====

  private buildEmptyWrongQuestionBook(subject: Subject): WrongQuestionBook {
    return {
      schemaVersion: 1,
      subject,
      questions: [],
      updatedAt: new Date().toISOString(),
    };
  }

  async getWrongQuestionBook(subject: Subject): Promise<WrongQuestionBook> {
    const stored = await readJson<WrongQuestionBook>(this.paths.wrongQuestionsPath(subject));
    if (stored && Array.isArray(stored.questions)) {
      return {
        schemaVersion: stored.schemaVersion ?? 1,
        subject: stored.subject ?? subject,
        questions: stored.questions,
        updatedAt: stored.updatedAt ?? new Date().toISOString(),
      };
    }
    return this.buildEmptyWrongQuestionBook(subject);
  }

  private async saveWrongQuestionBook(subject: Subject, book: WrongQuestionBook): Promise<void> {
    const next: WrongQuestionBook = {
      ...book,
      schemaVersion: book.schemaVersion ?? 1,
      subject,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.paths.wrongQuestionsPath(subject), next);
  }

  async upsertWrongQuestion(subject: Subject, question: WrongQuestion): Promise<void> {
    const book = await this.getWrongQuestionBook(subject);
    const existingIndex = book.questions.findIndex(q =>
      q.exerciseId === question.exerciseId
      && q.lessonId === question.lessonId
      && q.topicId === question.topicId
    );

    if (existingIndex >= 0) {
      const existing = book.questions[existingIndex];
      book.questions[existingIndex] = {
        ...existing,
        ...question,
        // preserve original first-failure metadata
        firstFailedAt: existing.firstFailedAt || question.firstFailedAt,
        attempts: (existing.attempts ?? 0) + 1,
        lastAttemptedAt: question.lastAttemptedAt || new Date().toISOString(),
        resolved: false,
        resolvedAt: undefined,
      };
    } else {
      book.questions.push({
        ...question,
        attempts: question.attempts ?? 1,
        resolved: false,
      });
    }

    await this.saveWrongQuestionBook(subject, book);
  }

  async resolveWrongQuestion(subject: Subject, questionId: string): Promise<void> {
    const book = await this.getWrongQuestionBook(subject);
    const target = book.questions.find(q => q.id === questionId);
    if (!target || target.resolved) {
      return;
    }
    target.resolved = true;
    target.resolvedAt = new Date().toISOString();
    await this.saveWrongQuestionBook(subject, book);
  }

  async listWrongQuestions(
    subject: Subject,
    options?: { topicId?: string; lessonId?: string; onlyUnresolved?: boolean; limit?: number }
  ): Promise<WrongQuestion[]> {
    const book = await this.getWrongQuestionBook(subject);
    const onlyUnresolved = options?.onlyUnresolved ?? true;

    let filtered = book.questions.filter(q => {
      if (onlyUnresolved && q.resolved) {
        return false;
      }
      if (options?.topicId && q.topicId !== options.topicId) {
        return false;
      }
      if (options?.lessonId && q.lessonId !== options.lessonId) {
        return false;
      }
      return true;
    });

    // Most recent failures first
    filtered.sort((a, b) => (b.lastAttemptedAt || '').localeCompare(a.lastAttemptedAt || ''));

    if (typeof options?.limit === 'number' && options.limit >= 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  async clearResolvedWrongQuestions(subject: Subject): Promise<void> {
    const book = await this.getWrongQuestionBook(subject);
    const before = book.questions.length;
    book.questions = book.questions.filter(q => !q.resolved);
    if (book.questions.length === before) {
      return;
    }
    await this.saveWrongQuestionBook(subject, book);
  }
}
