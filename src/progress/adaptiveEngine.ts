import { AIClient } from '../ai/client';
import { diagnosisPrompt } from '../ai/prompts';
import { LatestDiagnosis, TopicSummary, GradeResult, Subject } from '../types';
import { createBudget, selectHistoryForPrompt } from '../ai/tokenBudget';
import { getAIConfig } from '../config';
import { readJson, writeJson, ensureDir, fileExists } from '../utils/fileSystem';
import { writeMarkdownAndPreview } from '../utils/markdown';
import { ProgressStore } from './progressStore';
import { PreferencesStore } from './preferencesStore';
import { CourseManager } from '../courses/courseManager';
import { getStoragePathResolver } from '../storage/pathResolver';
import { CourseProfileStore, inferWeaknessTagsFromTexts } from './courseProfileStore';

export class AdaptiveEngine {
  private ai: AIClient;
  private progressStore: ProgressStore;
  private prefsStore: PreferencesStore;
  private courseManager: CourseManager;
  private courseProfileStore: CourseProfileStore;
  private paths = getStoragePathResolver();

  constructor() {
    this.ai = new AIClient();
    this.progressStore = new ProgressStore();
    this.prefsStore = new PreferencesStore();
    this.courseManager = new CourseManager();
    this.courseProfileStore = new CourseProfileStore();
  }

  private get diagnosisDir(): string {
    return this.paths.diagnosticsDir;
  }

  private get latestPath(): string {
    return this.paths.diagnosisLatestPath;
  }

  private getLatestPath(subject?: Subject): string {
    return subject ? this.paths.diagnosisLatestPathForSubject(subject) : this.latestPath;
  }

  private getHistoryDir(subject?: Subject): string {
    return subject ? this.paths.diagnosisHistoryDirForSubject(subject) : this.paths.diagnosisHistoryDir;
  }

  private getReportPath(subject?: Subject): string {
    return subject ? this.paths.diagnosisReportPathForSubject(subject) : this.paths.diagnosisReportPath;
  }

  private _buildSubjectScopedDiagnosis(source: LatestDiagnosis, subject: Subject): LatestDiagnosis | null {
    const snapshots = Array.isArray(source.subjectSnapshots) ? source.subjectSnapshots : [];
    const matched = snapshots.find((snapshot) => snapshot.subject === subject);
    if (!matched) {
      return null;
    }

    return {
      updatedAt: source.updatedAt,
      subject,
      subjectSnapshots: [{ ...matched, subject }],
      overallStrategy: source.overallStrategy || '',
      nextSteps: Array.isArray(source.nextSteps) ? source.nextSteps : [],
    };
  }

  private _normalizeDiagnosis(result: Omit<LatestDiagnosis, 'updatedAt'>, subject: Subject): LatestDiagnosis {
    const snapshots = Array.isArray(result.subjectSnapshots) ? result.subjectSnapshots : [];
    const matched = snapshots.find((snapshot) => snapshot?.subject === subject) ?? snapshots[0];
    const normalizedSnapshot: LatestDiagnosis['subjectSnapshots'][number] = {
      subject,
      mastery: Math.max(0, Math.min(100, Number(matched?.mastery) || 0)),
      recentTrend: matched?.recentTrend === 'improving' || matched?.recentTrend === 'declining' ? matched.recentTrend : 'stable',
      topStrengths: Array.isArray(matched?.topStrengths) ? matched.topStrengths.filter(Boolean) : [],
      topWeaknesses: Array.isArray(matched?.topWeaknesses) ? matched.topWeaknesses.filter(Boolean) : [],
      keyMistakePatterns: Array.isArray(matched?.keyMistakePatterns) ? matched.keyMistakePatterns.filter(Boolean) : [],
      recommendedFocus: matched?.recommendedFocus || '',
    };

    return {
      updatedAt: new Date().toISOString(),
      subject,
      subjectSnapshots: [normalizedSnapshot],
      overallStrategy: result.overallStrategy || '',
      nextSteps: Array.isArray(result.nextSteps) ? result.nextSteps.filter(Boolean) : [],
    };
  }

  private async _resolveDiagnosisTopicId(subject: Subject, diagnosis: LatestDiagnosis): Promise<string | null> {
    const outline = await this.courseManager.getCourseOutline(subject);
    const snapshot = diagnosis.subjectSnapshots[0];
    if (!outline || !snapshot) {
      return null;
    }

    const focusText = [
      snapshot.recommendedFocus,
      ...snapshot.topWeaknesses,
      ...snapshot.keyMistakePatterns,
    ].join(' ').toLowerCase();

    let bestMatch: { topicId: string; score: number } | null = null;
    for (const topic of outline.topics) {
      const title = topic.title.toLowerCase();
      const score = title && focusText.includes(title) ? title.length : 0;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { topicId: topic.id, score };
      }
    }

