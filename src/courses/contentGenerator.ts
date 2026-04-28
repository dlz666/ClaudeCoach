import { AIClient } from '../ai/client';
import {
  strictCourseOutlinePrompt,
  strictFullRebuildCourseOutlinePrompt,
  strictPartialRebuildCourseOutlinePrompt,
  strictRebuildCourseOutlinePrompt,
  lessonPrompt,
  exercisePrompt,
} from '../ai/prompts';
import {
  CourseOutline,
  Subject,
  Exercise,
  LearningPreferences,
  LatestDiagnosis,
  OutlineRebuildSelection,
  StudentProfile,
  CourseProfile,
  CourseProfileChapter,
  TopicOutline,
  WrongQuestion,
  subjectLabel,
} from '../types';
import { CourseManager } from './courseManager';
import { writeText } from '../utils/fileSystem';
import { writeMarkdownAndPreview, buildCourseSummaryMd } from '../utils/markdown';

interface GenerationContext {
  profile?: StudentProfile | null;
  preferences?: LearningPreferences | null;
  diagnosis?: LatestDiagnosis | null;
  courseProfile?: CourseProfile | null;
  chapterProfile?: CourseProfileChapter | null;
  profileEvidenceSummary?: string;
  currentCourseTitle?: string;
  courseOutlineSummary?: string;
  materialSummary?: string;
  materialExerciseSummary?: string;
  retrievedExcerpts?: string;
  selectedMaterialTitle?: string;
  /** 课程教学法 tag，会进入 prompt 决定讲义骨架/题型分布。 */
  courseTags?: import('../types').CourseTag[];
}

export class ContentGenerator {
  private ai: AIClient;
  private courseManager: CourseManager;

  constructor() {
    this.ai = new AIClient();
    this.courseManager = new CourseManager();
  }

  async generateCourse(subject: Subject, ctx: GenerationContext): Promise<CourseOutline> {
    const messages = strictCourseOutlinePrompt(subject, ctx);
    const data = await this.ai.chatJson<{ title: string; topics: CourseOutline['topics'] }>(messages);
    this.assertOutlinePayload(data, '课程大纲');

    return this.persistOutline(subject, {
      id: `course-${subject}-${Date.now()}`,
      subject,
      title: data.title,
      topics: data.topics,
      createdAt: new Date().toISOString(),
    });
  }

  async rebuildCourse(
    subject: Subject,
    currentOutline: CourseOutline,
    ctx: GenerationContext
  ): Promise<CourseOutline> {
    const messages = strictRebuildCourseOutlinePrompt(subject, currentOutline, ctx);
    const data = await this.ai.chatJson<{ title: string; topics: CourseOutline['topics'] }>(messages);
    this.assertOutlinePayload(data, '重构课程大纲');

    const freshTopics = (data.topics ?? []).map(topic => ({
      ...topic,
      id: '',
      lessons: (topic.lessons ?? []).map(lesson => ({
        ...lesson,
        id: '',
      })),
    }));

    await this.courseManager.clearCourseContent(subject);

    return this.persistOutline(subject, {
      id: `course-${subject}-${Date.now()}`,
      subject,
      title: data.title,
      topics: freshTopics,
      createdAt: new Date().toISOString(),
    });
  }

  async previewFullRebuild(
    subject: Subject,
    currentOutline: CourseOutline,
    ctx: GenerationContext,
    instruction?: string,
  ): Promise<CourseOutline> {
    const messages = strictFullRebuildCourseOutlinePrompt(subject, currentOutline, ctx, instruction);
    const data = await this.ai.chatJson<{ title: string; topics: CourseOutline['topics'] }>(messages);
    this.assertOutlinePayload(data, '重构预览');

    return this.buildPreviewOutline(subject, {
      id: `course-${subject}-${Date.now()}`,
      subject,
      title: data.title,
      topics: data.topics ?? [],
      createdAt: currentOutline.createdAt || new Date().toISOString(),
    });
  }

