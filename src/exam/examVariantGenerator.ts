import { AIClient } from '../ai/client';
import { examVariantPrompt, type PromptContext } from '../ai/prompts';
import {
  ExamPaperAnalysis,
  ExamPrepSession,
  ExamVariantQuestion,
  ExamVariantSet,
} from '../types';

interface RawVariantQuestion {
  number?: unknown;
  type?: unknown;
  difficulty?: unknown;
  prompt?: unknown;
  options?: unknown;
  knowledgePoints?: unknown;
  sourceQuestionRef?: unknown;
  variantStrategy?: unknown;
  estimatedScore?: unknown;
}

const VALID_TYPES: ExamVariantQuestion['type'][] = [
  'choice', 'fill', 'free', 'proof', 'code', 'short',
];

/**
 * 深度变体题生成：基于真题分析 + 薄弱点，调 AI 出 N 道。
 * 强约束"深度变体而非换皮"，详见 examVariantPrompt 中的硬性约束段。
 */
export class ExamVariantGenerator {
  constructor(private readonly ai: AIClient) {}

  async generate(args: {
    session: ExamPrepSession;
    paperAnalyses: ExamPaperAnalysis[];
    weakKnowledgePoints: string[];
    count: number;
    focusMode: 'cover-all' | 'reinforce-weakness' | 'mock-full';
    promptCtx: PromptContext;
  }): Promise<ExamVariantSet> {
    const { session, paperAnalyses, weakKnowledgePoints, count, focusMode, promptCtx } = args;
    const safeCount = Math.max(1, Math.min(20, Math.round(count)));

    const messages = examVariantPrompt({
      paperAnalyses,
      weakKnowledgePoints,
      count: safeCount,
      focusMode,
      ctx: promptCtx,
    });

    let raw: unknown;
    try {
      raw = await this.ai.chatJson<unknown>(messages, { temperature: 0.5 });
    } catch (err) {
      throw new Error(`生成变体题失败：${(err as Error)?.message ?? 'unknown'}`);
    }

    const rawArray = this.coerceArray(raw);
    const questions: ExamVariantQuestion[] = rawArray
      .map((item, index) => this.normalizeQuestion(item, index))
      .filter((item): item is ExamVariantQuestion => !!item);

    if (questions.length === 0) {
      throw new Error('AI 没有返回任何变体题。请重试或调整 focusMode。');
    }

    const id = `vset-${Date.now()}`;
    return {
      id,
      sessionId: session.id,
      generatedAt: new Date().toISOString(),
      focusMode,
      count: questions.length,
      questions,
      sourcePaperIds: paperAnalyses.map((a) => a.paperId),
    };
  }

  private coerceArray(raw: unknown): RawVariantQuestion[] {
    if (Array.isArray(raw)) return raw as RawVariantQuestion[];
    if (raw && typeof raw === 'object') {
      // 一些模型会包成 { questions: [...] }
      const obj = raw as { questions?: unknown; data?: unknown; items?: unknown };
      if (Array.isArray(obj.questions)) return obj.questions as RawVariantQuestion[];
      if (Array.isArray(obj.data)) return obj.data as RawVariantQuestion[];
      if (Array.isArray(obj.items)) return obj.items as RawVariantQuestion[];
    }
    return [];
  }

  private normalizeQuestion(raw: RawVariantQuestion, index: number): ExamVariantQuestion | null {
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!prompt) return null;

    const type = typeof raw.type === 'string' && (VALID_TYPES as string[]).includes(raw.type)
      ? raw.type as ExamVariantQuestion['type']
      : 'free';

    let difficulty = Number(raw.difficulty);
    if (!Number.isFinite(difficulty)) difficulty = 3;
    difficulty = Math.max(1, Math.min(5, Math.round(difficulty)));

    const knowledgePoints: string[] = [];
    if (Array.isArray(raw.knowledgePoints)) {
      for (const kp of raw.knowledgePoints) {
        if (typeof kp === 'string' && kp.trim()) knowledgePoints.push(kp.trim());
      }
    }

    const variantStrategy: string[] = [];
    if (Array.isArray(raw.variantStrategy)) {
      for (const v of raw.variantStrategy) {
        if (typeof v === 'string' && v.trim()) variantStrategy.push(v.trim());
      }
    }
    if (variantStrategy.length === 0) variantStrategy.push('angle-shift');

    let options: string[] | undefined;
    if (Array.isArray(raw.options)) {
      const arr = raw.options
        .filter((o): o is string => typeof o === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length > 0) options = arr;
    }
    if (type !== 'choice') options = undefined;

    const number = typeof raw.number === 'string' || typeof raw.number === 'number'
      ? String(raw.number)
      : String(index + 1);

    const sourceQuestionRef = typeof raw.sourceQuestionRef === 'string' && raw.sourceQuestionRef.trim()
      ? raw.sourceQuestionRef.trim()
      : undefined;

    const estimatedScore = Number.isFinite(Number(raw.estimatedScore))
      ? Number(raw.estimatedScore)
      : undefined;

    return {
      id: `vq-${index + 1}`,
      number,
      type,
      difficulty,
      prompt,
      options,
      knowledgePoints,
      sourceQuestionRef,
      variantStrategy,
      estimatedScore,
    };
  }
}
