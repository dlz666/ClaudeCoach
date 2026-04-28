import * as fs from 'fs/promises';
import { AIClient, type MultimodalChatMessage } from '../ai/client';
import {
  examTextGradingPrompt,
  examVisionGradingPrompt,
  type PromptContext,
} from '../ai/prompts';
import {
  ExamGradedQuestion,
  ExamGradingResult,
  ExamPaperAnalysis,
  ExamVariantSet,
  FeedbackWeaknessTag,
} from '../types';

export interface GraderImage {
  filePath: string;
  base64?: string;
  mimeType: string;
}

interface RawGradedQuestion {
  questionNumber?: unknown;
  studentAnswerOcr?: unknown;
  correct?: unknown;
  score?: unknown;
  maxScore?: unknown;
  feedback?: unknown;
  knowledgePoints?: unknown;
  weaknessTags?: unknown;
}

interface RawGradingResult {
  perQuestion?: RawGradedQuestion[];
  overall?: {
    totalScore?: unknown;
    maxScore?: unknown;
    percentage?: unknown;
    strengths?: unknown;
    weaknesses?: unknown;
    nextSteps?: unknown;
  };
}

const VALID_WEAKNESS_TAGS: FeedbackWeaknessTag[] = [
  'concept', 'syntax', 'logic', 'edge-case', 'complexity', 'debugging', 'other',
];

const MAX_IMAGES_PER_BATCH = 4;

export class ExamGrader {
  constructor(private readonly ai: AIClient) {}

  /**
   * 多模态批改：图片 + 题面 → 全部题的批改一次拿。
   * 失败时抛 VisionUnsupportedError（由 AIClient 抛出）或普通 Error。
   */
  async gradeWithImages(args: {
    images: GraderImage[];
    variantSet: ExamVariantSet | null;
    paperAnalyses: ExamPaperAnalysis[];
    promptCtx: PromptContext;
  }): Promise<ExamGradingResult> {
    const { images, variantSet, paperAnalyses, promptCtx } = args;
    if (!images || images.length === 0) {
      throw new Error('请至少上传一张答题图片。');
    }
    if (images.length > MAX_IMAGES_PER_BATCH) {
      throw new Error(`一次最多支持 ${MAX_IMAGES_PER_BATCH} 张图片，请精简后重试（当前 ${images.length} 张）。`);
    }

    // 1. 拼题面 JSON
    const questionsJson = this.buildQuestionsJson(variantSet, paperAnalyses);

    // 2. 把图片读为 base64（如果只有 filePath）
    const filledImages = await Promise.all(images.map(async (img) => {
      let base64 = img.base64;
      if (!base64) {
        const data = await fs.readFile(img.filePath);
        base64 = data.toString('base64');
      }
      return { ...img, base64 };
    }));

    // 3. 构造多模态消息
    const messages = examVisionGradingPrompt({ questionsJson, ctx: promptCtx });
    const userMsg = messages[messages.length - 1] as MultimodalChatMessage;
    userMsg.images = filledImages.map((img) => ({
      base64: img.base64!,
      mimeType: img.mimeType,
    }));

    const raw = await this.ai.chatJsonMultimodal<RawGradingResult>(messages, {
      temperature: 0.2,
    });

    return this.normalize(raw, 'vision');
  }

  /** 文字 fallback 批改：vision 不可用时，用户手动输入答案。 */
  async gradeWithText(args: {
    answers: Array<{ questionNumber: string; answer: string }>;
    variantSet: ExamVariantSet | null;
    paperAnalyses: ExamPaperAnalysis[];
    promptCtx: PromptContext;
  }): Promise<ExamGradingResult> {
    const { answers, variantSet, paperAnalyses, promptCtx } = args;
    if (!answers || answers.length === 0) {
      throw new Error('请至少输入一题答案。');
    }

    const questionsJson = this.buildQuestionsJson(variantSet, paperAnalyses);
    const messages = examTextGradingPrompt({
      questionsJson,
      studentAnswers: answers,
      ctx: promptCtx,
    });

    const raw = await this.ai.chatJson<RawGradingResult>(messages, { temperature: 0.2 });
    return this.normalize(raw, 'text-fallback');
  }

  // -----------------------------------------------------------------

