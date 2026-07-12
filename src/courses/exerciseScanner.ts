import * as fs from 'fs/promises';
import * as path from 'path';
import { AIClient } from '../ai/client';
import { gradePrompt } from '../ai/prompts';
import { Exercise, GradeResult, Subject } from '../types';
import { CourseManager } from './courseManager';
import { readJson } from '../utils/fileSystem';
import { writeMarkdown } from '../utils/markdown';
import { ProgressStore } from '../progress/progressStore';
import { PreferencesStore } from '../progress/preferencesStore';
import { CourseProfileStore, normalizeGradeSignals } from '../progress/courseProfileStore';
import { recordPracticeOutcome } from './practiceOutcome';
import {
  EXERCISE_REVIEW_SCORE_MARKER,
  upsertExerciseReviewMarkdown,
} from './exerciseReviewMarkdown';

interface ParsedExerciseSection {
  exerciseIndex: number;
  answer: string;
  alreadyGraded: boolean;
}

export class ExerciseScanner {
  private ai: AIClient;
  private courseManager: CourseManager;
  private progressStore: ProgressStore;
  private prefsStore: PreferencesStore;
  private courseProfileStore: CourseProfileStore;

  constructor() {
    this.ai = new AIClient();
    this.courseManager = new CourseManager();
    this.progressStore = new ProgressStore();
    this.prefsStore = new PreferencesStore();
    this.courseProfileStore = new CourseProfileStore();
  }

  async scanAndGradeAll(): Promise<number> {
    const courses = await this.courseManager.getAllCourses();
    let total = 0;

    for (const course of courses) {
      for (const topic of course.topics) {
        total += await this.scanTopic(course.subject, topic.id);
      }
    }

    return total;
  }

  private async scanTopic(subject: Subject, topicId: string): Promise<number> {
    const exerciseFiles = await this.courseManager.getExerciseFiles(subject, topicId);
    let gradedInTopic = 0;

    for (const promptPath of exerciseFiles) {
      const sessionId = path.basename(path.dirname(promptPath));
      const exercises = await readJson<Exercise[]>(this.courseManager.getExerciseJsonPath(subject, topicId, sessionId));
      if (!exercises?.length) {
        continue;
      }

      const markdown = await fs.readFile(promptPath, 'utf-8');
      const sections = this.parseSections(markdown);
      const pendingSections = sections.filter(section =>
        section.answer.trim() &&
        !section.alreadyGraded &&
        section.exerciseIndex < exercises.length
      );

      if (!pendingSections.length) {
        continue;
      }

      const [preferences, profile, courseProfileContext] = await Promise.all([
        this.prefsStore.get(),
        this.progressStore.getProfile(),
        this.courseProfileStore.buildPromptContext(subject, topicId),
      ]);

      let updatedMarkdown = markdown;
      let gradedForFile = 0;

      for (const section of pendingSections) {
        const exercise = exercises[section.exerciseIndex];

        try {
          const messages = gradePrompt(exercise.prompt, section.answer, {
            profile,
            preferences,
            ...courseProfileContext,
          }, exercise.evaluationCriteria, exercise.referenceAnswer);
          const result = await this.ai.chatJson<Omit<GradeResult, 'exerciseId' | 'gradedAt'>>(messages);
          const gradeResult: GradeResult = normalizeGradeSignals({
            ...result,
            exerciseId: exercise.id,
            lessonId: sessionId,
            generationId: exercise.generationId,
            questionPrompt: exercise.prompt,
            studentAnswer: section.answer,
            gradedAt: new Date().toISOString(),
          });

          updatedMarkdown = upsertExerciseReviewMarkdown(
            updatedMarkdown,
            exercise,
            gradeResult,
            section.answer,
          );
          const { historyPath } = await this.courseManager.saveGradeResult(
            subject,
            topicId,
            sessionId,
            gradeResult,
          );
          await this.courseManager.updateTopicSummary(subject, topicId, gradeResult.score, gradeResult.weaknesses);
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
            rawRefs: [historyPath, promptPath],
            metadata: {
              score: gradeResult.score,
              confidence: gradeResult.confidence ?? 'medium',
            },
          });
          await recordPracticeOutcome(
            this.courseManager,
            exercise,
            section.answer,
            subject,
            topicId,
            sessionId,
            gradeResult,
          );
          gradedForFile++;
        } catch (error) {
          console.error(`Grade failed for ${exercise.id}:`, error);
        }
      }

      if (gradedForFile > 0) {
        await writeMarkdown(promptPath, updatedMarkdown);
        await this.progressStore.incrementExercises(gradedForFile);
        gradedInTopic += gradedForFile;
      }
    }

    return gradedInTopic;
  }

  parseSections(markdown: string): ParsedExerciseSection[] {
    const result: ParsedExerciseSection[] = [];
    const parts = markdown.split(/^(##\s+[^\n]+)/m);

    for (let index = 1; index < parts.length; index += 2) {
      const section = (parts[index] || '') + (parts[index + 1] || '');
      const exerciseIndex = result.length;
      const alreadyGraded = section.includes(EXERCISE_REVIEW_SCORE_MARKER);
      let answer = '';

      const answerMatch = section.match(/>\s*(?:.*answer.*|.*choice.*|.*答案.*|.*选项.*)\n([\s\S]*?)(?:\n---|\n##\s|$)/i);
      if (answerMatch) {
        answer = answerMatch[1].trim();
        const markerIndex = answer.indexOf(EXERCISE_REVIEW_SCORE_MARKER);
        if (markerIndex >= 0) {
          answer = answer.slice(0, markerIndex).trim();
        }
      }

      if (!answer) {
        const codeMatch = section.match(/```[^\n]*\n([\s\S]*?)```/);
        if (codeMatch) {
          const code = codeMatch[1].trim();
          if (code && !/write your code here|写出你的代码/i.test(code)) {
            answer = code;
          }
        }
      }

      result.push({ exerciseIndex, answer, alreadyGraded });
    }

    return result;
  }

}
