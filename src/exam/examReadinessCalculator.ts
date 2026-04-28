import { AIClient } from '../ai/client';
import { examReadinessAnalysisPrompt, type PromptContext } from '../ai/prompts';
import { CourseManager } from '../courses/courseManager';
import { CourseProfileStore } from '../progress/courseProfileStore';
import { LearningPlanStore } from '../coach/learningPlanStore';
import {
  ExamPrepSession,
  ExamReadinessSnapshot,
} from '../types';

interface ReadinessAIResponse {
  preExamChecklist?: unknown;
}

/**
 * 综合就绪度算法。一次 compute 把 4 个组件分数 + 知识点状态 + 行动清单都拿出来。
 *
 * 总分 readyScore = examScoreComponent (0-40)
 *                 + wrongQuestionComponent (0-30)
 *                 + coverageComponent (0-20)
 *                 + planAdherenceComponent (0-10)
 */
export class ExamReadinessCalculator {
  constructor(
    private readonly courseManager: CourseManager,
    // 保留：将来可以读 courseProfile 给 weakSpots 加权（当前未使用，避免 strict 报错前缀 _）
    private readonly _courseProfileStore: CourseProfileStore,
    private readonly learningPlanStore: LearningPlanStore,
    private readonly ai: AIClient,
  ) {
    // 显式触碰，避免 noUnusedParameters 报错（我们不开但保险）
    void this._courseProfileStore;
  }

