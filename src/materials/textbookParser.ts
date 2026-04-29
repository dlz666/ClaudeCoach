import { AIClient } from '../ai/client';
import { materialIndexPrompt, textbookChunkParsePrompt } from '../ai/prompts';
import {
  MaterialChapterSummary,
  MaterialExerciseMapping,
  MaterialSectionMapping,
  MaterialSummary,
  Subject,
} from '../types';

interface RawTextbookChunkResult {
  documentType?: MaterialSummary['documentType'];
  chapters?: Array<Partial<MaterialChapterSummary>>;
  sectionMappings?: Array<Partial<MaterialSectionMapping>>;
  exerciseMappings?: Array<Partial<MaterialExerciseMapping>>;
}

function cleanText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function uniqueStrings(values: Array<string | undefined>, maxItems = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }

  return result;
}

function pickLongerText(current: string | undefined, incoming: string | undefined): string {
  const left = String(current ?? '').trim();
  const right = String(incoming ?? '').trim();

  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right.length > left.length ? right : left;
}

function normalizeNumber(value: string | undefined): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[：:。]+$/g, '')
    .replace(/\s+/g, '');
  return normalized || undefined;
}

function normalizeTitle(value: string | undefined, fallback: string): string {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  return normalized || fallback;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, 'zh-Hans-CN-u-kn-true');
}

export class TextbookParser {
  private readonly ai = new AIClient();
  private readonly chunkCharLimit = 9000;
  private readonly softSinglePassLimit = 12000;
  private readonly maxAiChunks = 12;

  async parse(text: string, subject: Subject): Promise<MaterialSummary> {
    const normalizedText = cleanText(text);
    if (!normalizedText) {
      return {
        materialId: '',
        documentType: 'unknown',
        chapters: [],
        sectionMappings: [],
        exerciseMappings: [],
        parserMeta: {
          source: 'single-pass',
          chunkCount: 0,
          generatedAt: new Date().toISOString(),
          truncated: false,
        },
      };
    }

    const fullChunks = this.buildChunks(normalizedText);
    if (fullChunks.length > this.maxAiChunks) {
      const outlineSnapshot = this.buildOutlineSnapshot(normalizedText);
      try {
        const reduced = await this.parseWithAI(outlineSnapshot, subject);
        return {
          ...reduced,
          parserMeta: {
            source: 'hybrid',
            chunkCount: this.buildChunks(outlineSnapshot).length,
            generatedAt: new Date().toISOString(),
            truncated: true,
          },
        };
      } catch (error) {
        console.error('Textbook parser reduced AI flow failed, falling back to heuristic parsing:', error);
        return this.buildHeuristicFallback(normalizedText);
      }
    }

    try {
      return await this.parseWithAI(normalizedText, subject);
    } catch (error) {
      console.error('Textbook parser AI flow failed, falling back to heuristic parsing:', error);
      return this.buildHeuristicFallback(normalizedText);
    }
  }

  private async parseWithAI(normalizedText: string, subject: Subject): Promise<MaterialSummary> {
    const chunks = this.buildChunks(normalizedText);
    const chunkResults: RawTextbookChunkResult[] = [];

    for (const [index, chunk] of chunks.entries()) {
      try {
        const parsed = await this.ai.chatJson<RawTextbookChunkResult>(
          textbookChunkParsePrompt(chunk, subject, {
            chunkIndex: index + 1,
            totalChunks: chunks.length,
          })
        );
        chunkResults.push(parsed);
      } catch (error) {
        if (chunks.length === 1) {
          return this.parseFallback(normalizedText, subject);
        }
        console.error(`Textbook parser chunk ${index + 1}/${chunks.length} failed:`, error);
      }
    }

    if (!chunkResults.length) {
      return this.parseFallback(normalizedText, subject);
    }

    const merged = this.mergeChunkResults(chunkResults);
    if (
      !merged.chapters.length &&
      !(merged.sectionMappings ?? []).length &&
      !(merged.exerciseMappings ?? []).length
    ) {
      return this.parseFallback(normalizedText, subject);
    }

    return {
      materialId: '',
      documentType: merged.documentType,
      chapters: merged.chapters,
      sectionMappings: merged.sectionMappings,
      exerciseMappings: merged.exerciseMappings,
      parserMeta: {
        source: chunks.length > 1 || normalizedText.length > this.softSinglePassLimit ? 'textbook-parser' : 'single-pass',
        chunkCount: chunks.length,
        generatedAt: new Date().toISOString(),
        truncated: false,
      },
    };
  }

