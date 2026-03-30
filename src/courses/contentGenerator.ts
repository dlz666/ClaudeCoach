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
    ctx: GenerationContext
  ): Promise<string> {
    const messages = lessonPrompt(subject, topicTitle, lessonTitle, difficulty, ctx);
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
    ctx: GenerationContext
  ): Promise<{ exercises: Exercise[]; filePath: string }> {
    const messages = exercisePrompt(subject, lessonTitle, count, difficulty, ctx);
    const exercises = await this.ai.chatJson<Exercise[]>(messages);

    // Assign lesson IDs
    const sessionId = await this.courseManager.getDeterministicSessionId(subject, topicId, lessonId);
    exercises.forEach((ex, i) => {
      ex.id = ex.id || `ex-${i + 1}`;
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
