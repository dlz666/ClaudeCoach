import { AIClient } from '../ai/client';
import {
  strictCourseOutlinePrompt,
  strictFullRebuildCourseOutlinePrompt,
  strictPartialRebuildCourseOutlinePrompt,
  strictRebuildCourseOutlinePrompt,
  refineCoursePreviewPrompt,
  lessonPrompt,
  exercisePrompt,
  keyPointsPrompt,
} from '../ai/prompts';
import {
  CourseOutline,
  Subject,
  Exercise,
  KeyPointItem,
  LearningPreferences,
  LatestDiagnosis,
  OutlineRebuildSelection,
  StudentProfile,
  CourseProfile,
  CourseProfileChapter,
  TopicOutline,
  WrongQuestion,
  CourseTag,
  COURSE_TAG_PLAYBOOK,
  subjectLabel,
} from '../types';
import { CourseManager } from './courseManager';
import { readJson, writeText } from '../utils/fileSystem';
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
  /**
   * 创建课程时用户附带的额外说明 / 重点 / 限制（如"按 OpenAI Cookbook 顺序"、
   * "跳过历史背景"）。仅 generateCourse 用，注入到 outline 生成 prompt 末尾。
   */
  creationInstruction?: string;
  /** 学习目标（key field）：完成课程后想能做到什么。 */
  learningGoal?: string;
  /** 已有基础：用户表明自己已会的部分，AI 跳过。 */
  existingKnowledge?: string;
  /** 大纲规模偏好：决定 topic / lesson 颗粒度。ai-decide = 不约束。 */
  outlineSize?: 'ai-decide' | 'quick' | 'half-semester' | 'full-semester';
  /** 偏重风格（多选）：practice / theory / drill / intuition。 */
  styleEmphasis?: Array<'practice' | 'theory' | 'drill' | 'intuition'>;
  /**
   * 连胜/连败信号：从 AdaptiveTriggerState 来，让难度调节立刻反应近期表现。
   * 比 masteryPercent 更灵敏（≥1 grade 就有信号，无需等 ≥2）。
   */
  streak?: number;
  streakDirection?: 'up' | 'down' | null;

  /**
   * 单 lesson session 内最近 grade 的分数序列（最多 5 条）。
   * 流式难度核心信号：批量出题完成后，"再出一题"时最敏感的指标——
   * 不依赖 chapter mastery，直接用刚做完几道的平均分调下一道。
   */
  recentSessionScores?: number[];
  /**
   * 当前 lesson 的知识点清单（仅讲义生成时由 SidebarProvider 读出注入）。
   * lessonPrompt 拿到后会把"必讲清单"放进 system prompt，治标准学科讲义不全面问题。
   */
  lessonKeyPoints?: import('../types').LessonKeyPoints | null;
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
    const data = await this.ai.chatJson<{
      title: string;
      topics: CourseOutline['topics'];
      projects?: import('../types').CourseProjectProposal[];
    }>(messages);
    this.assertOutlinePayload(data, '课程大纲');

    // 注意：preview/refine 流程**不**走 persistOutline。我们这里依然返回完整 outline
    // 但调用方（SidebarProvider._generateCoursePreview）会在 preview cache 里持有，
    // 只有用户点 apply 才落盘。为了兼容老流程（如果还有直接调 generateCourse 的，
    // 必须保留 persistOutline 行为）—— 但目前已经没有了，所有路径都走 preview。
    // 这里改成 not persist，让 preview 流程不会污染磁盘。
    return {
      id: `course-${subject}-${Date.now()}`,
      subject,
      title: data.title,
      topics: this.normalizeTopicIds(data.topics),
      createdAt: new Date().toISOString(),
      projects: Array.isArray(data.projects) ? this.normalizeProjects(data.projects) : undefined,
    };
  }

  /**
   * 基于一份预览 outline + 用户修改指令，重新生成 outline（不写盘）。
   * 给 SidebarProvider 的 preview/refine 流程用。
   */
  async refineCoursePreview(
    subject: Subject,
    currentPreview: CourseOutline,
    refineInstruction: string,
    ctx: GenerationContext,
  ): Promise<CourseOutline> {
    const messages = refineCoursePreviewPrompt({
      subject,
      currentPreview,
      refineInstruction,
      ctx,
    });
    const data = await this.ai.chatJson<{
      title: string;
      topics: CourseOutline['topics'];
      projects?: import('../types').CourseProjectProposal[];
    }>(messages);
    this.assertOutlinePayload(data, '修订大纲');
    return {
      id: currentPreview.id,
      subject,
      title: data.title,
      topics: this.normalizeTopicIds(data.topics),
      createdAt: currentPreview.createdAt,
      tags: currentPreview.tags,
      projects: Array.isArray(data.projects) ? this.normalizeProjects(data.projects) : undefined,
    };
  }

  /** AI 给的 topic id 可能不规则，确保是 stable string；不动 lesson id（lesson 会在 persist 时打 code）。 */
  private normalizeTopicIds(topics: any[]): CourseOutline['topics'] {
    return (topics || []).map((t, i) => ({
      ...t,
      id: typeof t?.id === 'string' && t.id ? t.id : `topic-${String(i + 1).padStart(2, '0')}`,
      lessons: Array.isArray(t?.lessons) ? t.lessons : [],
    }));
  }

  /** 校验并规整 projects 数组：补 id、限定 difficulty 范围、过滤空标题。 */
  private normalizeProjects(projects: any[]): import('../types').CourseProjectProposal[] {
    return (projects || [])
      .map((p, i) => {
        const capstoneRaw = Number(p?.capstoneChapter);
        // capstoneChapter：必须是正整数（1-based 章序号）；允许超过章总数（表示"学完整个课程后做"）。
        // 非 number / NaN / ≤0 一律丢弃，前端按"未标注"处理。
        const capstoneChapter = Number.isFinite(capstoneRaw) && capstoneRaw >= 1
          ? Math.floor(capstoneRaw)
          : undefined;
        return {
          id: typeof p?.id === 'string' && p.id ? p.id : `proposal-${String(i + 1).padStart(2, '0')}`,
          title: typeof p?.title === 'string' ? p.title : '',
          description: typeof p?.description === 'string' ? p.description : '',
          learningGoals: Array.isArray(p?.learningGoals) ? p.learningGoals.filter((g: any) => typeof g === 'string') : [],
          difficulty: typeof p?.difficulty === 'number' ? Math.max(1, Math.min(5, Math.floor(p.difficulty))) : 3,
          suggestedTechStack: Array.isArray(p?.suggestedTechStack)
            ? p.suggestedTechStack.filter((s: any) => typeof s === 'string')
            : [],
          ...(capstoneChapter ? { capstoneChapter } : {}),
        };
      })
      .filter((p) => p.title.trim().length > 0);
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
    // 讲义是长输出（典型 8000-15000 tokens），不传 maxTokens 走默认 4096 会被截断。
    // 16000 兼顾 GPT-4o (max_output=16384) 和 Claude 4 (max_output=64000)，对超出
    // 的模型 API 一般会自动 cap 而非报错。
    const content = await this.ai.chatCompletion(messages, { maxTokens: 16000 });

    const filePath = this.courseManager.getLessonPath(subject, topicId, lessonId);
    await writeMarkdownAndPreview(filePath, content);
    await this.courseManager.syncLessonStatus(subject, topicId, lessonId);

    return filePath;
  }

  /**
   * 一次性为一个 topic 内的所有 lessons 生成初始知识点清单（AI 调用一次）。
   * 写入每个 lesson 对应的 .keypoints.json。已有的会被覆盖（用户重新生成时）。
   *
   * 用于讲义对齐标准学科考纲 —— 用户在生成讲义前先用这个把每节的知识点
   * 框架建好，再到前端微调 / 标 ⭐ / 加备注，最后讲义生成时会按这个清单展开。
   */
  async generateTopicKeyPoints(
    subject: Subject,
    topicId: string,
    ctx: GenerationContext,
  ): Promise<{ generated: number; lessons: Array<{ lessonId: string; count: number }> }> {
    const outline = await this.courseManager.getCourseOutline(subject);
    if (!outline) throw new Error('找不到课程大纲');
    const topic = outline.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`找不到 topic: ${topicId}`);
    if (!topic.lessons.length) return { generated: 0, lessons: [] };

    const lessonsForPrompt = topic.lessons.map(l => ({ id: l.id, title: l.title }));
    const messages = keyPointsPrompt(subject, topic.title, lessonsForPrompt, ctx);
    // chatJson 会自动剥代码围栏 + 容错 → 直接拿数组
    const raw = await this.ai.chatJson<Array<{ lessonId: string; items: KeyPointItem[] }>>(
      messages,
      { temperature: 0.3, maxTokens: 8000 },
    );

    const now = new Date().toISOString();
    const results: Array<{ lessonId: string; count: number }> = [];
    for (const block of raw ?? []) {
      if (!block?.lessonId || !Array.isArray(block?.items)) continue;
      // 合法化每个 item（防 AI 输出脏字段）
      const items: KeyPointItem[] = block.items
        .filter(it => it && typeof it.id === 'string' && typeof it.title === 'string')
        .map((it, i) => ({
          id: it.id,
          title: String(it.title).trim(),
          parentId: it.parentId ?? null,
          order: Number.isFinite(it.order) ? Number(it.order) : i,
          core: !!it.core,
          note: typeof it.note === 'string' && it.note.trim() ? it.note.trim() : undefined,
        }));
      if (!items.length) continue;
      await this.courseManager.writeKeyPoints(subject, topicId, block.lessonId, {
        lessonId: block.lessonId,
        version: 1,
        generatedAt: now,
        items,
      });
      results.push({ lessonId: block.lessonId, count: items.length });
    }
    return { generated: results.length, lessons: results };
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
    const enrichedCtxBase = focused.length > 0
      ? this.injectWrongQuestionContext(ctx, focused, '最近错题与对应薄弱点（请出题时覆盖这些考点的"变体"，不要照抄题面）')
      : ctx;

    // 课程教学法 tag 的 defaultExerciseMix 覆盖用户全局 exerciseTypeMix
    // （tag 是课程级硬约束，应胜过用户的"通用偏好"）
    const enrichedCtx = this.applyTagExerciseMix(enrichedCtxBase);
    const sessionId = await this.courseManager.getDeterministicSessionId(subject, topicId, lessonId);
    const previousExercises = await readJson<Exercise[]>(
      this.courseManager.getExerciseJsonPath(subject, topicId, sessionId),
    );
    const previousPromptBlock = (previousExercises ?? [])
      .slice(0, 8)
      .map((exercise, index) => `${index + 1}. ${(exercise.prompt || '').replace(/\s+/g, ' ').slice(0, 140)}`)
      .filter((line) => line.length > 3)
      .join('\n');
    const historyAwareCtx = previousPromptBlock
      ? {
          ...enrichedCtx,
          profileEvidenceSummary: [
            enrichedCtx.profileEvidenceSummary,
            `本课时上一题组如下。新题不得与其同构，不得只替换数字、变量、名词或背景：\n${previousPromptBlock}`,
          ].filter(Boolean).join('\n\n'),
        }
      : enrichedCtx;

    const messages = exercisePrompt(subject, lessonTitle, count, adaptiveDifficulty, historyAwareCtx);
    const generated = await this.ai.chatJson<Exercise[]>(messages);
    const seenPrompts = new Set<string>();
    const allowedTypes = new Set<Exercise['type']>(['free-response', 'multiple-choice', 'code']);
    const allowedIntents = new Set<NonNullable<Exercise['intent']>>(['retrieval', 'explain', 'predict', 'debug', 'transfer', 'synthesis']);
    const exercises = (Array.isArray(generated) ? generated : [])
      .filter((exercise) => exercise && typeof exercise.prompt === 'string' && exercise.prompt.trim().length >= 8)
      .map((exercise) => {
        const normalizedPrompt = exercise.prompt.replace(/\s+/g, ' ').trim();
        const options = Array.isArray(exercise.options)
          ? exercise.options.map((item) => String(item).trim()).filter(Boolean).slice(0, 6)
          : [];
        const type = allowedTypes.has(exercise.type) ? exercise.type : 'free-response';
        const finalType: Exercise['type'] = type === 'multiple-choice' && options.length < 2 ? 'free-response' : type;
        return {
          ...exercise,
          prompt: exercise.prompt.trim(),
          type: finalType,
          difficulty: Math.max(1, Math.min(5, Math.round(Number(exercise.difficulty) || adaptiveDifficulty))),
          intent: allowedIntents.has(exercise.intent as NonNullable<Exercise['intent']>) ? exercise.intent : 'transfer',
          estimatedMinutes: Math.max(2, Math.min(15, Math.round(Number(exercise.estimatedMinutes) || 5))),
          options: finalType === 'multiple-choice' ? options : [],
          hints: Array.isArray(exercise.hints) ? exercise.hints.map((item) => String(item).trim()).filter(Boolean).slice(0, 2) : [],
          evaluationCriteria: Array.isArray(exercise.evaluationCriteria)
            ? exercise.evaluationCriteria.map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
            : [],
          starterCode: finalType === 'code' ? String(exercise.starterCode || '') : '',
          language: finalType === 'code' ? String(exercise.language || '').trim() : '',
          referenceAnswer: String(exercise.referenceAnswer || '').trim(),
          _normalizedPrompt: normalizedPrompt,
        } as Exercise & { _normalizedPrompt: string };
      })
      .filter((exercise) => {
        if (seenPrompts.has(exercise._normalizedPrompt)) return false;
        seenPrompts.add(exercise._normalizedPrompt);
        return true;
      })
      .slice(0, Math.max(1, count))
      .map(({ _normalizedPrompt, ...exercise }) => exercise as Exercise);

    if (exercises.length === 0) {
      throw new Error('AI 未生成可用练习题：题目为空、过短或格式无效');
    }

    // Assign lesson IDs. 强制按位置规范化为 `ex-${i+1}`，不保留 AI 可能给的 `ex-01` 等格式，
    // 否则前端"## 第 N 题"解析出的 `ex-N` 与后端 id 对不上，submitAllAnswers 会全部跳过。
    const generationId = `gen-${Date.now().toString(36)}`;
    const validWrongQuestionIds = new Set(focused.map((item) => item.id));
    exercises.forEach((ex, i) => {
      ex.id = `ex-${i + 1}`;
      ex.lessonId = sessionId;
      ex.generationId = generationId;
      const declaredSources = Array.isArray(ex.sourceWrongQuestionIds) ? ex.sourceWrongQuestionIds : [];
      ex.sourceWrongQuestionIds = Array.from(new Set(
        declaredSources.filter((id) => validWrongQuestionIds.has(id))
      ));
    });

    // Write exercises as markdown
    let md = `# 练习 - ${lessonTitle}\n\n`;
    exercises.forEach((ex, i) => {
      md += `## 第 ${i + 1} 题 (难度 ${'★'.repeat(ex.difficulty)}${'☆'.repeat(5 - ex.difficulty)})\n\n`;
      md += `${ex.prompt}\n\n`;
      if (ex.type === 'multiple-choice') {
        if (ex.options?.length) {
          md += `${ex.options.map((option, optionIndex) => `${String.fromCharCode(65 + optionIndex)}. ${option}`).join('\n')}\n\n`;
        }
        md += `> 请在下方写出你的选择\n\n`;
      } else if (ex.type === 'code') {
        md += `\`\`\`${ex.language || ''}\n${ex.starterCode || '// 请在此处写出你的代码'}\n\`\`\`\n\n`;
      } else {
        md += `> 请在下方写出你的答案\n\n`;
      }
      if (ex.hints?.length) {
        ex.hints.forEach((hint, hintIndex) => {
          md += `<details><summary>提示 ${hintIndex + 1}</summary>\n\n${hint}\n\n</details>\n\n`;
        });
      }
      md += `---\n\n`;
    });

    const filePath = this.courseManager.getExercisePath(subject, topicId, sessionId);
    await this.courseManager.archiveExerciseSession(subject, topicId, sessionId, 'regenerate');
    await writeMarkdownAndPreview(filePath, md);

    // Save exercises JSON alongside
    const jsonPath = this.courseManager.getExerciseJsonPath(subject, topicId, sessionId);
    await writeText(jsonPath, JSON.stringify(exercises, null, 2));
    await this.courseManager.syncLessonStatus(subject, topicId, lessonId);

    return { exercises, filePath };
  }

  /**
   * 课程教学法 tag 的 defaultExerciseMix 覆盖用户的 aiStyle.exerciseTypeMix。
   * 多 tag 时取所有 tag 的 mix 平均。tag 没有指定 mix 时不覆盖。
   * 这是"课程级硬约束 > 用户全局偏好"的体现。
   */
  private applyTagExerciseMix(ctx: GenerationContext): GenerationContext {
    const tags = (ctx.courseTags ?? []).filter(Boolean) as CourseTag[];
    if (tags.length === 0) return ctx;

    const mixes = tags
      .map((tag) => COURSE_TAG_PLAYBOOK[tag]?.defaultExerciseMix)
      .filter(Boolean) as Array<NonNullable<typeof COURSE_TAG_PLAYBOOK[CourseTag]['defaultExerciseMix']>>;
    if (mixes.length === 0) return ctx;

    const avg = {
      multipleChoice: Math.round(mixes.reduce((s, m) => s + m.multipleChoice, 0) / mixes.length),
      freeResponse: Math.round(mixes.reduce((s, m) => s + m.freeResponse, 0) / mixes.length),
      code: Math.round(mixes.reduce((s, m) => s + m.code, 0) / mixes.length),
    };

    // 深拷贝 prefs 避免污染调用方的 ctx.preferences
    const prefs: LearningPreferences | null | undefined = ctx.preferences;
    if (!prefs) return ctx;

    const overriddenPrefs: LearningPreferences = {
      ...prefs,
      aiStyle: {
        ...(prefs.aiStyle ?? {}),
        exerciseTypeMix: avg,
      },
    };
    return { ...ctx, preferences: overriddenPrefs };
  }

  /**
   * 根据 mastery + streak 综合调整难度：
   * - mastery 主信号（5 段映射）：< 50 → -1；50-70 → 0；70-85 → +1；> 85 → +2
   * - streak 辅信号（≥2 即触发，加快收敛）：连对 ≥3 → +1；连错 ≥3 → -2；
   *   连对 2 → +0.5；连错 2 → -1（用 round 后取整）
   * - 没有 mastery 也没有 streak → 用 base
   * - 同时存在：取主信号后再用 streak 调整 ±1（让 streak 不会反向打主信号）
   * 最终 clamp 到 [1, 5]。
   */
  private computeAdaptiveDifficulty(requestedDifficulty: number, ctx: GenerationContext): number {
    const base = Number.isFinite(requestedDifficulty) ? Math.round(requestedDifficulty) : 1;
    const clampedBase = Math.max(1, Math.min(5, base));

    const mastery = ctx.chapterProfile?.masteryPercent;
    let masteryDelta = 0;
    if (typeof mastery === 'number' && Number.isFinite(mastery)) {
      if (mastery < 50) masteryDelta = -1;
      else if (mastery <= 70) masteryDelta = 0;
      else if (mastery <= 85) masteryDelta = +1;
      else masteryDelta = +2;
    }

    let streakDelta = 0;
    const streak = ctx.streak ?? 0;
    const dir = ctx.streakDirection ?? null;
    if (streak >= 2 && dir === 'up') {
      streakDelta = streak >= 3 ? +1 : 0; // 连对 3 才升一档
    } else if (streak >= 2 && dir === 'down') {
      streakDelta = streak >= 3 ? -2 : -1; // 连错 2 已减，3 减 2
    }

    // 流式难度信号：刚答完几道的 session 均分，最敏感
    // 高分（>=85）→ +1；低分（<=50）→ -1；中段 → 0（避免抖动）
    let sessionDelta = 0;
    if (Array.isArray(ctx.recentSessionScores) && ctx.recentSessionScores.length > 0) {
      const avg = ctx.recentSessionScores.reduce((s, x) => s + x, 0) / ctx.recentSessionScores.length;
      if (avg >= 85) sessionDelta = +1;
      else if (avg <= 50) sessionDelta = -1;
    }

    // 没有任何反馈数据 → 直接 base；session 信号即便单 grade 也立刻生效
    if (mastery === null || mastery === undefined || !Number.isFinite(mastery)) {
      const total = streakDelta + sessionDelta;
      if (total !== 0) {
        return Math.max(1, Math.min(5, clampedBase + total));
      }
      return clampedBase;
    }

    // 三个 delta 合并，但限幅避免单次跳两档以上
    const combinedDelta = Math.max(-2, Math.min(2, masteryDelta + streakDelta + sessionDelta));
    return Math.max(1, Math.min(5, clampedBase + combinedDelta));
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
      return `- 题${idx + 1}：[sourceWrongQuestionId=${q.id}] ${promptSnippet}。薄弱点：${weaknessText}。AI 反馈：${feedbackSnippet}`;
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
      // 附上解析到的实际结构预览，便于判断是"模型真返回空" vs "形状不对/被包了一层"
      // （如 {course:{topics:[]}} 或抢救到内层 lesson 片段 {id,title,difficulty}）。
      const shapePreview = (() => {
        try { return JSON.stringify(data).slice(0, 220); } catch { return String(data).slice(0, 220); }
      })();
      throw new Error(`${label}为空：模型没有返回任何主题。解析到的结构：${shapePreview}。请重试，或切换到更稳定的 API 提供方。`);
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