  private buildQuestionsJson(
    variantSet: ExamVariantSet | null,
    paperAnalyses: ExamPaperAnalysis[],
  ): string {
    if (variantSet && variantSet.questions.length > 0) {
      const compact = variantSet.questions.map((q) => ({
        number: q.number,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        knowledgePoints: q.knowledgePoints,
        estimatedScore: q.estimatedScore,
      }));
      return JSON.stringify(compact, null, 2);
    }
    // fallback：从 paperAnalyses 拼一份"题号-考点"参考
    const out: Array<Record<string, unknown>> = [];
    for (const analysis of paperAnalyses) {
      for (const section of analysis.sections) {
        for (const q of section.questions) {
          out.push({
            number: q.number,
            sectionTitle: section.title,
            type: q.type,
            knowledgePoints: q.knowledgePoints,
            estimatedScore: q.estimatedScore,
            rawSnippet: q.rawSnippet,
          });
        }
      }
    }
    return JSON.stringify(out, null, 2);
  }

  private normalize(raw: RawGradingResult, mode: 'vision' | 'text-fallback'): ExamGradingResult {
    const perQuestion: ExamGradedQuestion[] = [];
    if (Array.isArray(raw?.perQuestion)) {
      for (const q of raw.perQuestion) {
        perQuestion.push(this.normalizeGradedQuestion(q));
      }
    }

    const overallRaw = raw?.overall ?? {};
    let totalScore = Number(overallRaw.totalScore);
    let maxScore = Number(overallRaw.maxScore);

    // 兜底：从 perQuestion 重算
    if (!Number.isFinite(totalScore)) {
      totalScore = perQuestion.reduce((s, q) => s + (q.score ?? 0), 0);
    }
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      maxScore = perQuestion.reduce((s, q) => s + (q.maxScore ?? 0), 0);
    }
    if (maxScore <= 0) maxScore = Math.max(1, perQuestion.length * 10);

    let percentage = Number(overallRaw.percentage);
    if (!Number.isFinite(percentage)) {
      percentage = (totalScore / maxScore) * 100;
    }
    percentage = Math.max(0, Math.min(100, Math.round(percentage)));

    const strengths = this.coerceStringArray(overallRaw.strengths);
    const weaknesses = this.coerceStringArray(overallRaw.weaknesses);
    const nextSteps = this.coerceStringArray(overallRaw.nextSteps);

    return {
      schemaVersion: 1,
      perQuestion,
      overall: {
        totalScore: Math.max(0, Math.round(totalScore)),
        maxScore: Math.max(1, Math.round(maxScore)),
        percentage,
        strengths,
        weaknesses,
        nextSteps,
      },
      gradedAt: new Date().toISOString(),
      gradingMode: mode,
    };
  }

  private normalizeGradedQuestion(raw: RawGradedQuestion): ExamGradedQuestion {
    const questionNumber = typeof raw.questionNumber === 'string' || typeof raw.questionNumber === 'number'
      ? String(raw.questionNumber)
      : '?';
    const studentAnswerOcr = typeof raw.studentAnswerOcr === 'string' ? raw.studentAnswerOcr : '';

    let correct: ExamGradedQuestion['correct'];
    if (raw.correct === true || raw.correct === false) {
      correct = raw.correct;
    } else if (raw.correct === 'partial') {
      correct = 'partial';
    } else if (typeof raw.correct === 'string' && raw.correct.toLowerCase() === 'partial') {
      correct = 'partial';
    } else {
      correct = false;
    }

    let score = Number(raw.score);
    if (!Number.isFinite(score)) score = 0;
    let maxScore = Number(raw.maxScore);
    if (!Number.isFinite(maxScore) || maxScore <= 0) maxScore = 10;
    score = Math.max(0, Math.min(maxScore, Math.round(score)));

    const feedback = typeof raw.feedback === 'string' ? raw.feedback : '';
    const knowledgePoints = this.coerceStringArray(raw.knowledgePoints);

    const weaknessTags: FeedbackWeaknessTag[] = [];
    if (Array.isArray(raw.weaknessTags)) {
      for (const tag of raw.weaknessTags) {
        if (typeof tag === 'string' && (VALID_WEAKNESS_TAGS as string[]).includes(tag)) {
          weaknessTags.push(tag as FeedbackWeaknessTag);
        }
      }
    }

    return {
      questionNumber,
      studentAnswerOcr,
      correct,
      score,
      maxScore,
      feedback,
      knowledgePoints,
      weaknessTags: weaknessTags.length > 0 ? weaknessTags : undefined,
    };
  }

  private coerceStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) {
        out.push(item.trim());
      }
    }
    return out;
  }
}
