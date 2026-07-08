import * as fs from 'fs/promises';
import * as path from 'path';
import { CourseOutline, GradeResult, LessonKeyPoints, LessonMeta, Subject, TopicOutline, TopicSummary, WrongQuestion, WrongQuestionBook } from '../types';
import { readJson, writeJson, ensureDir, fileExists } from '../utils/fileSystem';
import { StoragePathResolver, buildLessonCode, buildTopicCode, getStoragePathResolver, isCollapsedPlaceholderSlug } from '../storage/pathResolver';

export class CourseManager {
  private readonly paths: StoragePathResolver;
  private static readonly TOPIC_CODE_PATTERN = /^\d{2}-chapter-[a-z0-9-]+$/;
  private static readonly LESSON_CODE_PATTERN = /^\d{2}-\d{2}-[a-z0-9-]+$/;

  /**
   * 每个 subject 一把 outline 写锁。
   *
   * 用途：lesson 增删改重排（read-modify-write outline.json）必须串行，否则
   * webview 多个消息（rename + reorder）几乎同时到达时，两个 handler 并发
   * 各自 readOutline → 改 → writeOutline，后写的会覆盖先写的 → 用户感受是
   * "按钮没反应 / 位置错乱"。saveCourseOutline 本身是全量写盘没有 race，
   * 但**基于旧快照写**就会丢另一方改动 —— 所以锁必须包整段 read+write。
   */
  private _outlineLock = new Map<string, Promise<void>>();

  constructor() {
    this.paths = getStoragePathResolver();
  }

  /** 串行执行 outline read-modify-write。fn 内部任何 throw 都会被向上抛，但不会阻塞后续。 */
  private _withOutlineLock<T>(subject: Subject, fn: () => Promise<T>): Promise<T> {
    const prev = this._outlineLock.get(subject) ?? Promise.resolve();
    const result = prev.then(fn);
    // 让"下一个等本次完成"，无论成功失败都接着排队
    const next = result.then(() => {}, () => {});
    this._outlineLock.set(subject, next);
    next.finally(() => {
      if (this._outlineLock.get(subject) === next) {
        this._outlineLock.delete(subject);
      }
    });
    return result;
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
    // 即便 candidate 形状合法，如果是塌缩占位符（NN-chapter-topic）也要重算
    if (CourseManager.TOPIC_CODE_PATTERN.test(candidate) && !CourseManager.isCollapsedTopicCode(candidate)) {
      return candidate;
    }

    return buildTopicCode(chapterNumber, topic.title, topic.code ?? topic.id);
  }

  /**
   * 检查一个已存在的 topic/lesson code 是否是"塌缩占位符"——
   * 旧版 normalizeOutline 对"已合法的 code 一律原样保留"会导致一门课里所有章都叫
   * `NN-chapter-topic`（中文标题转不出真 slug → 退到 'topic'）。这些 code 虽然语法
   * 合规、正则能过，但语义是空的、且彼此重复，应当重算而非保留。
   */
  private static isCollapsedTopicCode(code: string): boolean {
    const m = String(code).match(/^\d{2}-chapter-(.*)$/);
    if (!m) return false;
    return isCollapsedPlaceholderSlug(m[1]);
  }

  private static isCollapsedLessonCode(code: string): boolean {
    const m = String(code).match(/^\d{2}-\d{2}-(.*)$/);
    if (!m) return false;
    return isCollapsedPlaceholderSlug(m[1]);
  }

