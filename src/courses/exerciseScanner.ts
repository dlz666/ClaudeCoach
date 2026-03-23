import * as fs from 'fs/promises';
import * as path from 'path';
import { AIClient } from '../ai/client';
import { gradePrompt } from '../ai/prompts';
import { Exercise, GradeResult, Subject } from '../types';
import { CourseManager } from './courseManager';
import { readJson, writeText } from '../utils/fileSystem';
import { writeMarkdown } from '../utils/markdown';
import { ProgressStore } from '../progress/progressStore';
import { PreferencesStore } from '../progress/preferencesStore';

const GRADE_MARKER = '> **Score: ';

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

  constructor() {
    this.ai = new AIClient();
    this.courseManager = new CourseManager();
    this.progressStore = new ProgressStore();
    this.prefsStore = new PreferencesStore();
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

      const [preferences, profile] = await Promise.all([
        this.prefsStore.get(),
        this.progressStore.getProfile(),
      ]);

      let updatedMarkdown = markdown;
      let gradedForFile = 0;

      for (const section of pendingSections) {
        const exercise = exercises[section.exerciseIndex];

        try {
          const messages = gradePrompt(exercise.prompt, section.answer, {
            profile,
            preferences,
          });
          const result = await this.ai.chatJson<Omit<GradeResult, 'exerciseId' | 'gradedAt'>>(messages);
          const gradeResult: GradeResult = {
            ...result,
            exerciseId: exercise.id,
            gradedAt: new Date().toISOString(),
          };

          updatedMarkdown = this.insertFeedback(updatedMarkdown, section.exerciseIndex, gradeResult);
          await writeText(this.courseManager.getGradePath(subject, topicId, sessionId), JSON.stringify(gradeResult, null, 2));
          await writeMarkdown(this.courseManager.getFeedbackPath(subject, topicId, sessionId), this.buildFeedbackMarkdown(exercise, gradeResult));
          await this.courseManager.updateTopicSummary(subject, topicId, gradeResult.score, gradeResult.weaknesses);
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
      const alreadyGraded = section.includes(GRADE_MARKER);
      let answer = '';

      const answerMatch = section.match(/>\s*(?:.*answer.*|.*choice.*|.*答案.*|.*选项.*)\n([\s\S]*?)(?:\n---|\n##\s|$)/i);
      if (answerMatch) {
        answer = answerMatch[1].trim();
        const markerIndex = answer.indexOf(GRADE_MARKER);
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

  private insertFeedback(markdown: string, exerciseIndex: number, grade: GradeResult): string {
    const parts = markdown.split(/^(##\s+[^\n]+)/m);
    const partIndex = 1 + exerciseIndex * 2;
    if (partIndex + 1 >= parts.length) {
      return markdown;
    }

    let sectionContent = parts[partIndex + 1];
    const feedback = this.buildFeedbackBlock(grade);
    const separatorIndex = sectionContent.lastIndexOf('\n---');

    if (separatorIndex >= 0) {
      sectionContent = sectionContent.slice(0, separatorIndex) + '\n\n' + feedback + sectionContent.slice(separatorIndex);
    } else {
      sectionContent += '\n\n' + feedback;
    }

    parts[partIndex + 1] = sectionContent;
    return parts.join('');
  }

  private buildFeedbackBlock(grade: GradeResult): string {
    let feedback = `${GRADE_MARKER}${grade.score}/100**\n>\n`;
    feedback += `> ${grade.feedback.replace(/\n/g, '\n> ')}\n`;
    if (grade.strengths.length) {
      feedback += `>\n> Strengths: ${grade.strengths.join(', ')}\n`;
    }
    if (grade.weaknesses.length) {
      feedback += `>\n> Weaknesses: ${grade.weaknesses.join(', ')}\n`;
    }
    return feedback;
  }

  private buildFeedbackMarkdown(exercise: Exercise, result: GradeResult): string {
    let markdown = '# Feedback\n\n';
    markdown += `**Score: ${result.score}/100**\n\n`;
    markdown += `## Prompt\n\n${exercise.prompt}\n\n`;
    markdown += `## Detailed Feedback\n\n${result.feedback}\n\n`;
    if (result.strengths.length) {
      markdown += `## Strengths\n\n${result.strengths.map(item => `- ${item}`).join('\n')}\n\n`;
    }
    if (result.weaknesses.length) {
      markdown += `## Weaknesses\n\n${result.weaknesses.map(item => `- ${item}`).join('\n')}\n\n`;
    }
    return markdown;
  }
}