  async compute(session: ExamPrepSession, promptCtx: PromptContext): Promise<ExamReadinessSnapshot> {
    const now = new Date();

    // 1) examScoreComponent (0-40)：最近 3 次 submission 的平均 percentage * 0.4
    const recentSubmissions = [...session.submissions]
      .filter((s) => s.gradingResult?.overall?.percentage !== undefined)
      .sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))
      .slice(0, 3);
    let examScoreComponent = 0;
    let latestPercentage: number | undefined;
    if (recentSubmissions.length > 0) {
      const avg = recentSubmissions.reduce(
        (s, sub) => s + (sub.gradingResult!.overall.percentage ?? 0),
        0,
      ) / recentSubmissions.length;
      examScoreComponent = Math.max(0, Math.min(40, Math.round(avg * 0.4)));
      latestPercentage = recentSubmissions[0].gradingResult!.overall.percentage;
    }

    // 2) wrongQuestionComponent (0-30)：(1 - 未解决错题/总错题) * 30
    let wrongQuestionComponent = 0;
    try {
      const book = await this.courseManager.getWrongQuestionBook(session.subject);
      const total = book.questions.length;
      const unresolved = book.questions.filter((q) => !q.resolved).length;
      const ratio = total > 0 ? 1 - (unresolved / total) : 1;
      wrongQuestionComponent = Math.max(0, Math.min(30, Math.round(ratio * 30)));
    } catch {
      wrongQuestionComponent = 30; // 没错题本时视为完全 ok
    }

    // 3) coverageComponent (0-20)：练过的考点 / 真题考点 * 20
    const realKnowledge = new Set<string>();
    for (const analysis of session.paperAnalyses) {
      Object.keys(analysis.knowledgeFrequency).forEach((kp) => realKnowledge.add(kp));
      for (const section of analysis.sections) {
        for (const q of section.questions) {
          q.knowledgePoints.forEach((kp) => realKnowledge.add(kp));
        }
      }
    }
    const practicedKnowledge = new Set<string>();
    for (const set of session.variantSets) {
      for (const q of set.questions) {
        q.knowledgePoints.forEach((kp) => practicedKnowledge.add(kp));
      }
    }
    let coverageComponent = 0;
    if (realKnowledge.size > 0) {
      const intersection = Array.from(realKnowledge).filter((kp) => practicedKnowledge.has(kp));
      coverageComponent = Math.max(0, Math.min(20, Math.round((intersection.length / realKnowledge.size) * 20)));
    }

    // 4) planAdherenceComponent (0-10)：daysAhead 线性插值
    let planAdherenceComponent = 5; // 默认中性
    try {
      const drift = await this.learningPlanStore.computeDrift(session.subject, now);
      const daysAhead = drift.daysAhead;
      if (daysAhead >= 0) {
        planAdherenceComponent = 10;
      } else if (daysAhead <= -3) {
        planAdherenceComponent = 0;
      } else {
        // -1 → ~7, -2 → ~3
        planAdherenceComponent = Math.max(0, Math.round(10 + (daysAhead / 3) * 10));
      }
    } catch {
      // 没 plan 时给中性 5
      planAdherenceComponent = 5;
    }

    // 5) knowledgeStatus[] + weakSpots[]
    const correctSet = new Set<string>();
    const wrongSet = new Set<string>();
    for (const sub of recentSubmissions) {
      for (const q of sub.gradingResult!.perQuestion) {
        for (const kp of q.knowledgePoints) {
          if (q.correct === true) correctSet.add(kp);
          else if (q.correct === false || q.correct === 'partial') wrongSet.add(kp);
        }
      }
    }
    const knowledgeStatus: ExamReadinessSnapshot['knowledgeStatus'] = [];
    for (const kp of realKnowledge) {
      let status: 'mastered' | 'wobbly' | 'untouched';
      let evidence: string;
      if (wrongSet.has(kp)) {
        status = 'wobbly';
        evidence = '最近模考中此考点出错';
      } else if (correctSet.has(kp)) {
        status = 'mastered';
        evidence = '最近模考此考点答对';
      } else if (practicedKnowledge.has(kp)) {
        status = 'wobbly';
        evidence = '已在变体题中出现，但尚未模考验证';
      } else {
        status = 'untouched';
        evidence = '尚未练过';
      }
      knowledgeStatus.push({ point: kp, status, evidence });
    }
    // weakSpots：先 wobbly，再 untouched
    const weakSpots: string[] = [
      ...knowledgeStatus.filter((k) => k.status === 'wobbly').map((k) => k.point),
      ...knowledgeStatus.filter((k) => k.status === 'untouched').map((k) => k.point),
    ];

    // 6) daysToExam
    let daysToExam: number | undefined;
    if (session.examDate) {
      const t = Date.parse(session.examDate);
      if (!Number.isNaN(t)) {
        const examDay = new Date(t);
        const ms = startOfDay(examDay).getTime() - startOfDay(now).getTime();
        daysToExam = Math.round(ms / (24 * 60 * 60 * 1000));
      }
    }

    // 7) preExamChecklist：调 AI 一次
    let preExamChecklist: string[] = [];
    try {
      const aiResp = await this.ai.chatJson<ReadinessAIResponse>(
        examReadinessAnalysisPrompt({
          weakSpots: weakSpots.slice(0, 8),
          daysToExam,
          latestPercentage,
          ctx: promptCtx,
        }),
        { temperature: 0.4 },
      );
      if (Array.isArray(aiResp?.preExamChecklist)) {
        preExamChecklist = aiResp.preExamChecklist
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 5);
      }
    } catch {
      // AI 失败时给一个静态兜底
      preExamChecklist = this.buildFallbackChecklist(weakSpots, daysToExam);
    }
    if (preExamChecklist.length === 0) {
      preExamChecklist = this.buildFallbackChecklist(weakSpots, daysToExam);
    }

    const readyScore = examScoreComponent + wrongQuestionComponent + coverageComponent + planAdherenceComponent;

    return {
      schemaVersion: 1,
      sessionId: session.id,
      computedAt: new Date().toISOString(),
      readyScore: Math.max(0, Math.min(100, readyScore)),
      components: {
        examScoreComponent,
        wrongQuestionComponent,
        coverageComponent,
        planAdherenceComponent,
      },
      knowledgeStatus,
      weakSpots,
      preExamChecklist,
      daysToExam,
    };
  }

  private buildFallbackChecklist(weakSpots: string[], daysToExam?: number): string[] {
    const out: string[] = [];
    if (typeof daysToExam === 'number' && daysToExam > 7) {
      out.push(`考前 ${daysToExam - 7} 天内：每天 30 分钟过一遍真题考点分布，构建知识地图`);
    }
    if (weakSpots.length > 0) {
      out.push(`针对薄弱考点 [${weakSpots.slice(0, 3).join('、')}]：每点配 3 道专项变体题`);
    }
    out.push('考前 3 天：完成 1 套整卷限时模考，模拟真实考试节奏');
    out.push('考前 1 天：只复习错题本里的 wobbly 考点，不看新知识点');
    return out.slice(0, 5);
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