  private async parseFallback(text: string, subject: Subject): Promise<MaterialSummary> {
    const fallback = await this.ai.chatJson<Pick<MaterialSummary, 'chapters'>>(
      materialIndexPrompt(text, subject)
    );

    const chapters = (fallback.chapters ?? []).map((chapter, index) => this.normalizeChapter(chapter, index));
    return {
      materialId: '',
      documentType: 'unknown',
      chapters,
      sectionMappings: [],
      exerciseMappings: [],
      parserMeta: {
        source: 'single-pass',
        chunkCount: 1,
        generatedAt: new Date().toISOString(),
        truncated: text.length > 15000,
      },
    };
  }

  private buildChunks(text: string): string[] {
    if (text.length <= this.chunkCharLimit) {
      return [text];
    }

    const blocks = this.buildStructuralBlocks(text);
    const chunks: string[] = [];
    let current = '';

    for (const block of blocks) {
      const next = current ? `${current}\n\n${block}` : block;
      if (next.length > this.chunkCharLimit && current) {
        chunks.push(current);
        current = block;
      } else {
        current = next;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.length ? chunks : [text.slice(0, this.chunkCharLimit)];
  }

  private buildOutlineSnapshot(text: string): string {
    const candidates = this.collectOutlineCandidates(text);
    if (!candidates.length) {
      return text.slice(0, this.chunkCharLimit * this.maxAiChunks);
    }

    return [
      '[目录与章节标题快照]',
      ...candidates,
    ].join('\n').slice(0, this.chunkCharLimit * this.maxAiChunks);
  }

  private buildStructuralBlocks(text: string): string[] {
    const lines = text.split('\n');
    const blocks: string[] = [];
    let current: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (current.length) {
          current.push('');
        }
        continue;
      }

      if (this.looksLikeHeading(line) && current.length) {
        blocks.push(current.join('\n').trim());
        current = [line];
        continue;
      }

      current.push(line);
    }

    if (current.length) {
      blocks.push(current.join('\n').trim());
    }

    return blocks.length ? blocks : [text];
  }