  async previewPartialRebuild(
    subject: Subject,
    currentOutline: CourseOutline,
    selection: OutlineRebuildSelection,
    ctx: GenerationContext,
    instruction?: string,
  ): Promise<CourseOutline> {
    const messages = strictPartialRebuildCourseOutlinePrompt(subject, currentOutline, selection, ctx, instruction);
    const data = await this.ai.chatJson<{ topics: CourseOutline['topics'] }>(messages);
    this.assertOutlinePayload({ title: currentOutline.title, topics: data.topics }, '部分重构预览');

    const prefixTopics = currentOutline.topics
      .slice(0, selection.startIndex)
      .map((topic) => this.prepareExistingTopicForPreview(topic));
    const suffixTopics = currentOutline.topics
      .slice(selection.endIndex + 1)
      .map((topic) => this.prepareExistingTopicForPreview(topic));
    const replacementTopics = (data.topics ?? []).map((topic) => this.prepareGeneratedTopicForPreview(topic));

    return this.buildPreviewOutline(subject, {
      id: currentOutline.id,
      subject,
      title: currentOutline.title,
      topics: [...prefixTopics, ...replacementTopics, ...suffixTopics],
      createdAt: currentOutline.createdAt || new Date().toISOString(),
    });
  }

  async generateLesson(
    subject: Subject,
    topicId: string,
    topicTitle: string,
    lessonId: string,
    lessonTitle: string,
    difficulty: number,
    ctx: GenerationContext,
    wrongQuestions?: WrongQuestion[]
  ): Promise<string> {
    const focused = (wrongQuestions ?? []).slice(0, 2);
    const enrichedCtx = focused.length > 0
      ? this.injectWrongQuestionContext(ctx, focused, '最近错题反馈（讲义请覆盖这些薄弱点）')
      : ctx;

    const messages = lessonPrompt(subject, topicTitle, lessonTitle, difficulty, enrichedCtx);
    const content = await this.ai.chatCompletion(messages);

    const filePath = this.courseManager.getLessonPath(subject, topicId, lessonId);
    await writeMarkdownAndPreview(filePath, content);
    await this.courseManager.syncLessonStatus(subject, topicId, lessonId);

    return filePath;
  }

  async generateExercises(
    subject: Subject,
    topicId: string,
    lessonId: string,
    lessonTitle: string,
    count: number,
    difficulty: number,
    ctx: GenerationContext,
    wrongQuestions?: WrongQuestion[]
  ): Promise<{ exercises: Exercise[]; filePath: string }> {
    const adaptiveDifficulty = this.computeAdaptiveDifficulty(difficulty, ctx);
    const focused = (wrongQuestions ?? []).slice(0, 3);
    const enrichedCtx = focused.length > 0
      ? this.injectWrongQuestionContext(ctx, focused, '最近错题与对应薄弱点（请出题时覆盖这些考点的"变体"，不要照抄题面）')
      : ctx;

    const messages = exercisePrompt(subject, lessonTitle, count, adaptiveDifficulty, enrichedCtx);
    const exercises = await this.ai.chatJson<Exercise[]>(messages);

    // Assign lesson IDs. 强制按位置规范化为 `ex-${i+1}`，不保留 AI 可能给的 `ex-01` 等格式，
    // 否则前端"## 第 N 题"解析出的 `ex-N` 与后端 id 对不上，submitAllAnswers 会全部跳过。
    const sessionId = await this.courseManager.getDeterministicSessionId(subject, topicId, lessonId);
    exercises.forEach((ex, i) => {
      ex.id = `ex-${i + 1}`;
      ex.lessonId = sessionId;
    });

    // Write exercises as markdown
    let md = `# 练习 - ${lessonTitle}\n\n`;
    exercises.forEach((ex, i) => {
      md += `## 第 ${i + 1} 题 (难度 ${'★'.repeat(ex.difficulty)}${'☆'.repeat(5 - ex.difficulty)})\n\n`;
      md += `${ex.prompt}\n\n`;
      if (ex.type === 'multiple-choice') {
        md += `> 请在下方写出你的选择\n\n`;
      } else if (ex.type === 'code') {
        md += '```\n// 请在此处写出你的代码\n```\n\n';
      } else {
        md += `> 请在下方写出你的答案\n\n`;
      }
      md += `---\n\n`;
    });

    const filePath = this.courseManager.getExercisePath(subject, topicId, sessionId);
    await writeMarkdownAndPreview(filePath, md);

    // Save exercises JSON alongside
    const jsonPath = this.courseManager.getExerciseJsonPath(subject, topicId, sessionId);
    await writeText(jsonPath, JSON.stringify(exercises, null, 2));
    await this.courseManager.syncLessonStatus(subject, topicId, lessonId);

    return { exercises, filePath };
  }

