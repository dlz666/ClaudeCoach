import { AIClient } from '../ai/client';
import { gradePrompt } from '../ai/prompts';
import { GradeResult, Exercise, LearningPreferences, LatestDiagnosis, StudentProfile, Subject } from '../types';
import { CourseManager } from './courseManager';
import { writeJson } from '../utils/fileSystem';
import { writeMarkdownAndPreview } from '../utils/markdown';

interface GradeContext {
  profile?: StudentProfile | null;
  preferences?: LearningPreferences | null;
  diagnosis?: LatestDiagnosis | null;
}

export class Grader {
  private ai: AIClient;
  private courseManager: CourseManager;

  constructor() {
    this.ai = new AIClient();
    this.courseManager = new CourseManager();
  }

  async grade(
    exercise: Exercise,
    studentAnswer: string,
    subject: Subject,
    topicId: string,
    sessionId: string,
    ctx: GradeContext
  ): Promise<GradeResult> {
    const messages = gradePrompt(exercise.prompt, studentAnswer, ctx);
    const result = await this.ai.chatJson<Omit<GradeResult, 'exerciseId' | 'gradedAt'>>(messages);

    const gradeResult: GradeResult = {
      ...result,
      exerciseId: exercise.id,
      gradedAt: new Date().toISOString(),
    };

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

    return gradeResult;
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