  private buildHeuristicFallback(text: string): MaterialSummary {
    const candidates = this.collectOutlineCandidates(text);
    const sectionMap = new Map<string, MaterialSectionMapping>();
    const exerciseMap = new Map<string, MaterialExerciseMapping>();
    const chapterMap = new Map<string, MaterialChapterSummary>();

    const upsertChapter = (chapterNumber: string | undefined, title: string): MaterialChapterSummary => {
      const normalizedTitle = this.cleanOutlineTitle(title) || `章节 ${chapterMap.size + 1}`;
      const key = chapterNumber ? `chapter:${chapterNumber}` : `title:${normalizedTitle.toLowerCase()}`;
      const incoming = this.normalizeChapter({
        chapterNumber,
        title: normalizedTitle,
        summary: '根据教材目录或标题自动提取的章节标题。',
        keyPoints: [],
        topicMapping: [],
        sectionNumbers: [],
        relatedExerciseTitles: [],
      }, chapterMap.size);
      const existing = chapterMap.get(key);
      const merged = existing ? this.mergeChapter(existing, incoming) : incoming;
      chapterMap.set(key, merged);
      return merged;
    };

    let currentChapter: MaterialChapterSummary | null = null;
    let currentSection: MaterialSectionMapping | null = null;

    for (const candidate of candidates) {
      const sectionCandidate = this.parseSectionCandidate(candidate);
      if (sectionCandidate) {
        const chapter = upsertChapter(
          sectionCandidate.chapterNumber,
          currentChapter?.title || `第 ${sectionCandidate.chapterNumber || '?'} 章`
        );
        const section = this.normalizeSection({
          chapterNumber: sectionCandidate.chapterNumber,
          chapterTitle: chapter.title,
          sectionNumber: sectionCandidate.sectionNumber,
          sectionTitle: sectionCandidate.title,
          summary: '根据教材目录或标题自动提取的小节标题。',
          keyPoints: [],
          topicMapping: [],
          anchorTerms: [],
          relatedExerciseTitles: [],
        }, sectionMap.size);
        sectionMap.set(this.sectionKey(section), section);
        chapter.sectionNumbers = uniqueStrings([...(chapter.sectionNumbers ?? []), section.sectionNumber], 20);
        currentChapter = chapter;
        currentSection = section;
        continue;
      }

      const chapterCandidate = this.parseChapterCandidate(candidate);
      if (chapterCandidate) {
        currentChapter = upsertChapter(chapterCandidate.chapterNumber, chapterCandidate.title);
        currentSection = null;
        continue;
      }

      const exerciseCandidate = this.parseExerciseCandidate(candidate);
      if (!exerciseCandidate) {
        continue;
      }

      const exercise = this.normalizeExercise({
        chapterNumber: currentSection?.chapterNumber ?? currentChapter?.chapterNumber,
        chapterTitle: currentSection?.chapterTitle ?? currentChapter?.title ?? '',
        sectionNumber: currentSection?.sectionNumber,
        sectionTitle: currentSection?.sectionTitle ?? '',
        title: exerciseCandidate.title,
        exerciseType: exerciseCandidate.exerciseType,
        summary: '根据教材目录或标题自动提取的习题入口。',
        keyPoints: [],
        topicMapping: [],
        anchorTerms: [],
        relatedSections: currentSection?.sectionNumber ? [currentSection.sectionNumber] : [],
      }, exerciseMap.size);
      exerciseMap.set(this.exerciseKey(exercise), exercise);

      if (currentSection) {
        currentSection.relatedExerciseTitles = uniqueStrings([
          ...(currentSection.relatedExerciseTitles ?? []),
          exercise.title,
        ], 12);
      }
      if (currentChapter) {
        currentChapter.relatedExerciseTitles = uniqueStrings([
          ...(currentChapter.relatedExerciseTitles ?? []),
          exercise.title,
        ], 20);
      }
    }

    const sections = Array.from(sectionMap.values()).sort((left, right) =>
      naturalCompare(this.sectionSortLabel(left), this.sectionSortLabel(right))
    );
    const exercises = Array.from(exerciseMap.values()).sort((left, right) =>
      naturalCompare(this.exerciseSortLabel(left), this.exerciseSortLabel(right))
    );
    const chapters = this.dedupeChapters(Array.from(chapterMap.values()).sort((left, right) =>
      naturalCompare(this.chapterSortLabel(left), this.chapterSortLabel(right))
    ));

    return {
      materialId: '',
      documentType: sections.length || chapters.length ? 'textbook' : 'unknown',
      chapters: chapters.length ? chapters : this.buildChaptersFromSections(sections, exercises),
      sectionMappings: sections,
      exerciseMappings: exercises,
      parserMeta: {
        source: 'heuristic',
        chunkCount: this.buildChunks(text).length,
        generatedAt: new Date().toISOString(),
        truncated: false,
      },
    };
  }

  private collectOutlineCandidates(text: string): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    const lines = text.split('\n');