  private computeAdaptiveDifficulty(requestedDifficulty: number, ctx: GenerationContext): number {
    const base = Number.isFinite(requestedDifficulty) ? Math.round(requestedDifficulty) : 1;
    const clampedBase = Math.max(1, Math.min(5, base));

    const mastery = ctx.chapterProfile?.masteryPercent;
    if (mastery === null || mastery === undefined || !Number.isFinite(mastery)) {
      return clampedBase;
    }

    let next = clampedBase;
    if (mastery < 50) {
      next = clampedBase - 1;
    } else if (mastery <= 70) {
      next = clampedBase;
    } else if (mastery <= 85) {
      next = clampedBase + 1;
    } else {
      next = clampedBase + 2;
    }

    return Math.max(1, Math.min(5, next));
  }

  private injectWrongQuestionContext(
    ctx: GenerationContext,
    wrongQuestions: WrongQuestion[],
    heading: string
  ): GenerationContext {
    if (wrongQuestions.length === 0) {
      return ctx;
    }

    const truncate = (text: string, max: number): string => {
      const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
      return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
    };

    const lines = wrongQuestions.map((q, idx) => {
      const promptSnippet = truncate(q.prompt, 80);
      const weaknessText = (q.weaknesses ?? []).filter(Boolean).join('、') || '未标注';
      const feedbackSnippet = truncate(q.feedback ?? '', 100);
      return `- 题${idx + 1}：${promptSnippet}。薄弱点：${weaknessText}。AI 反馈：${feedbackSnippet}`;
    });

    const block = `${heading}：\n${lines.join('\n')}`;
    const existing = (ctx.profileEvidenceSummary ?? '').trim();
    const merged = existing ? `${existing}\n\n${block}` : block;

    return {
      ...ctx,
      profileEvidenceSummary: merged,
    };
  }

  private async persistOutline(
    subject: Subject,
    outlineData: Pick<CourseOutline, 'id' | 'subject' | 'title' | 'topics' | 'createdAt'>,
    previousOutline?: CourseOutline
  ): Promise<CourseOutline> {
    const cleanedOutlineData = this.sanitizeOutlineData(subject, outlineData);
    const outline: CourseOutline = this.courseManager.normalizeOutline(subject, {
      id: cleanedOutlineData.id,
      subject,
      title: cleanedOutlineData.title,
      topics: cleanedOutlineData.topics.map(topic => ({
        ...topic,
        lessons: topic.lessons.map(lesson => {
          const previous = this.findMatchingLesson(previousOutline, topic.id, topic.title, lesson.id, lesson.title);
          return {
            ...lesson,
            status: previous?.status ?? 'not-started',
            filePath: this.courseManager.getLessonPath(subject, topic.id, lesson.id),
          };
        }),
      })),
      createdAt: cleanedOutlineData.createdAt,
    });

    await this.courseManager.saveCourseOutline(subject, outline);

    const summaryMd = buildCourseSummaryMd(outline.title, outline.topics);
    await writeMarkdownAndPreview(this.courseManager.getCourseSummaryPath(subject), summaryMd);

    return outline;
  }

  private buildPreviewOutline(
    subject: Subject,
    outlineData: Pick<CourseOutline, 'id' | 'subject' | 'title' | 'topics' | 'createdAt'>,
  ): CourseOutline {
    const cleanedOutlineData = this.sanitizeOutlineData(subject, outlineData);
    return this.courseManager.normalizeOutline(subject, {
      id: cleanedOutlineData.id,
      subject,
      title: cleanedOutlineData.title,
      topics: cleanedOutlineData.topics.map((topic) => this.prepareExistingTopicForPreview(topic)),
      createdAt: cleanedOutlineData.createdAt,
    });
  }

  private prepareExistingTopicForPreview(topic: TopicOutline): TopicOutline {
    return {
      ...topic,
      id: '',
      code: undefined,
      chapterNumber: undefined,
      slug: undefined,
      lessons: (topic.lessons ?? []).map((lesson) => ({
        ...lesson,
        id: '',
        code: undefined,
        chapterNumber: undefined,
        lessonNumber: undefined,
        slug: undefined,
        filePath: '',
      })),
    };
  }