  private resolveLessonCode(lesson: LessonMeta, chapterNumber: number, lessonNumber: number): string {
    const candidate = String(lesson.code ?? lesson.id ?? '').trim().toLowerCase();
    if (CourseManager.LESSON_CODE_PATTERN.test(candidate) && !CourseManager.isCollapsedLessonCode(candidate)) {
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

    // 两个目录扫描可并行
    const [workspaceDirs, legacyDirs] = await Promise.all([
      this.listDirectoryNames(this.paths.workspaceCoursesDir),
      this.listDirectoryNames(this.paths.legacyDataRoot),
    ]);
    for (const subject of workspaceDirs) subjects.add(subject);
    for (const subject of legacyDirs) subjects.add(subject);

    // 并行读各 subject 的 outline（之前串行 await 每个，课多了线性叠加）
    const results = await Promise.all(
      Array.from(subjects).map((subject) => this.getCourseOutline(subject))
    );
    const courses: CourseOutline[] = [];
    for (const outline of results) {
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

  /**
   * 彻底删除一个 subject 的全部课程内容（讲义 / 练习 / 知识点）。
   *
   * 删除范围：
   *  - courseSubjectDir 整目录（outline / summary / profile / wrong-questions /
   *    adaptive-trigger / 所有 topics 下的讲义.md / .keypoints.json / 练习 / 批改）
   *  - legacy 残留（老路径的 course-outline.json / course-summary.md）
   *
   * **不**触碰：
   *  - 导入资料（由 MaterialManager.deleteAllMaterialsForSubject 负责）
   *  - 学科级诊断 diagnosisSubjectDir：**故意不删**。sanitizeSegment 对纯中文学科名
   *    （如"微积分"/"数据结构"）会塌缩成同一个 fallback 'course' 目录 → 删一个会误删
   *    所有中文学科的共享诊断目录（跨 subject 数据丢失）。诊断是小元数据，下次批改会
   *    重写，留着无害；删它风险远大于收益。
   *  - 全局诊断、全局用户 profile / preferences、该学科下的项目（projects，独立概念）。
   *
   * 全用 courseSubjectDir（raw subject key，与创建时 saveCourseOutline 一致）→ 域内对称。
   *
   * 包在 _outlineLock 内串行：避免删除时恰好有 lesson rename/reorder 在跑，
   * 后者基于已删的快照写回又把目录创建回来。
   */
  async deleteCourseCompletely(subject: Subject): Promise<void> {
    // 防御：空 subject 会让 courseSubjectDir('') 塌缩到 courses 根目录 → 核灭所有学科。
    if (!subject || !subject.trim()) return;
    return this._withOutlineLock(subject, async () => {
      // 1. 整个课程内容目录
      await this.clearCourseContent(subject);
      // 2. legacy 残留文件
      for (const p of [this.paths.legacyCourseOutlinePath(subject), this.paths.legacyCourseSummaryPath(subject)]) {
        await fs.rm(p, { force: true }).catch(() => { /* 不存在忽略 */ });
      }
    });
  }

  getCourseSummaryPath(subject: Subject): string {
    return this.paths.courseSummaryPath(subject);
  }

  getLessonPath(subject: Subject, topicId: string, lessonId: string): string {
    return this.paths.courseLessonPath(subject, topicId, lessonId);
  }

  // ===== Lesson key points (one JSON per lesson) =====

  /** keypoints 文件跟 lesson .md 同目录，扩展名 .keypoints.json。 */
  getKeyPointsPath(subject: Subject, topicId: string, lessonId: string): string {
    return path.join(this.paths.courseLessonsDir(subject, topicId), `${lessonId}.keypoints.json`);
  }

  async readKeyPoints(subject: Subject, topicId: string, lessonId: string): Promise<LessonKeyPoints | null> {
    return await readJson<LessonKeyPoints>(this.getKeyPointsPath(subject, topicId, lessonId));
  }

  async writeKeyPoints(subject: Subject, topicId: string, lessonId: string, data: LessonKeyPoints): Promise<void> {
    const filePath = this.getKeyPointsPath(subject, topicId, lessonId);
    await ensureDir(path.dirname(filePath));
    await writeJson(filePath, data);
  }

  // ===== Lesson CRUD（topic 内的增删改/重排，不动 topic 本身）=====
  // 关键：lessonCode（如 "01-02-foo"）在 normalizeOutline 里 candidate-preservation
  // —— 现有 lesson.code 合规就保留，因此重命名 / 删除 / 重排都不会改 lessonCode →
  // .md 文件路径不变 → 不需要文件迁移。只有 addLesson 新建的 lesson 会由 normalize 生成新 code。

  /** 重命名 lesson 标题（lessonCode 不变，对应的 .md 文件不动）。 */
  async renameLesson(subject: Subject, topicId: string, lessonId: string, newTitle: string): Promise<void> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const topic = outline.topics.find(t => t.id === topicId);
      if (!topic) throw new Error(`找不到 topic: ${topicId}`);
      const lesson = topic.lessons.find(l => l.id === lessonId);
      if (!lesson) throw new Error(`找不到 lesson: ${lessonId}`);
      const trimmed = newTitle.trim();
      if (!trimmed) throw new Error('lesson 标题不能为空');
      lesson.title = trimmed;
      await this.saveCourseOutline(subject, outline);
    });
  }