    for (const [index, rawLine] of lines.entries()) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      // pdf-parse 对中文教材常把多列 / 多行压成一长行。
      // 当行很长且含多个章节标记时，用正则二次切分提取每个章节标题。
      // 目标 pattern：
      //   "第N章 标题..." 直到下一个 "第" / "§" / "习题" / 行末
      //   "§N 标题..."     同上
      if (trimmed.length >= 200) {
        const longLineCandidates = this._extractHeadingsFromLongLine(trimmed);
        for (const cand of longLineCandidates) {
          const norm = this.normalizeOutlineCandidate(cand);
          if (
            norm &&
            !seen.has(norm) &&
            this.isReasonableOutlineTitle(norm)
          ) {
            seen.add(norm);
            candidates.push(norm);
            if (candidates.length >= 500) return candidates;
          }
        }
        // 长行处理完仍继续走下面的整行判断（不影响）
      }

      const normalized = this.normalizeOutlineCandidate(trimmed);
      if (!normalized || seen.has(normalized) || !this.isReasonableOutlineTitle(normalized)) {
        continue;
      }

      const looksLikeToc = /(?:\.{2,}|[·•…。]{2,})\s*\d+\s*$/.test(trimmed);
      const looksLikeStructured = this.looksLikeHeading(trimmed)
        || /^第?\s*[0-9一二三四五六七八九十百零两]+[章节篇]/.test(normalized)
        || /^[0-9]{1,2}(?:\.[A-Za-z0-9]{1,3}|(?:\.[0-9]{1,3}){1,2})/.test(normalized)
        || /^(习题|练习|章末习题|复习题|综合练习|Exercises?)/i.test(normalized);

      if (!looksLikeToc && !looksLikeStructured && index > 1400) {
        continue;
      }

