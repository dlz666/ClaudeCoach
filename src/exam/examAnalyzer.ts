import { AIClient } from '../ai/client';
import { examPaperAnalysisPrompt, type PromptContext } from '../ai/prompts';
import { MaterialManager } from '../materials/materialManager';
import {
  ExamPaperAnalysis,
  ExamPaperQuestion,
  ExamPaperSection,
} from '../types';

interface RawAnalysisQuestion {
  number?: unknown;
  type?: unknown;
  estimatedDifficulty?: unknown;
  knowledgePoints?: unknown;
  estimatedScore?: unknown;
  rawSnippet?: unknown;
}

interface RawAnalysisSection {
  title?: unknown;
  questions?: RawAnalysisQuestion[];
}

interface RawAnalysis {
  documentType?: unknown;
  sections?: RawAnalysisSection[];
  knowledgeFrequency?: Record<string, unknown>;
  toneAndDifficulty?: unknown;
  totalEstimatedScore?: unknown;
}

const VALID_QUESTION_TYPES: ExamPaperQuestion['type'][] = [
  'choice', 'fill', 'free', 'proof', 'code', 'short', 'unknown',
];

const VALID_DOC_TYPES: ExamPaperAnalysis['documentType'][] = [
  'past-paper', 'mock-exam', 'practice-set', 'unknown',
];

/**
 * 试卷分析：把 OCR/抽取后的真题文本喂给 AI，拆出 sections / knowledgeFrequency。
 */
export class ExamAnalyzer {
  constructor(
    private readonly ai: AIClient,
    private readonly materialManager: MaterialManager,
  ) {}

  async analyzePaper(paperId: string, ctx: PromptContext = {}): Promise<ExamPaperAnalysis> {
    const entry = await this.materialManager.getMaterialById(paperId);
    if (!entry) {
      return this.buildFallbackAnalysis(paperId, '<未找到资料>', 'material-not-found');
    }

    let text = '';
    try {
      text = await this.materialManager.ensureMaterialText(entry);
    } catch (err) {
      return this.buildFallbackAnalysis(
        paperId,
        entry.fileName,
        `extract-failed:${(err as Error)?.message ?? 'unknown'}`,
      );
    }

    if (!text || text.trim().length < 50) {
      return this.buildFallbackAnalysis(paperId, entry.fileName, 'empty-text');
    }

    const truncated = this.truncateForPrompt(text, 12000, 7000, 5000);

    let raw: RawAnalysis;
    try {
      raw = await this.ai.chatJson<RawAnalysis>(
        examPaperAnalysisPrompt(truncated, ctx),
        { temperature: 0.2 },
      );
    } catch (err) {
      return this.buildFallbackAnalysis(
        paperId,
        entry.fileName,
        `ai-failed:${(err as Error)?.message ?? 'unknown'}`,
      );
    }

    return this.normalize(raw, paperId, entry.fileName);
  }

  /**
   * 截断到 maxLen 字。优先保前 head 字 + 后 tail 字（让题号尾巴能被 AI 看到）。
   * 中间用 "[...省略...]" 占位。
   */
  private truncateForPrompt(text: string, maxLen: number, head: number, tail: number): string {
    if (text.length <= maxLen) return text;
    const headPart = text.slice(0, head);
    const tailPart = text.slice(text.length - tail);
    return `${headPart}\n\n[...省略 ${text.length - head - tail} 字...]\n\n${tailPart}`;
  }

  private normalize(raw: RawAnalysis, paperId: string, paperFileName: string): ExamPaperAnalysis {
    const documentType = (typeof raw.documentType === 'string'
      && (VALID_DOC_TYPES as string[]).includes(raw.documentType))
      ? raw.documentType as ExamPaperAnalysis['documentType']
      : 'unknown';

    const sections: ExamPaperSection[] = [];
    if (Array.isArray(raw.sections)) {
      for (const section of raw.sections) {
        const title = typeof section?.title === 'string' && section.title.trim() ? section.title.trim() : '未命名节';
        const questions: ExamPaperQuestion[] = [];
        if (Array.isArray(section?.questions)) {
          for (const q of section.questions) {
            questions.push(this.normalizeQuestion(q));
          }
        }
        sections.push({ title, questions });
      }
    }

    const knowledgeFrequency: Record<string, number> = {};
    if (raw.knowledgeFrequency && typeof raw.knowledgeFrequency === 'object') {
      for (const [k, v] of Object.entries(raw.knowledgeFrequency)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0 && k && typeof k === 'string') {
          knowledgeFrequency[k] = Math.round(n);
        }
      }
    }
    // 兜底：从 sections 重算 knowledgeFrequency
    if (Object.keys(knowledgeFrequency).length === 0) {
      for (const section of sections) {
        for (const q of section.questions) {
          for (const kp of q.knowledgePoints) {
            knowledgeFrequency[kp] = (knowledgeFrequency[kp] ?? 0) + 1;
          }
        }
      }
    }

    const toneAndDifficulty = typeof raw.toneAndDifficulty === 'string' ? raw.toneAndDifficulty : '';
    const totalEstimatedScore = Number.isFinite(Number(raw.totalEstimatedScore))
      ? Number(raw.totalEstimatedScore)
      : undefined;

    return {
      schemaVersion: 1,
      paperId,
      paperFileName,
      parsedAt: new Date().toISOString(),
      documentType,
      sections,
      knowledgeFrequency,
      toneAndDifficulty,
      totalEstimatedScore,
    };
  }

  private normalizeQuestion(q: RawAnalysisQuestion): ExamPaperQuestion {
    const number = typeof q.number === 'string' || typeof q.number === 'number'
      ? String(q.number)
      : '?';
    const type = typeof q.type === 'string' && (VALID_QUESTION_TYPES as string[]).includes(q.type)
      ? q.type as ExamPaperQuestion['type']
      : 'unknown';
    let difficulty = Number(q.estimatedDifficulty);
    if (!Number.isFinite(difficulty)) difficulty = 3;
    difficulty = Math.max(1, Math.min(5, Math.round(difficulty)));
    const knowledgePoints: string[] = [];
    if (Array.isArray(q.knowledgePoints)) {
      for (const kp of q.knowledgePoints) {
        if (typeof kp === 'string' && kp.trim()) {
          knowledgePoints.push(kp.trim());
        }
      }
    }
    const estimatedScore = Number.isFinite(Number(q.estimatedScore)) ? Number(q.estimatedScore) : undefined;
    const rawSnippet = typeof q.rawSnippet === 'string' ? q.rawSnippet.slice(0, 400) : undefined;

    return {
      number,
      type,
      estimatedDifficulty: difficulty,
      knowledgePoints,
      estimatedScore,
      rawSnippet,
    };
  }

  private buildFallbackAnalysis(paperId: string, fileName: string, reason: string): ExamPaperAnalysis {
    return {
      schemaVersion: 1,
      paperId,
      paperFileName: fileName,
      parsedAt: new Date().toISOString(),
      documentType: 'unknown',
      sections: [],
      knowledgeFrequency: {},
      toneAndDifficulty: `分析失败：${reason}`,
    };
  }
}