  private prepareGeneratedTopicForPreview(topic: TopicOutline): TopicOutline {
    return {
      ...topic,
      id: '',
      code: undefined,
      chapterNumber: undefined,
      slug: undefined,
      lessons: (topic.lessons ?? []).map((lesson) => ({
        ...lesson,
        id: '',
        code: undefined,
        chapterNumber: undefined,
        lessonNumber: undefined,
        slug: undefined,
        status: lesson.status ?? 'not-started',
        filePath: '',
      })),
    };
  }

  private sanitizeOutlineData(
    subject: Subject,
    outlineData: Pick<CourseOutline, 'id' | 'subject' | 'title' | 'topics' | 'createdAt'>,
  ): Pick<CourseOutline, 'id' | 'subject' | 'title' | 'topics' | 'createdAt'> {
    const cleanCourseTitle = this.sanitizeOutlineTitle(
      outlineData.title,
      this.sanitizeOutlineTitle(subjectLabel(subject), '课程大纲', 12),
      12,
    );

    const cleanTopics = (outlineData.topics ?? []).map((topic, topicIndex) => ({
      ...topic,
      title: this.sanitizeOutlineTitle(topic.title, `主题${this.toChineseNumber(topicIndex + 1)}`, 18),
      lessons: (topic.lessons ?? []).map((lesson, lessonIndex) => ({
        ...lesson,
        title: this.sanitizeOutlineTitle(lesson.title, `课时${this.toChineseNumber(lessonIndex + 1)}`, 22),
        difficulty: this.normalizeDifficulty(lesson.difficulty, Math.min(5, topicIndex + 1)),
      })),
    }));

    return {
      ...outlineData,
      title: cleanCourseTitle,
      topics: cleanTopics,
    };
  }

  private assertOutlinePayload(
    data: { title?: string; topics?: CourseOutline['topics'] | null },
    label: string,
  ): void {
    const topics = Array.isArray(data.topics) ? data.topics : [];
    if (topics.length === 0) {
      throw new Error(`${label}为空：模型没有返回任何主题。请重试，或切换到更稳定的 API 提供方。`);
    }

    const invalidTopicIndex = topics.findIndex((topic) => {
      const lessons = Array.isArray(topic?.lessons) ? topic.lessons : [];
      return lessons.length === 0;
    });
    if (invalidTopicIndex >= 0) {
      throw new Error(`${label}不完整：第 ${invalidTopicIndex + 1} 个主题没有任何课时。请重试。`);
    }
  }

  private sanitizeOutlineTitle(raw: string, fallback: string, maxChars: number): string {
    const text = String(raw ?? '');
    const noMath = text
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/\$[^$\n]+\$/g, ' ')
      .replace(/\\[a-zA-Z]+(?:\s*\{[^}]*\})*/g, ' ')
      .replace(/[A-Za-z0-9]+/g, ' ');
    const chineseOnly = (noMath.match(/[\u4e00-\u9fff]+/g) ?? []).join('');
    const cleaned = chineseOnly.slice(0, maxChars).trim();
    return cleaned || fallback;
  }

  private normalizeDifficulty(value: number, fallback: number): number {
    const numeric = Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.max(1, Math.min(5, numeric));
  }

  private toChineseNumber(value: number): string {
    const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (value <= 10) {
      return value === 10 ? '十' : digits[value] ?? '十';
    }
    if (value < 20) {
      return `十${digits[value - 10]}`;
    }
    if (value < 100) {
      const tens = Math.floor(value / 10);
      const ones = value % 10;
      return `${digits[tens]}十${ones ? digits[ones] : ''}`;
    }
    return '多';
  }

  private findMatchingLesson(
    previousOutline: CourseOutline | undefined,
    topicId: string,
    topicTitle: string,
    lessonId: string,
    lessonTitle: string
  ) {
    if (!previousOutline) {
      return null;
    }

    for (const topic of previousOutline.topics) {
      const sameTopic = topic.id === topicId || topic.title === topicTitle;
      if (!sameTopic) {
        continue;
      }

      const lesson = topic.lessons.find(item => item.id === lessonId || item.title === lessonTitle);
      if (lesson) {
        return lesson;
      }
    }

    for (const topic of previousOutline.topics) {
      const lesson = topic.lessons.find(item => item.id === lessonId || item.title === lessonTitle);
      if (lesson) {
        return lesson;
      }
    }

    return null;
  }
}