    return bestMatch && bestMatch.score > 0 ? bestMatch.topicId : null;
  }

  async getLatestDiagnosis(subject?: Subject): Promise<LatestDiagnosis | null> {
    const latest = await readJson<LatestDiagnosis>(this.getLatestPath(subject));
    if (latest) {
      return latest;
    }

    if (!subject) {
      return readJson<LatestDiagnosis>(this.latestPath);
    }

    const globalLatest = await readJson<LatestDiagnosis>(this.latestPath);
    if (!globalLatest) {
      return null;
    }

    return this._buildSubjectScopedDiagnosis(globalLatest, subject);
  }

  /** Collect topic summaries for the requested subject scope */
  private async collectSummaries(subject?: Subject): Promise<TopicSummary[]> {
    const summaries: TopicSummary[] = [];

    for (const course of await this.courseManager.getAllCourses()) {
      if (subject && course.subject !== subject) {
        continue;
      }
      for (const topic of course.topics) {
        const summary = await this.courseManager.getTopicSummary(course.subject, topic.id);
        if (summary) {
          summaries.push(summary);
        }
      }
    }

    return summaries;
  }

  /** Collect recent grade results for the requested subject scope */
  private async collectRecentGrades(limit: number, subject?: Subject): Promise<GradeResult[]> {
    const allGrades: GradeResult[] = [];

    for (const course of await this.courseManager.getAllCourses()) {
      if (subject && course.subject !== subject) {
        continue;
      }
      for (const topic of course.topics) {
        for (const lesson of topic.lessons) {
          const gradePath = this.courseManager.getGradePath(course.subject, topic.id, lesson.id);
          if (!await fileExists(gradePath)) {
            continue;
          }

          const grade = await readJson<GradeResult>(gradePath);
          if (grade) {
            allGrades.push(grade);
          }
        }
      }
    }

    // Sort by date, most recent first
    allGrades.sort((a, b) => b.gradedAt.localeCompare(a.gradedAt));
    return allGrades.slice(0, limit);
  }

  /** Run AI-powered diagnosis for a single subject */
  async runDiagnosis(subject: Subject): Promise<LatestDiagnosis> {
    await this.courseManager.syncLessonStatuses(subject);

    const [profile, prefs, prevDiagnosis, summaries, grades, courseProfileContext] = await Promise.all([
      this.progressStore.getProfile(),
      this.prefsStore.get(),
      this.getLatestDiagnosis(subject),
      this.collectSummaries(subject),
      this.collectRecentGrades(50, subject),
      this.courseProfileStore.buildPromptContext(subject),
    ]);

    // Use token budget to select what fits
    const config = await getAIConfig();
    const fixedText = JSON.stringify(profile) + JSON.stringify(prefs) + JSON.stringify(prevDiagnosis ?? {});
    const budget = createBudget(config.contextWindow, fixedText);
    const { summariesText, gradesText } = selectHistoryForPrompt(budget, summaries, grades);

    const messages = diagnosisPrompt(subject, summariesText, gradesText, {
      profile,
      preferences: prefs,
      diagnosis: prevDiagnosis,
      ...courseProfileContext,
    });

    const result = await this.ai.chatJson<Omit<LatestDiagnosis, 'updatedAt'>>(messages);
    const diagnosis = this._normalizeDiagnosis(result, subject);

    // Archive previous diagnosis
    await ensureDir(this.getHistoryDir(subject));
    if (prevDiagnosis) {
      const archivePath = `${this.getHistoryDir(subject)}/${prevDiagnosis.updatedAt.slice(0, 10)}.json`;
      await writeJson(archivePath, prevDiagnosis);
    }

    // Save new latest
    await writeJson(this.getLatestPath(subject), diagnosis);

    const snapshot = diagnosis.subjectSnapshots[0];
    const topicId = await this._resolveDiagnosisTopicId(subject, diagnosis);
    await this.courseProfileStore.recordEvent(subject, {
      id: `diagnosis-${subject}-${diagnosis.updatedAt}`,
      type: 'diagnosis',
      subject,
      topicId,
      lessonId: null,
      createdAt: diagnosis.updatedAt,
      summary: `Focus: ${snapshot?.recommendedFocus || diagnosis.overallStrategy || 'none'}. Evidence: ${summaries.length} topic summaries, ${grades.length} grades.`,
      weaknessTags: inferWeaknessTagsFromTexts([
        ...(snapshot?.topWeaknesses ?? []),
        ...(snapshot?.keyMistakePatterns ?? []),
        snapshot?.recommendedFocus ?? '',
      ]),
      strengthTags: [],
      rawRefs: [this.getLatestPath(subject)],
      metadata: {
        evidenceTopicSummaries: summaries.length,
        evidenceGrades: grades.length,
        recommendedFocus: snapshot?.recommendedFocus || '',
      },
    });

    // Generate readable report
    await this._generateReport(subject, diagnosis);

    return diagnosis;
  }

  private async _generateReport(subject: Subject, diag: LatestDiagnosis): Promise<void> {
    let md = `# 学习诊断报告\n\n`;
    md += `*生成时间：${diag.updatedAt}*\n\n`;
    md += `## 整体策略\n\n${diag.overallStrategy}\n\n`;

    for (const s of diag.subjectSnapshots) {
      const trend = { improving: '📈 上升', stable: '➡️ 稳定', declining: '📉 下降' }[s.recentTrend];
      md += `## ${s.subject} (掌握度 ${s.mastery}% ${trend})\n\n`;
      if (s.topStrengths.length) { md += `**强项：** ${s.topStrengths.join('、')}\n\n`; }
      if (s.topWeaknesses.length) { md += `**薄弱点：** ${s.topWeaknesses.join('、')}\n\n`; }
      if (s.keyMistakePatterns.length) { md += `**常见错误模式：** ${s.keyMistakePatterns.join('、')}\n\n`; }
      md += `**建议重点：** ${s.recommendedFocus}\n\n---\n\n`;
    }

    md += `## 下一步建议\n\n`;
    diag.nextSteps.forEach((step, i) => { md += `${i + 1}. ${step}\n`; });

    await writeMarkdownAndPreview(this.getReportPath(subject), md);
  }
}
