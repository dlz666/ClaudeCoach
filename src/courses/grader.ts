import { readFile } from 'fs/promises';
import { AIClient } from '../ai/client';
import { gradePrompt } from '../ai/prompts';
import {
  GradeResult,
  Exercise,
  LearningPreferences,
  LatestDiagnosis,
  StudentProfile,
  Subject,
  CourseProfile,
  CourseProfileChapter,
} from '../types';
import { CourseManager } from './courseManager';
import { writeMarkdown } from '../utils/markdown';
import { CourseProfileStore, normalizeGradeSignals } from '../progress/courseProfileStore';
import {
  loadMisconceptionsForSubject,
  matchMisconceptions,
} from '../progress/misconceptionTemplates';
import { recordPracticeOutcome } from './practiceOutcome';
import { upsertExerciseReviewMarkdown } from './exerciseReviewMarkdown';

interface GradeContext {
  profile?: StudentProfile | null;
  preferences?: LearningPreferences | null;
  diagnosis?: LatestDiagnosis | null;
  courseProfile?: CourseProfile | null;
  chapterProfile?: CourseProfileChapter | null;
  profileEvidenceSummary?: string;
}

export class Grader {
  private ai: AIClient;
  private courseManager: CourseManager;
  private courseProfileStore: CourseProfileStore;

  constructor() {
    this.ai = new AIClient();
    this.courseManager = new CourseManager();
    this.courseProfileStore = new CourseProfileStore();
  }

  async grade(
    exercise: Exercise,
    studentAnswer: string,
    subject: Subject,
    topicId: string,
    sessionId: string,
    ctx: GradeContext,
    meta?: { topicTitle?: string; lessonTitle?: string; lessonId?: string; hintsUsed?: number }
  ): Promise<GradeResult> {
    const messages = gradePrompt(
      exercise.prompt,
      studentAnswer,
      ctx,
      exercise.evaluationCriteria,
      exercise.referenceAnswer,
    );
    const result = await this.ai.chatJson<Omit<GradeResult, 'exerciseId' | 'gradedAt'>>(messages);

    const gradeResult: GradeResult = normalizeGradeSignals({
      ...result,
      exerciseId: exercise.id,
      lessonId: sessionId,
      generationId: exercise.generationId,
      questionPrompt: exercise.prompt,
      studentAnswer,
      hintsUsed: Math.max(0, Number(meta?.hintsUsed) || 0),
      gradedAt: new Date().toISOString(),
    });

    // Misconception 命中检测：扫学生答案 + AI feedback 的组合，命中已知误区
    // 把命中的 misconception shortName 前置到 weaknesses，让用户和 AI 后续都看得见
    const misconceptionLib = loadMisconceptionsForSubject(subject);
    const hits = matchMisconceptions(
      `${studentAnswer}\n${gradeResult.feedback ?? ''}`,
      misconceptionLib,
    );
    if (hits.length > 0) {
      const misconceptionLabels = hits.map((m) => `[误区:${m.id}] ${m.shortName}`);
      gradeResult.weaknesses = [
        ...misconceptionLabels,
        ...(gradeResult.weaknesses ?? []),
      ];
      // 命中误区天然属于 concept 类弱项；并入 weaknessTags 去重
      const tagSet = new Set<import('../types').FeedbackWeaknessTag>(gradeResult.weaknessTags ?? []);
      hits.forEach((h) => tagSet.add(h.tag));
      gradeResult.weaknessTags = Array.from(tagSet);
    }

    // Keep the learner's answer and latest review beside the question in 练习.md.
    // The practice Webview renders gradeResult immediately, while an already-open native
    // Markdown preview refreshes this same file automatically. Do not create or preview a
    // separate feedback.md document.
    const exercisePath = this.courseManager.getExercisePath(subject, topicId, sessionId);
    const exerciseMarkdown = await readFile(exercisePath, 'utf8');
    await writeMarkdown(
      exercisePath,
      upsertExerciseReviewMarkdown(exerciseMarkdown, exercise, gradeResult, studentAnswer),
    );

    // Save structured grade JSON/history for mastery, review scheduling and reopening the room.
    const { historyPath } = await this.courseManager.saveGradeResult(
      subject,
      topicId,
      sessionId,
      gradeResult,
    );

    // Update topic summary
    await this.courseManager.updateTopicSummary(
      subject,
      topicId,
      gradeResult.score,
      gradeResult.weaknesses
    );

    await this.courseProfileStore.recordEvent(subject, {
      id: `grade-${topicId}-${sessionId}-${gradeResult.gradedAt}`,
      type: 'grade',
      subject,
      topicId,
      lessonId: sessionId,
      createdAt: gradeResult.gradedAt,
      summary: `Score ${gradeResult.score}/100. Strengths: ${(gradeResult.strengths ?? []).slice(0, 2).join(', ') || 'none'}. Weaknesses: ${(gradeResult.weaknesses ?? []).slice(0, 3).join(', ') || 'none'}.`,
      weaknessTags: gradeResult.weaknessTags ?? [],
      strengthTags: gradeResult.strengthTags ?? [],
      // 关键：把 AI 推断的"学习风格信号"沉淀进 profile，驱动后续 preferredScaffolding /
      // generationHints / responseHints。修复前这个字段一直是空，导致 5 个聚合字段全死
      preferenceTags: gradeResult.preferenceTags ?? [],
      rawRefs: [historyPath, exercisePath],
      metadata: {
        score: gradeResult.score,
        confidence: gradeResult.confidence ?? 'medium',
      },
    });

    await recordPracticeOutcome(this.courseManager, exercise, studentAnswer, subject, topicId, sessionId, gradeResult, meta);

    return gradeResult;
  }
}