  /** 在 topic 末尾追加一个 lesson。code 由 normalizeOutline 自动生成。返回新 lesson。 */
  async addLesson(subject: Subject, topicId: string, title: string): Promise<LessonMeta> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const topic = outline.topics.find(t => t.id === topicId);
      if (!topic) throw new Error(`找不到 topic: ${topicId}`);
      const draft: LessonMeta = {
        id: '',  // normalizeLesson 会重新算 lessonCode 当 id
        title: title.trim() || '新讲义',
        difficulty: 1,
        status: 'not-started',
        filePath: '',
      };
      topic.lessons.push(draft);
      await this.saveCourseOutline(subject, outline);
      const newOutline = await this.getCourseOutline(subject);
      const newTopic = newOutline?.topics.find(t => t.id === topicId);
      const added = newTopic?.lessons[newTopic.lessons.length - 1];
      if (!added) throw new Error('lesson 创建失败');
      return added;
    });
  }

  /** 删除 lesson + 关联文件（.md / .md.bak / .keypoints.json / 练习）。best-effort 删除。 */
  async deleteLesson(subject: Subject, topicId: string, lessonId: string): Promise<void> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const topic = outline.topics.find(t => t.id === topicId);
      if (!topic) throw new Error(`找不到 topic: ${topicId}`);
      const idx = topic.lessons.findIndex(l => l.id === lessonId);
      if (idx < 0) throw new Error(`找不到 lesson: ${lessonId}`);
      topic.lessons.splice(idx, 1);
      await this.saveCourseOutline(subject, outline);

      const lessonPath = this.getLessonPath(subject, topicId, lessonId);
      const keypointsPath = this.getKeyPointsPath(subject, topicId, lessonId);
      const exercisePath = this.getExercisePath(subject, topicId, lessonId);
      const exerciseJsonPath = this.getExerciseJsonPath(subject, topicId, lessonId);
      for (const p of [lessonPath, lessonPath + '.bak', keypointsPath, exercisePath, exerciseJsonPath]) {
        await fs.rm(p, { force: true }).catch(() => { /* 文件可能不存在，忽略 */ });
      }
    });
  }

  /** 上下移动 lesson 顺序（dir: -1 上移, +1 下移）。lessonCode 保留 → 不动文件。 */
  async reorderLesson(subject: Subject, topicId: string, lessonId: string, dir: -1 | 1): Promise<void> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const topic = outline.topics.find(t => t.id === topicId);
      if (!topic) throw new Error(`找不到 topic: ${topicId}`);
      const idx = topic.lessons.findIndex(l => l.id === lessonId);
      if (idx < 0) throw new Error(`找不到 lesson: ${lessonId}`);
      const target = idx + dir;
      if (target < 0 || target >= topic.lessons.length) return;
      [topic.lessons[idx], topic.lessons[target]] = [topic.lessons[target], topic.lessons[idx]];
      await this.saveCourseOutline(subject, outline);
    });
  }

  // ===== Topic CRUD（整章增删改/重排）=====
  // 与 lesson 一致：现有 topic.code 合规就保留 → 重命名/重排不改 code →
  // 目录路径不变，无需文件迁移。只有 addTopic 新建的 topic 由 normalize 生成新 code。

  /** 重命名 topic 标题（code 保留，目录不动）。 */
  async renameTopic(subject: Subject, topicId: string, newTitle: string): Promise<void> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const topic = outline.topics.find(t => t.id === topicId);
      if (!topic) throw new Error(`找不到 topic: ${topicId}`);
      const trimmed = newTitle.trim();
      if (!trimmed) throw new Error('topic 标题不能为空');
      topic.title = trimmed;
      await this.saveCourseOutline(subject, outline);
    });
  }

  /** 在末尾追加一个 topic。code 由 normalize 自动生成。返回新 topic。 */
  async addTopic(subject: Subject, title: string): Promise<TopicOutline> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const draft: TopicOutline = {
        id: '',  // normalizeTopic 会重新算 topicCode 当 id
        title: title.trim() || '新主题',
        lessons: [],
      };
      outline.topics.push(draft);
      await this.saveCourseOutline(subject, outline);
      const newOutline = await this.getCourseOutline(subject);
      const added = newOutline?.topics[newOutline.topics.length - 1];
      if (!added) throw new Error('topic 创建失败');
      return added;
    });
  }

  /** 删除 topic + 整个 topic 目录（讲义 / 知识点 / 练习 / 批改）。best-effort 删除。 */
  async deleteTopic(subject: Subject, topicId: string): Promise<void> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const idx = outline.topics.findIndex(t => t.id === topicId);
      if (idx < 0) throw new Error(`找不到 topic: ${topicId}`);
      outline.topics.splice(idx, 1);
      await this.saveCourseOutline(subject, outline);
      // 删整目录（讲义 / .keypoints.json / 练习 / 批改都在其下）
      await fs.rm(this.paths.courseTopicDir(subject, topicId), { recursive: true, force: true }).catch(() => { /* 不存在忽略 */ });
    });
  }

  /** 上下移动 topic 顺序（dir: -1 上移, +1 下移）。code 保留 → 不动文件。 */
  async reorderTopic(subject: Subject, topicId: string, dir: -1 | 1): Promise<void> {
    return this._withOutlineLock(subject, async () => {
      const outline = await this.getCourseOutline(subject);
      if (!outline) throw new Error('找不到课程大纲');
      const idx = outline.topics.findIndex(t => t.id === topicId);
      if (idx < 0) throw new Error(`找不到 topic: ${topicId}`);
      const target = idx + dir;
      if (target < 0 || target >= outline.topics.length) return;
      [outline.topics[idx], outline.topics[target]] = [outline.topics[target], outline.topics[idx]];
      await this.saveCourseOutline(subject, outline);
    });
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

  /**
   * 列出指定 lesson 最近 N 次 grade 结果，按 gradedAt 降序。
   * 用于流式难度：基于最近几道题表现调下一题难度。
   */
  async listRecentLessonGrades(
    subject: Subject,
    topicId: string,
    lessonId: string,
    limit: number = 5,
  ): Promise<GradeResult[]> {
    try {
      const sessionId = await this.getDeterministicSessionId(subject, topicId, lessonId);
      const gradeDir = path.dirname(this.getGradePath(subject, topicId, sessionId));
      if (!(await fileExists(gradeDir))) return [];
      const fs = await import('fs/promises');
      const entries = await fs.readdir(gradeDir);
      const candidates: GradeResult[] = [];
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(gradeDir, name);
        const data = await readJson<GradeResult>(full);
        if (data && data.gradedAt) candidates.push(data);
      }
      // 仅取与本 lesson 关联的（exerciseId 来自该 lessonId）
      const filtered = candidates.filter((g) => g.exerciseId && (g as any).lessonId === sessionId)
        .concat(candidates.filter((g) => !((g as any).lessonId)));
      filtered.sort((a, b) => (b.gradedAt || '').localeCompare(a.gradedAt || ''));
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
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

  /**
   * 同步所有课时 status（in-progress / completed / not-started）跟磁盘实物对齐。
   *
   * 这是个**重 IO** 操作：每个 lesson 跑 `resolveLessonStatus`，含 3-5 次 fs.access
   * + 可能的 markdown 解析。课多了串行跑会 30s+。
   *
   * 优化：
   *   - 接受 preloadedOutlines 避免重复 getAllCourses 扫盘
   *   - 同一 outline 内的所有 lesson 用 Promise.all 并行 resolve
   *   - 跨 outline 也并行
   * 返回 true 表示**有任何课时状态变化**（写盘了），调用方可据此决定是否再发 'courses' 推送。
   */
  async syncLessonStatuses(subject?: Subject, preloadedOutlines?: CourseOutline[]): Promise<boolean> {
    let outlines: (CourseOutline | null)[];
    if (preloadedOutlines) {
      outlines = subject
        ? preloadedOutlines.filter((o) => o?.subject === subject)
        : preloadedOutlines;
    } else {
      outlines = subject
        ? [await this.getCourseOutline(subject)]
        : await this.getAllCourses();
    }

    const results = await Promise.all(outlines.map(async (outline) => {
      if (!outline) return false;

      // 把所有 lesson 摊平成一维列表，并行 resolve
      const flat: Array<{ topicId: string; lesson: typeof outline.topics[number]['lessons'][number] }> = [];
      for (const topic of outline.topics) {
        for (const lesson of topic.lessons) {
          flat.push({ topicId: topic.id, lesson });
        }
      }

      const nextStatuses = await Promise.all(
        flat.map(({ topicId, lesson }) =>
          this.resolveLessonStatus(outline.subject, topicId, lesson.id, lesson.status)
        )
      );

      let changed = false;
      flat.forEach(({ lesson }, i) => {
        if (lesson.status !== nextStatuses[i]) {
          lesson.status = nextStatuses[i];
          changed = true;
        }
      });

      if (changed) {
        await this.saveCourseOutline(outline.subject, outline);
      }
      return changed;
    }));

    return results.some((c) => c === true);
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