      seen.add(normalized);
      candidates.push(normalized);
      if (candidates.length >= 500) {
        break;
      }
    }

    return candidates;
  }

  /**
   * 从被 pdf-parse 压扁的一长行里提取所有 heading-like 子串。
   * 主要场景：苏德矿微积分 / 高等数学等中文教材，pdf-parse 把目录页的多列布局
   * 压成一行，所有"第七章/第八章/§ 1/§ 2"挤在一起，普通行级 split 拿不到。
   */
  private _extractHeadingsFromLongLine(line: string): string[] {
    const out: string[] = [];
    // 主要模式：
    //  "第N章/节/篇 [标题文字...]"  止于下一个 "第" / "§" / "习题" / "Chapter"
    //  "§ N [标题]"                  止于下一个 "§" / "第" / "习题"
    //  "Chapter N [标题]"            止于下一个 "Chapter" / "§"
    const patterns = [
      /第\s*[0-9一二三四五六七八九十百零两]+\s*[章节篇][^\n第§]{0,80}/g,
      /Chapter\s+\d+[^\n章§]{0,80}/gi,
      /§\s*\d+(?:\.\d+)?[^\n第§]{0,60}/g,
    ];
    for (const pat of patterns) {
      let m: RegExpExecArray | null;
      while ((m = pat.exec(line))) {
        const candidate = m[0]
          .replace(/[·•…]+/g, ' ')  // 去掉省略号 / 圆点装饰
          .replace(/\s{2,}/g, ' ')
          .trim();
        // 太短（仅"第N章"无标题）跳过，等行内更长 heading 涵盖
        if (candidate.length < 5) continue;
        out.push(candidate);
      }
    }
    return out;
  }

  private normalizeOutlineCandidate(line: string): string {
    return line
      .replace(/(?:\.{2,}|[·•…。]{2,})\s*\d+\s*$/, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[•·\-–—\s]+/, '')
      .trim();
  }

  private cleanOutlineTitle(title: string): string {
    return title
      .replace(/^[\s:：、.．\-–—]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private isReasonableOutlineTitle(title: string): boolean {
    if (!title || title.length < 2 || title.length > 120) {
      return false;
    }

    if (/^[0-9.\-–—:：\s]+$/.test(title)) {
      return false;
    }

    return /[\u4e00-\u9fffA-Za-z]/.test(title);
  }

  private parseChapterCandidate(line: string): { chapterNumber?: string; title: string } | null {
    const explicit = line.match(/^第?\s*([0-9一二三四五六七八九十百零两]+)\s*[章节篇]\s*(.+)$/);
    if (explicit) {
      const title = this.cleanOutlineTitle(explicit[2]);
      if (this.isReasonableOutlineTitle(title)) {
        return {
          chapterNumber: normalizeNumber(explicit[1]),
          title,
        };
      }
    }

    const simple = line.match(/^([0-9]{1,2})\s*(.+)$/);
    if (!simple || line.startsWith(`${simple[1]}.`)) {
      return null;
    }

    const title = this.cleanOutlineTitle(simple[2]);
    if (!this.isReasonableOutlineTitle(title)) {
      return null;
    }

    return {
      chapterNumber: normalizeNumber(simple[1]),
      title,
    };
  }

  private parseSectionCandidate(line: string): { chapterNumber?: string; sectionNumber?: string; title: string } | null {
    const match = line.match(/^([0-9]{1,2}\.[A-Za-z0-9]{1,3}|[0-9]{1,2}\.[0-9]{1,3})\s*(.+)$/);
    if (!match) {
      return null;
    }

    const title = this.cleanOutlineTitle(match[2]);
    if (!this.isReasonableOutlineTitle(title)) {
      return null;
    }

    const sectionNumber = normalizeNumber(match[1]);
    return {
      chapterNumber: sectionNumber?.split('.')[0],
      sectionNumber,
      title,
    };
  }

  private parseExerciseCandidate(line: string): { title: string; exerciseType: string } | null {
    const match = line.match(/^(习题|练习|章末习题|复习题|综合练习|Exercises?)\s*([0-9A-Za-z.\-]*)\s*(.*)$/i);
    if (!match) {
      return null;
    }

    const exerciseType = this.cleanOutlineTitle(match[1]) || '练习';
    const suffix = [match[2], this.cleanOutlineTitle(match[3])].filter(Boolean).join(' ').trim();
    const title = suffix || exerciseType;
    if (!this.isReasonableOutlineTitle(title)) {
      return null;
    }

    return {
      title: title.slice(0, 120),
      exerciseType,
    };
  }

  private looksLikeHeading(line: string): boolean {
    return [
      /^第[一二三四五六七八九十百零〇两\d]+章/,
      /^第[一二三四五六七八九十百零〇两\d]+节/,
      /^[0-9]{1,2}(?:\.[0-9]{1,3}){1,3}(?:\s+|$)/,
      /^§\s*[0-9]+(?:\.[0-9]+){0,3}/,
      /^(习题|练习|章末习题|复习题|综合练习)[\s\d一二三四五六七八九十.]*/,
    ].some((pattern) => pattern.test(line));
  }

  private mergeChunkResults(results: RawTextbookChunkResult[]): Omit<MaterialSummary, 'materialId' | 'parserMeta'> {
    const chapterMap = new Map<string, MaterialChapterSummary>();
    const sectionMap = new Map<string, MaterialSectionMapping>();
    const exerciseMap = new Map<string, MaterialExerciseMapping>();
    const documentTypes = new Map<string, number>();

    for (const result of results) {
      const docType = result.documentType ?? 'unknown';
      documentTypes.set(docType, (documentTypes.get(docType) ?? 0) + 1);

      for (const [index, chapter] of (result.chapters ?? []).entries()) {
        const normalized = this.normalizeChapter(chapter, index);
        const key = this.chapterKey(normalized);
        const existing = chapterMap.get(key);
        chapterMap.set(key, existing ? this.mergeChapter(existing, normalized) : normalized);
      }

      for (const [index, section] of (result.sectionMappings ?? []).entries()) {
        const normalized = this.normalizeSection(section, index);
        const key = this.sectionKey(normalized);
        const existing = sectionMap.get(key);
        sectionMap.set(key, existing ? this.mergeSection(existing, normalized) : normalized);
      }

      for (const [index, exercise] of (result.exerciseMappings ?? []).entries()) {
        const normalized = this.normalizeExercise(exercise, index);
        const key = this.exerciseKey(normalized);
        const existing = exerciseMap.get(key);
        exerciseMap.set(key, existing ? this.mergeExercise(existing, normalized) : normalized);
      }
    }

    const sections = Array.from(sectionMap.values()).sort((left, right) =>
      naturalCompare(this.sectionSortLabel(left), this.sectionSortLabel(right))
    );
    const exercises = Array.from(exerciseMap.values()).sort((left, right) =>
      naturalCompare(this.exerciseSortLabel(left), this.exerciseSortLabel(right))
    );

    let chapters = this.dedupeChapters(Array.from(chapterMap.values()).sort((left, right) =>
      naturalCompare(this.chapterSortLabel(left), this.chapterSortLabel(right))
    ));

    if (!chapters.length && sections.length) {
      chapters = this.buildChaptersFromSections(sections, exercises);
    }

    const documentType = Array.from(documentTypes.entries())
      .sort((left, right) => right[1] - left[1])[0]?.[0] as MaterialSummary['documentType'] | undefined;

    return {
      documentType: documentType ?? (sections.length ? 'textbook' : 'unknown'),
      chapters,
      sectionMappings: sections,
      exerciseMappings: exercises,
    };
  }

  private normalizeChapter(input: Partial<MaterialChapterSummary>, index: number): MaterialChapterSummary {
    return {
      chapterNumber: normalizeNumber(input.chapterNumber),
      title: normalizeTitle(input.title, `章节 ${index + 1}`),
      summary: String(input.summary ?? '').trim(),
      keyPoints: uniqueStrings(input.keyPoints ?? [], 8),
      topicMapping: uniqueStrings(input.topicMapping ?? [], 8),
      sectionNumbers: uniqueStrings(input.sectionNumbers ?? [], 12),
      relatedExerciseTitles: uniqueStrings(input.relatedExerciseTitles ?? [], 12),
    };
  }

  private normalizeSection(input: Partial<MaterialSectionMapping>, index: number): MaterialSectionMapping {
    return {
      chapterNumber: normalizeNumber(input.chapterNumber),
      chapterTitle: normalizeTitle(input.chapterTitle, ''),
      sectionNumber: normalizeNumber(input.sectionNumber),
      sectionTitle: normalizeTitle(input.sectionTitle, `小节 ${index + 1}`),
      summary: String(input.summary ?? '').trim(),
      keyPoints: uniqueStrings(input.keyPoints ?? [], 8),
      topicMapping: uniqueStrings(input.topicMapping ?? [], 8),
      anchorTerms: uniqueStrings(input.anchorTerms ?? [], 10),
      relatedExerciseTitles: uniqueStrings(input.relatedExerciseTitles ?? [], 10),
    };
  }

  private normalizeExercise(input: Partial<MaterialExerciseMapping>, index: number): MaterialExerciseMapping {
    return {
      chapterNumber: normalizeNumber(input.chapterNumber),
      chapterTitle: normalizeTitle(input.chapterTitle, ''),
      sectionNumber: normalizeNumber(input.sectionNumber),
      sectionTitle: normalizeTitle(input.sectionTitle, ''),
      title: normalizeTitle(input.title, `练习组 ${index + 1}`),
      exerciseType: normalizeTitle(input.exerciseType, '课后习题'),
      summary: String(input.summary ?? '').trim(),
      keyPoints: uniqueStrings(input.keyPoints ?? [], 8),
      topicMapping: uniqueStrings(input.topicMapping ?? [], 8),
      anchorTerms: uniqueStrings(input.anchorTerms ?? [], 10),
      relatedSections: uniqueStrings(input.relatedSections ?? [], 10),
    };
  }

  private mergeChapter(current: MaterialChapterSummary, incoming: MaterialChapterSummary): MaterialChapterSummary {
    return {
      chapterNumber: incoming.chapterNumber ?? current.chapterNumber,
      title: current.title.startsWith('章节 ') && incoming.title
        ? incoming.title
        : pickLongerText(current.title, incoming.title),
      summary: pickLongerText(current.summary, incoming.summary),
      keyPoints: uniqueStrings([...current.keyPoints, ...incoming.keyPoints], 12),
      topicMapping: uniqueStrings([...current.topicMapping, ...incoming.topicMapping], 12),
      sectionNumbers: uniqueStrings([...(current.sectionNumbers ?? []), ...(incoming.sectionNumbers ?? [])], 20),
      relatedExerciseTitles: uniqueStrings([...(current.relatedExerciseTitles ?? []), ...(incoming.relatedExerciseTitles ?? [])], 20),
    };
  }

  private mergeSection(current: MaterialSectionMapping, incoming: MaterialSectionMapping): MaterialSectionMapping {
    return {
      chapterNumber: incoming.chapterNumber ?? current.chapterNumber,
      chapterTitle: pickLongerText(current.chapterTitle, incoming.chapterTitle),
      sectionNumber: incoming.sectionNumber ?? current.sectionNumber,
      sectionTitle: pickLongerText(current.sectionTitle, incoming.sectionTitle),
      summary: pickLongerText(current.summary, incoming.summary),
      keyPoints: uniqueStrings([...current.keyPoints, ...incoming.keyPoints], 12),
      topicMapping: uniqueStrings([...current.topicMapping, ...incoming.topicMapping], 12),
      anchorTerms: uniqueStrings([...current.anchorTerms, ...incoming.anchorTerms], 12),
      relatedExerciseTitles: uniqueStrings([...(current.relatedExerciseTitles ?? []), ...(incoming.relatedExerciseTitles ?? [])], 12),
    };
  }

  private mergeExercise(current: MaterialExerciseMapping, incoming: MaterialExerciseMapping): MaterialExerciseMapping {
    return {
      chapterNumber: incoming.chapterNumber ?? current.chapterNumber,
      chapterTitle: pickLongerText(current.chapterTitle, incoming.chapterTitle),
      sectionNumber: incoming.sectionNumber ?? current.sectionNumber,
      sectionTitle: pickLongerText(current.sectionTitle, incoming.sectionTitle),
      title: pickLongerText(current.title, incoming.title),
      exerciseType: pickLongerText(current.exerciseType, incoming.exerciseType),
      summary: pickLongerText(current.summary, incoming.summary),
      keyPoints: uniqueStrings([...current.keyPoints, ...incoming.keyPoints], 12),
      topicMapping: uniqueStrings([...current.topicMapping, ...incoming.topicMapping], 12),
      anchorTerms: uniqueStrings([...current.anchorTerms, ...incoming.anchorTerms], 12),
      relatedSections: uniqueStrings([...(current.relatedSections ?? []), ...(incoming.relatedSections ?? [])], 12),
    };
  }

  private buildChaptersFromSections(
    sections: MaterialSectionMapping[],
    exercises: MaterialExerciseMapping[],
  ): MaterialChapterSummary[] {
    const groups = new Map<string, { sections: MaterialSectionMapping[]; exercises: MaterialExerciseMapping[] }>();

    for (const section of sections) {
      const key = section.chapterNumber || section.chapterTitle
        ? `${section.chapterNumber ?? ''}|${section.chapterTitle ?? ''}`
        : 'ungrouped';
      const current = groups.get(key) ?? { sections: [], exercises: [] };
      current.sections.push(section);
      groups.set(key, current);
    }

    for (const exercise of exercises) {
      const key = exercise.chapterNumber || exercise.chapterTitle
        ? `${exercise.chapterNumber ?? ''}|${exercise.chapterTitle ?? ''}`
        : 'ungrouped';
      const current = groups.get(key) ?? { sections: [], exercises: [] };
      current.exercises.push(exercise);
      groups.set(key, current);
    }

    return Array.from(groups.entries()).map(([key, value], index) => {
      const firstSection = value.sections[0];
      const firstExercise = value.exercises[0];
      const chapterNumber = firstSection?.chapterNumber ?? firstExercise?.chapterNumber;
      const title = firstSection?.chapterTitle || firstExercise?.chapterTitle || `章节 ${index + 1}`;
      const summary = value.sections
        .map((section) => section.summary)
        .filter(Boolean)
        .join('；')
        .slice(0, 280);

      const sectionNumbers = value.sections
        .map((section) => section.sectionNumber)
        .filter((item): item is string => !!item)
        .sort(naturalCompare);

      const relatedExerciseTitles = value.exercises.map((exercise) => exercise.title);

      return {
        chapterNumber,
        title: normalizeTitle(title, `章节 ${index + 1}`),
        summary,
        keyPoints: uniqueStrings([
          ...value.sections.flatMap((section) => section.keyPoints),
          ...value.exercises.flatMap((exercise) => exercise.keyPoints),
        ], 10),
        topicMapping: uniqueStrings([
          ...value.sections.flatMap((section) => section.topicMapping),
          ...value.exercises.flatMap((exercise) => exercise.topicMapping),
        ], 10),
        sectionNumbers: uniqueStrings(sectionNumbers, 20),
        relatedExerciseTitles: uniqueStrings(relatedExerciseTitles, 20),
      };
    }).sort((left, right) => naturalCompare(this.chapterSortLabel(left), this.chapterSortLabel(right)));
  }

  private dedupeChapters(chapters: MaterialChapterSummary[]): MaterialChapterSummary[] {
    const chapterMap = new Map<string, MaterialChapterSummary>();

    for (const chapter of chapters) {
      const key = chapter.title.trim().toLowerCase();
      const existing = chapterMap.get(key);
      if (!existing) {
        chapterMap.set(key, chapter);
        continue;
      }

      const primary = this.chapterQualityScore(chapter) > this.chapterQualityScore(existing)
        ? chapter
        : existing;
      const secondary = primary === chapter ? existing : chapter;

      chapterMap.set(key, {
        ...this.mergeChapter(primary, secondary),
        chapterNumber: primary.chapterNumber || secondary.chapterNumber,
        title: primary.title || secondary.title,
      });
    }

    return Array.from(chapterMap.values()).sort((left, right) =>
      naturalCompare(this.chapterSortLabel(left), this.chapterSortLabel(right))
    );
  }

  private chapterQualityScore(chapter: MaterialChapterSummary): number {
    let score = 0;
    if (/^\d+/.test(chapter.chapterNumber ?? '')) {
      score += 10;
    }
    if ((chapter.chapterNumber ?? '').includes('?')) {
      score -= 6;
    }
    score += Math.min(6, chapter.keyPoints.length);
    score += Math.min(8, (chapter.sectionNumbers ?? []).length * 2);
    score += Math.min(5, Math.floor(chapter.summary.length / 80));
    return score;
  }

  private chapterKey(chapter: MaterialChapterSummary): string {
    return `${chapter.chapterNumber ?? ''}|${chapter.title}`.toLowerCase();
  }

  private sectionKey(section: MaterialSectionMapping): string {
    return `${section.chapterNumber ?? ''}|${section.sectionNumber ?? ''}|${section.sectionTitle}`.toLowerCase();
  }

  private exerciseKey(exercise: MaterialExerciseMapping): string {
    return `${exercise.chapterNumber ?? ''}|${exercise.sectionNumber ?? ''}|${exercise.exerciseType}|${exercise.title}`.toLowerCase();
  }

  private chapterSortLabel(chapter: MaterialChapterSummary): string {
    return `${chapter.chapterNumber ?? ''} ${chapter.title}`;
  }

  private sectionSortLabel(section: MaterialSectionMapping): string {
    return `${section.chapterNumber ?? ''} ${section.sectionNumber ?? ''} ${section.sectionTitle}`;
  }

  private exerciseSortLabel(exercise: MaterialExerciseMapping): string {
    return `${exercise.chapterNumber ?? ''} ${exercise.sectionNumber ?? ''} ${exercise.title}`;
  }
}
