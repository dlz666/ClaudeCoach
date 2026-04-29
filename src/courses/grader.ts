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
  WrongQuestion,
} from '../types';
import { CourseManager } from './courseManager';
import { writeJson } from '../utils/fileSystem';
import { writeMarkdownAndPreview } from '../utils/markdown';
import { CourseProfileStore, normalizeGradeSignals } from '../progress/courseProfileStore';

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
    meta?: { topicTitle?: string; lessonTitle?: string; lessonId?: string }
  ): Promise<GradeResult> {
    const messages = gradePrompt(exercise.prompt, studentAnswer, ctx);
    const result = await this.ai.chatJson<Omit<GradeResult, 'exerciseId' | 'gradedAt'>>(messages);

    const gradeResult: GradeResult = normalizeGradeSignals({
      ...result,
      exerciseId: exercise.id,
      gradedAt: new Date().toISOString(),
    });

    // Save grade JSON
    const gradePath = this.courseManager.getGradePath(subject, topicId, sessionId);
    await writeJson(gradePath, gradeResult);

    const md = this._buildFeedbackMd(exercise, gradeResult);
    const feedbackPath = this.courseManager.getFeedbackPath(subject, topicId, sessionId);
    await writeMarkdownAndPreview(feedbackPath, md);

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
      rawRefs: [gradePath, feedbackPath],
      metadata: {
        score: gradeResult.score,
        confidence: gradeResult.confidence ?? 'medium',
      },
    });

    await this._maybeUpdateWrongQuestionBook(exercise, studentAnswer, subject, topicId, sessionId, gradeResult, meta);

    return gradeResult;
  }

  private async _maybeUpdateWrongQuestionBook(
    exercise: Exercise,
    studentAnswer: string,
    subject: Subject,
    topicId: string,
    sessionId: string,
    gradeResult: GradeResult,
    meta?: { topicTitle?: string; lessonTitle?: string; lessonId?: string }
  ): Promise<void> {
    const lessonId = meta?.lessonId ?? sessionId;
    const topicTitle = meta?.topicTitle ?? topicId;
    const lessonTitle = meta?.lessonTitle ?? sessionId;
    const wrongId = `wrong-${subject}-${topicId}-${sessionId}-${exercise.id}`;
    const score = Number(gradeResult.score) || 0;
    const weaknesses = gradeResult.weaknesses ?? [];

    const isWrong = score < 60 || weaknesses.length > 0;

    if (isWrong) {
      const wq: WrongQuestion = {
        id: wrongId,
        exerciseId: exercise.id,
        subject,
        topicId,
        topicTitle,
        lessonId,
        lessonTitle,
        prompt: exercise.prompt,
        studentAnswer,
        score,
        feedback: gradeResult.feedback,
        weaknesses,
        weaknessTags: gradeResult.weaknessTags ?? [],
        attempts: 1,
        firstFailedAt: gradeResult.gradedAt,
        lastAttemptedAt: gradeResult.gradedAt,
        resolved: false,
      };
      await this.courseManager.upsertWrongQuestion(subject, wq);
      return;
    }

    if (score >= 90) {
      const existing = await this.courseManager.listWrongQuestions(subject, {
        topicId,
        lessonId,
        onlyUnresolved: true,
      });
      const match = existing.find(q => q.id === wrongId || q.exerciseId === exercise.id);
      if (match) {
        await this.courseManager.resolveWrongQuestion(subject, match.id);
      }
    }
  }

  private _buildFeedbackMd(exercise: Exercise, result: GradeResult): string {
    let md = `# 批改反馈\n\n`;
    md += `**得分：${result.score}/100**\n\n`;
    md += `## 题目\n\n${exercise.prompt}\n\n`;
    md += `## 详细反馈\n\n${result.feedback}\n\n`;
    if (result.strengths.length) {
      md += `## 优点\n\n${result.strengths.map(s => `- ${s}`).join('\n')}\n\n`;
    }
    if (result.weaknesses.length) {
      md += `## 需要改进\n\n${result.weaknesses.map(w => `- ${w}`).join('\n')}\n\n`;
    }
    return md;
  }
}
