import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { MaterialEntry, MaterialExerciseMapping, MaterialIndex, MaterialSectionMapping, MaterialSummary, Subject } from '../types';
import { readJson, writeJson, ensureDir, writeText, fileExists } from '../utils/fileSystem';
import { extractTextFromFile } from './textExtractor';
import { StoragePathResolver, getStoragePathResolver } from '../storage/pathResolver';
import { TextbookParser } from './textbookParser';

interface RetrievedExcerpt {
  materialId: string;
  fileName: string;
  sourceLabel: string;
  excerpt: string;
  score: number;
}

interface GroundingContext {
  summary: string;
  exerciseSummary?: string;
  excerpts: string;
  sourceLabels: string[];
  materialTitle?: string;
}

interface ScoredTextCandidate {
  text: string;
  score: number;
  order: number;
}

export class MaterialManager {
  private paths: StoragePathResolver;
  private parser: TextbookParser;
  private readonly processingEntries = new Map<string, Promise<MaterialEntry>>();
  private readonly indexEmitter = new vscode.EventEmitter<MaterialIndex>();
  readonly onDidChangeIndex = this.indexEmitter.event;

  constructor() {
    this.paths = getStoragePathResolver();
    this.parser = new TextbookParser();
  }

  private get materialsDir(): string {
    return this.paths.materialsDir;
  }

  private get indexPath(): string {
    return this.paths.materialsIndexPath;
  }

  async getIndex(): Promise<MaterialIndex> {
    const current = await readJson<MaterialIndex>(this.indexPath);
    if (current?.materials) {
      return { materials: current.materials.map(entry => this.normalizeEntry(entry)) };
    }

    const legacy = await readJson<MaterialIndex>(this.paths.legacyMaterialsIndexPath);
    if (legacy?.materials) {
      const normalized = { materials: legacy.materials.map(entry => this.normalizeEntry(entry)) };
      await this.saveIndex(normalized);
      return normalized;
    }

    return { materials: [] };
  }

  private async saveIndex(index: MaterialIndex): Promise<void> {
    const normalized = { materials: index.materials.map(entry => this.normalizeEntry(entry)) };
    await writeJson(this.indexPath, normalized);
    this.indexEmitter.fire(normalized);
  }

  private normalizeEntry(entry: MaterialEntry): MaterialEntry {
    const normalized: MaterialEntry = {
      ...entry,
      updatedAt: entry.updatedAt || entry.indexedAt || entry.addedAt,
      indexedAt: entry.indexedAt || undefined,
      lastError: entry.lastError || undefined,
    };

    if (entry.storageDir) {
      return normalized;
    }

    const relativeToMaterials = path.relative(this.paths.materialsDir, entry.filePath || '');
    if (entry.filePath && relativeToMaterials && !relativeToMaterials.startsWith('..')) {
      return {
        ...normalized,
        storageDir: path.dirname(entry.filePath),
      };
    }

    return normalized;
  }

  async getMaterialById(materialId: string): Promise<MaterialEntry | null> {
    const index = await this.getIndex();
    return index.materials.find(material => material.id === materialId) ?? null;
  }

  async importMaterial(subject: Subject): Promise<MaterialEntry | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        '课程资料': ['pdf', 'txt', 'md'],
      },
      title: '选择课程资料文件',
    });

    if (!uris || uris.length === 0) { return null; }

    const sourceFile = uris[0].fsPath;
    const fileName = path.basename(sourceFile);
    const id = `mat-${Date.now()}`;
    const storageDir = this.paths.materialDir(subject, id);
    await ensureDir(storageDir);

    const destPath = this.paths.materialSourcePath(subject, id, fileName);
    await fs.copyFile(sourceFile, destPath);

    const entry: MaterialEntry = {
      id,
      fileName,
      subject,
      storageDir,
      filePath: destPath,
      textPath: this.paths.materialTextPath(subject, id),
      summaryPath: this.paths.materialSummaryPath(subject, id),
      status: 'pending',
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const index = await this.getIndex();
    index.materials.push(entry);
    await this.saveIndex(index);
    await writeJson(this.paths.materialMetaPath(subject, id), entry);

    void this.ensureMaterialIndexed(entry).catch(error => {
      console.error(`Failed to process imported material ${entry.fileName}:`, error);
    });
    return entry;
  }

  async ensureMaterialIndexed(target: MaterialEntry | string): Promise<MaterialEntry | null> {
    const entry = typeof target === 'string'
      ? await this.getMaterialById(target)
      : this.normalizeEntry(target);

    if (!entry) {
      return null;
    }

    const freshEntry = await this._refreshEntry(entry);
    if (freshEntry.status === 'indexed' && await fileExists(freshEntry.summaryPath)) {
      return freshEntry;
    }

    const existing = this.processingEntries.get(freshEntry.id);
    if (existing) {
      return existing;
    }

    const task = this.processEntry(freshEntry).finally(() => {
      this.processingEntries.delete(freshEntry.id);
    });
    this.processingEntries.set(freshEntry.id, task);
    return task;
  }

  async reconcileMaterials(subject?: Subject, options?: { materialId?: string; materialIds?: string[] }): Promise<MaterialEntry[]> {
    const index = await this.getIndex();
    const normalizedIds = Array.isArray(options?.materialIds)
      ? Array.from(new Set(options.materialIds.map((item) => String(item ?? '').trim()).filter(Boolean)))
      : undefined;
    const candidates = normalizedIds !== undefined
      ? normalizedIds
          .map((materialId) => index.materials.find((material) => material.id === materialId) ?? null)
          .filter((material): material is MaterialEntry => !!material)
      : index.materials.filter(material =>
          (!subject || material.subject === subject) &&
          (!options?.materialId || material.id === options.materialId)
        );

    const results: MaterialEntry[] = [];
    for (const candidate of candidates) {
      try {
        const entry = await this.ensureMaterialIndexed(candidate);
        if (entry) {
          results.push(entry);
        }
      } catch (error) {
        console.error(`Failed to reconcile material ${candidate.fileName}:`, error);
        const latest = await this.getMaterialById(candidate.id);
        if (latest) {
          results.push(latest);
        }
      }
    }

    return results;
  }

  private async processEntry(entry: MaterialEntry): Promise<MaterialEntry> {
    let current = await this._refreshEntry(entry);

    try {
      current = await this._restoreIndexedStateFromSummary(current);
      if (current.status === 'indexed' && await fileExists(current.summaryPath)) {
        return current;
      }

      const text = await this._ensureTextForIndexing(current);
      current = await this._setEntryState(current, 'extracted', {
        lastError: undefined,
      });

      const summary = await this.parser.parse(text, current.subject);
      summary.materialId = current.id;
      await writeJson(current.summaryPath, summary);

      current = await this._setEntryState(current, 'indexed', {
        indexedAt: summary.parserMeta?.generatedAt || new Date().toISOString(),
        lastError: undefined,
      });
      return current;
    } catch (error) {
      const message = this._formatProcessingError(error);
      current = await this._setEntryState(current, 'failed', {
        lastError: message,
      });
      throw new Error(`资料索引失败：${current.fileName} - ${message}`);
    }
  }

  private async _updateEntry(entry: MaterialEntry): Promise<void> {
    const index = await this.getIndex();
    const idx = index.materials.findIndex(material => material.id === entry.id);
    if (idx < 0) {
      return;
    }
    index.materials[idx] = this.normalizeEntry(entry);
    await this.saveIndex(index);
    if (entry.storageDir) {
      await writeJson(this.paths.materialMetaPath(entry.subject, entry.id), this.normalizeEntry(entry));
    }
  }

  async deleteMaterial(materialId: string): Promise<void> {
    const index = await this.getIndex();
    const idx = index.materials.findIndex(material => material.id === materialId);
    if (idx < 0) { return; }

    const entry = index.materials[idx];
    const tryRemove = async (filePath: string) => {
      try {
        await fs.unlink(filePath);
      } catch {
        // Ignore missing files during cleanup.
      }
    };

    if (entry.storageDir) {
      try {
        await fs.rm(entry.storageDir, { recursive: true, force: true });
      } catch {
        // Ignore storage directory cleanup failures.
      }
    } else {
      if (entry.filePath) { await tryRemove(entry.filePath); }
      if (entry.textPath) { await tryRemove(entry.textPath); }
      if (entry.summaryPath) { await tryRemove(entry.summaryPath); }
    }

    index.materials.splice(idx, 1);
    await this.saveIndex(index);
    this.processingEntries.delete(materialId);
  }

  /** Get material summaries relevant to a topic, for prompt injection. */
  async getRelevantSummary(subject: Subject, topicTitle: string, options?: { materialId?: string; materialIds?: string[] }): Promise<string> {
    const subjectMaterials = await this._getIndexedMaterials(subject, options);
    const keywords = this._extractSearchTerms(topicTitle);
    const exerciseFocusedQuery = /(习题|练习|题目|作业|例题|章末|复习题|综合练习)/i.test(topicTitle);

    return this._buildRelevantSummaryText(subjectMaterials, topicTitle, keywords, exerciseFocusedQuery);
    /*
    let matched = '';
    let fallback = '';

    for (const mat of subjectMaterials) {
      const summary = await this._loadMaterialSummary(mat);
      if (!summary) { continue; }

      const chapters = summary.chapters || [];
      const sections = summary.sectionMappings || [];
      const exercises = (summary.exerciseMappings || []).slice(0, 30);
      const fallbackChapters = chapters.slice(0, 2);
      if (fallbackChapters.length) {
        fallback += `资料：${mat.fileName}\n`;
        for (const ch of fallbackChapters) {
          fallback += `- ${this._formatChapterLabel(ch)}：${ch.summary}\n知识点：${ch.keyPoints.join('、')}\n`;
        }
        fallback += '\n';
      }

      if (!fallbackChapters.length && sections.length) {
        fallback += `资料：${mat.fileName}\n`;
        for (const section of sections.slice(0, 2)) {
          fallback += `- ${this._formatSectionLabel(section)}：${section.summary}\n知识点：${section.keyPoints.join('、')}\n`;
        }
        fallback += '\n';
      }

      for (const ch of chapters) {
        const chapterText = `${ch.chapterNumber ?? ''} ${ch.title} ${ch.summary} ${ch.keyPoints.join(' ')} ${ch.topicMapping.join(' ')} ${(ch.sectionNumbers || []).join(' ')} ${(ch.relatedExerciseTitles || []).join(' ')}`.toLowerCase();
        const isRelevant = keywords.length > 0 && keywords.some(keyword => chapterText.includes(keyword));
        if (!isRelevant) { continue; }
        matched += `资料：${mat.fileName}\n- ${this._formatChapterLabel(ch)}：${ch.summary}\n知识点：${ch.keyPoints.join('、')}\n`;
        if (ch.relatedExerciseTitles?.length) {
          matched += `关联习题：${ch.relatedExerciseTitles.join('、')}\n`;
        }
        matched += '\n';
      }

      for (const section of sections) {
        const sectionText = `${section.chapterNumber ?? ''} ${section.chapterTitle ?? ''} ${section.sectionNumber ?? ''} ${section.sectionTitle} ${section.summary} ${section.keyPoints.join(' ')} ${section.topicMapping.join(' ')} ${section.anchorTerms.join(' ')} ${(section.relatedExerciseTitles || []).join(' ')}`.toLowerCase();
        const isRelevant = keywords.length > 0 && keywords.some(keyword => sectionText.includes(keyword));
        if (!isRelevant) { continue; }
        matched += `资料：${mat.fileName}\n- ${this._formatSectionLabel(section)}：${section.summary}\n知识点：${section.keyPoints.join('、')}\n`;
        if (section.relatedExerciseTitles?.length) {
          matched += `关联习题：${section.relatedExerciseTitles.join('、')}\n`;
        }
        matched += '\n';
      }

      for (const exercise of exercises) {
        const exerciseText = `${exercise.chapterNumber ?? ''} ${exercise.chapterTitle ?? ''} ${exercise.sectionNumber ?? ''} ${exercise.sectionTitle ?? ''} ${exercise.title} ${exercise.exerciseType} ${exercise.summary} ${exercise.keyPoints.join(' ')} ${exercise.topicMapping.join(' ')} ${exercise.anchorTerms.join(' ')} ${(exercise.relatedSections || []).join(' ')}`.toLowerCase();
        const isRelevant = keywords.length > 0 && keywords.some(keyword => exerciseText.includes(keyword));
        if (!isRelevant && !exerciseFocusedQuery) { continue; }
        matched += `资料：${mat.fileName}\n- ${this._formatExerciseLabel(exercise)}：${exercise.summary}\n考查点：${exercise.keyPoints.join('、')}\n`;
        if (exercise.relatedSections?.length) {
          matched += `关联小节：${exercise.relatedSections.join('、')}\n`;
        }
        matched += '\n';
      }
    }

    return (matched || fallback).slice(0, 3000);
    */
  }

  async buildGroundingContext(
    subject: Subject,
    query: string,
    options?: { materialId?: string; materialIds?: string[]; maxExcerpts?: number }
  ): Promise<GroundingContext> {
    const material = options?.materialId ? await this.getMaterialById(options.materialId) : null;
    const summary = await this.getRelevantSummary(subject, query, options);
    const exerciseSummary = await this.getRelevantExerciseSummary(subject, query, options);
    const excerpts = await this.retrieveRelevantExcerpts(subject, query, options);

    return {
      summary,
      exerciseSummary,
      excerpts: this._formatExcerpts(excerpts),
      sourceLabels: Array.from(new Set(excerpts.map(item => item.fileName))),
      materialTitle: material?.fileName,
    };
  }

  async getRelevantExerciseSummary(subject: Subject, query: string, options?: { materialId?: string; materialIds?: string[] }): Promise<string> {
    const materials = await this._getIndexedMaterials(subject, options);
    const keywords = this._extractSearchTerms(query);
    return this._buildRelevantExerciseSummaryText(materials, query, keywords);
    /*
    let matched = '';
    let fallback = '';

    for (const mat of materials) {
      const summary = await this._loadMaterialSummary(mat);
      if (!summary) {
        continue;
      }

      const exercises = summary.exerciseMappings || [];
      if (!exercises.length) {
        continue;
      }

      const fallbackItems = exercises.slice(0, 2);
      if (fallbackItems.length) {
        fallback += `资料习题参考：${mat.fileName}\n`;
        for (const item of fallbackItems) {
          fallback += `- ${this._formatExerciseLabel(item)}：${item.summary}\n考点：${item.keyPoints.join('、')}\n`;
        }
        fallback += '\n';
      }

      for (const item of exercises) {
        const haystack = [
          item.chapterNumber,
          item.chapterTitle,
          item.sectionNumber,
          item.sectionTitle,
          item.title,
          item.exerciseType,
          item.summary,
          item.keyPoints.join(' '),
          item.topicMapping.join(' '),
          item.anchorTerms.join(' '),
          (item.relatedSections || []).join(' '),
        ].join(' ').toLowerCase();

        const isRelevant = keywords.length === 0 || keywords.some(keyword => haystack.includes(keyword));
        if (!isRelevant) {
          continue;
        }

        matched += `资料习题参考：${mat.fileName}\n`;
        matched += `- ${this._formatExerciseLabel(item)}：${item.summary}\n`;
        if (item.keyPoints.length) {
          matched += `考点：${item.keyPoints.join('、')}\n`;
        }
        if (item.relatedSections?.length) {
          matched += `对应章节：${item.relatedSections.join('、')}\n`;
        }
        matched += '\n';
      }
    }

    return (matched || fallback).slice(0, 2500);
    */
  }

  private async retrieveRelevantExcerpts(
    subject: Subject,
    query: string,
    options?: { materialId?: string; materialIds?: string[]; maxExcerpts?: number }
  ): Promise<RetrievedExcerpt[]> {
    const materials = await this._getIndexedMaterials(subject, options);
    const maxExcerpts = options?.maxExcerpts ?? 4;
    const queryText = query.trim().toLowerCase();
    const keywords = this._extractSearchTerms(query);
    return this._retrieveRelevantExcerptsWholeBook(materials, queryText, keywords, maxExcerpts);
    /*
    const results: RetrievedExcerpt[] = [];

    for (const material of materials) {
      const text = await this._readMaterialText(material);
      if (!text) { continue; }

      const chunks = this._chunkText(text);
      chunks.forEach((chunk, index) => {
        const normalizedChunk = chunk.toLowerCase();
        const score = this._scoreChunk(normalizedChunk, queryText, keywords);
        if (score <= 0) { return; }
        results.push({
          materialId: material.id,
          fileName: material.fileName,
          sourceLabel: `${material.fileName} · 片段 ${index + 1}`,
          excerpt: chunk,
          score,
        });
      });
    }

    if (!results.length) {
      return this._buildFallbackExcerpts(materials, maxExcerpts);
    }

    return results
      .sort((a, b) => b.score - a.score || a.excerpt.length - b.excerpt.length)
      .slice(0, maxExcerpts);
    */
  }

  private async _buildFallbackExcerpts(materials: MaterialEntry[], maxExcerpts: number): Promise<RetrievedExcerpt[]> {
    return this._buildDistributedFallbackExcerpts(materials, maxExcerpts);
    const fallback: RetrievedExcerpt[] = [];

    for (const material of materials) {
      if (fallback.length >= maxExcerpts) { break; }
      const text = await this._readMaterialText(material);
      if (!text) { continue; }

      const chunks = this._chunkText(text);
      chunks.forEach((chunk, index) => {
        if (fallback.length >= maxExcerpts) { return; }
        fallback.push({
          materialId: material.id,
          fileName: material.fileName,
          sourceLabel: `${material.fileName} · 片段 ${index + 1}`,
          excerpt: chunk,
          score: 1,
        });
      });
    }

    return fallback;
  }

  private _formatExcerpts(excerpts: RetrievedExcerpt[]): string {
    if (!excerpts.length) { return ''; }

    let formatted = '';
    for (const [index, excerpt] of excerpts.entries()) {
      const block = `[资料片段 ${index + 1}] ${excerpt.sourceLabel}\n${excerpt.excerpt}`;
      const next = formatted ? `${formatted}\n\n${block}` : block;
      if (next.length > 5000) {
        if (!formatted) {
          return block.slice(0, 5000);
        }
        break;
      }
      formatted = next;
    }

    return formatted;
  }

  private _normalizeRequestedMaterialIds(options?: { materialId?: string; materialIds?: string[] }): string[] | undefined {
    if (Array.isArray(options?.materialIds)) {
      return Array.from(new Set(options.materialIds.map((item) => String(item ?? '').trim()).filter(Boolean)));
    }

    if (options?.materialId) {
      return [options.materialId];
    }

    return undefined;
  }

  private _resolveRequestedMaterials(materials: MaterialEntry[], materialIds: string[]): MaterialEntry[] {
    if (materialIds.length === 0) {
      return [];
    }

    return materialIds
      .map((materialId) => materials.find((material) => material.id === materialId) ?? null)
      .filter((entry): entry is MaterialEntry => !!entry);
  }

  private async _getIndexedMaterials(
    subject: Subject,
    options?: { materialId?: string; materialIds?: string[] },
  ): Promise<MaterialEntry[]> {
    const index = await this.getIndex();
    const normalizedIds = this._normalizeRequestedMaterialIds(options);
    const candidates = normalizedIds !== undefined
      ? this._resolveRequestedMaterials(index.materials, normalizedIds)
      : index.materials.filter((material) => material.subject === subject);

    const ready: MaterialEntry[] = [];
    for (const candidate of candidates) {
      try {
        const ensured = await this.ensureMaterialIndexed(candidate);
        if (ensured?.status === 'indexed') {
          ready.push(ensured);
        }
      } catch (error) {
        if (normalizedIds !== undefined && normalizedIds.includes(candidate.id)) {
          throw error;
        }
        console.error(`Skipping unindexed material ${candidate.fileName}:`, error);
      }
    }

    return ready;
  }

  private async _refreshEntry(entry: MaterialEntry): Promise<MaterialEntry> {
    return this.normalizeEntry(await this.getMaterialById(entry.id) ?? entry);
  }

  private async _restoreIndexedStateFromSummary(entry: MaterialEntry): Promise<MaterialEntry> {
    if (!await fileExists(entry.summaryPath)) {
      return entry;
    }

    const summary = await readJson<MaterialSummary>(entry.summaryPath);
    if (!summary) {
      return entry;
    }

    if (entry.status === 'indexed' && !entry.lastError) {
      return entry;
    }

    return this._setEntryState(entry, 'indexed', {
      indexedAt: summary.parserMeta?.generatedAt || entry.indexedAt || new Date().toISOString(),
      lastError: undefined,
    });
  }

  private async _ensureTextForIndexing(entry: MaterialEntry): Promise<string> {
    if (await fileExists(entry.textPath)) {
      const cached = await this.ensureMaterialText(entry);
      if (cached.trim()) {
        return cached;
      }
    }

    const extracted = await extractTextFromFile(entry.filePath);
    if (!extracted.replace(/\s/g, '').length) {
      throw new Error('未能从资料中提取到可用文本');
    }

    await writeText(entry.textPath, extracted);
    return extracted;
  }

  private async _setEntryState(
    entry: MaterialEntry,
    status: MaterialEntry['status'],
    overrides?: Partial<Pick<MaterialEntry, 'indexedAt' | 'lastError'>>
  ): Promise<MaterialEntry> {
    const updated: MaterialEntry = this.normalizeEntry({
      ...entry,
      status,
      indexedAt: overrides?.indexedAt ?? entry.indexedAt,
      lastError: overrides?.lastError,
      updatedAt: new Date().toISOString(),
    });
    await this._updateEntry(updated);
    return updated;
  }

  private _formatProcessingError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || '未知错误');
  }

  async ensureMaterialText(entry: MaterialEntry): Promise<string> {
    let content = '';

    if (await fileExists(entry.textPath)) {
      content = await fs.readFile(entry.textPath, 'utf-8');
      if (content.replace(/\s/g, '').length >= 200) {
        return content;
      }
    }

    const ext = path.extname(entry.filePath).toLowerCase();
    if (ext !== '.pdf') {
      return content;
    }

    const refreshed = await extractTextFromFile(entry.filePath);
    if (refreshed.replace(/\s/g, '').length >= 200) {
      await writeText(entry.textPath, refreshed);
      return refreshed;
    }

    return content || refreshed;
  }

  private async _readMaterialText(entry: MaterialEntry): Promise<string> {
    if (await fileExists(entry.textPath)) {
      const content = await this.ensureMaterialText(entry);
      if (content) {
        return content;
      }
    }

    const ext = path.extname(entry.filePath).toLowerCase();
    if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      return fs.readFile(entry.filePath, 'utf-8');
    }

    return '';
  }

  private async _loadMaterialSummary(entry: MaterialEntry): Promise<MaterialSummary | null> {
    const current = await readJson<MaterialSummary>(entry.summaryPath);
    if (!current) {
      return null;
    }

    const hasStructuredMappings = (current.sectionMappings ?? []).length > 0
      || (current.exerciseMappings ?? []).length > 0
      || !!current.parserMeta;

    if (hasStructuredMappings) {
      return current;
    }

    const text = await this._readMaterialText(entry);
    if (!text.trim()) {
      return current;
    }

    try {
      const rebuilt = await this.parser.parse(text, entry.subject);
      rebuilt.materialId = entry.id;
      await writeJson(entry.summaryPath, rebuilt);
      return rebuilt;
    } catch (error) {
      console.error(`Failed to upgrade material summary for ${entry.fileName}:`, error);
      return current;
    }
  }

  private _formatChapterLabel(chapter: MaterialSummary['chapters'][number]): string {
    return [chapter.chapterNumber, chapter.title].filter(Boolean).join(' ');
  }

  private _formatSectionLabel(section: MaterialSectionMapping): string {
    const chapter = [section.chapterNumber, section.chapterTitle].filter(Boolean).join(' ');
    const sectionLabel = [section.sectionNumber, section.sectionTitle].filter(Boolean).join(' ');
    return [chapter, sectionLabel].filter(Boolean).join(' / ');
  }

  private _formatExerciseLabel(exercise: MaterialExerciseMapping): string {
    const chapter = [exercise.chapterNumber, exercise.chapterTitle].filter(Boolean).join(' ');
    const sectionLabel = [exercise.sectionNumber, exercise.sectionTitle].filter(Boolean).join(' ');
    const title = [exercise.title, exercise.exerciseType].filter(Boolean).join(' / ');
    return [chapter, sectionLabel, title].filter(Boolean).join(' / ');
  }

  private _chunkText(text: string): string[] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').trim();
    if (!normalized) { return []; }

    const chunks: string[] = [];
    const paragraphs = normalized.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean);
    let current = '';

    for (const paragraph of paragraphs) {
      const segments = paragraph.length > 900 ? this._splitLongText(paragraph, 700) : [paragraph];
      for (const segment of segments) {
        if (!segment) { continue; }
        const next = current ? `${current}\n\n${segment}` : segment;
        if (next.length > 900 && current) {
          chunks.push(current);
          current = segment;
        } else {
          current = next;
        }
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private async _buildRelevantSummaryText(
    materials: MaterialEntry[],
    topicTitle: string,
    keywords: string[],
    exerciseFocusedQuery: boolean,
  ): Promise<string> {
    const queryText = topicTitle.trim().toLowerCase();
    const matched: ScoredTextCandidate[] = [];
    const fallback: ScoredTextCandidate[] = [];
    let order = 0;

    for (const mat of materials) {
      const summary = await this._loadMaterialSummary(mat);
      if (!summary) {
        continue;
      }

      const chapters = summary.chapters || [];
      const sections = summary.sectionMappings || [];
      const exercises = summary.exerciseMappings || [];

      fallback.push({
        order: order++,
        score: 1,
        text: [
          `资料：${mat.fileName}`,
          `- 结构概览：章 ${chapters.length} / 节 ${sections.length} / 习题 ${exercises.length}`,
        ].join('\n'),
      });

      const coverageChapters = chapters.length
        ? chapters
        : this._sampleDistributed(sections, 6).map(section => ({
            chapterNumber: section.chapterNumber,
            title: this._formatSectionLabel(section),
            summary: section.summary,
            keyPoints: section.keyPoints,
            topicMapping: section.topicMapping,
            sectionNumbers: section.sectionNumber ? [section.sectionNumber] : [],
            relatedExerciseTitles: section.relatedExerciseTitles,
          }));

      for (const chapter of coverageChapters) {
        fallback.push({
          order: order++,
          score: 1,
          text: [
            `资料：${mat.fileName}`,
            `- ${this._formatChapterLabel(chapter)}：${this._compactText(chapter.summary, 120)}`,
            `知识点：${this._compactList(chapter.keyPoints, 120)}`,
          ].join('\n'),
        });
      }

      for (const exercise of this._sampleDistributed(exercises, 4)) {
        fallback.push({
          order: order++,
          score: 1,
          text: [
            `资料：${mat.fileName}`,
            `- ${this._formatExerciseLabel(exercise)}：${this._compactText(exercise.summary, 110)}`,
            `考点：${this._compactList(exercise.keyPoints, 100)}`,
          ].join('\n'),
        });
      }

      if (!queryText && !keywords.length) {
        continue;
      }

      for (const chapter of chapters) {
        const haystack = [
          chapter.chapterNumber,
          chapter.title,
          chapter.summary,
          chapter.keyPoints.join(' '),
          chapter.topicMapping.join(' '),
          (chapter.sectionNumbers || []).join(' '),
          (chapter.relatedExerciseTitles || []).join(' '),
        ].join(' ').toLowerCase();
        const score = this._scoreChunk(haystack, queryText, keywords);
        if (score <= 0) {
          continue;
        }

        const lines = [
          `资料：${mat.fileName}`,
          `- ${this._formatChapterLabel(chapter)}：${this._compactText(chapter.summary, 140)}`,
          `知识点：${this._compactList(chapter.keyPoints, 120)}`,
        ];
        if (chapter.relatedExerciseTitles?.length) {
          lines.push(`关联习题：${this._compactList(chapter.relatedExerciseTitles, 120)}`);
        }
        matched.push({
          order: order++,
          score,
          text: lines.join('\n'),
        });
      }

      for (const section of sections) {
        const haystack = [
          section.chapterNumber,
          section.chapterTitle,
          section.sectionNumber,
          section.sectionTitle,
          section.summary,
          section.keyPoints.join(' '),
          section.topicMapping.join(' '),
          section.anchorTerms.join(' '),
          (section.relatedExerciseTitles || []).join(' '),
        ].join(' ').toLowerCase();
        const score = this._scoreChunk(haystack, queryText, keywords);
        if (score <= 0) {
          continue;
        }

        const lines = [
          `资料：${mat.fileName}`,
          `- ${this._formatSectionLabel(section)}：${this._compactText(section.summary, 140)}`,
          `知识点：${this._compactList(section.keyPoints, 120)}`,
        ];
        if (section.relatedExerciseTitles?.length) {
          lines.push(`关联习题：${this._compactList(section.relatedExerciseTitles, 120)}`);
        }
        matched.push({
          order: order++,
          score,
          text: lines.join('\n'),
        });
      }

      for (const exercise of exercises) {
        const haystack = [
          exercise.chapterNumber,
          exercise.chapterTitle,
          exercise.sectionNumber,
          exercise.sectionTitle,
          exercise.title,
          exercise.exerciseType,
          exercise.summary,
          exercise.keyPoints.join(' '),
          exercise.topicMapping.join(' '),
          exercise.anchorTerms.join(' '),
          (exercise.relatedSections || []).join(' '),
        ].join(' ').toLowerCase();
        const score = this._scoreChunk(haystack, queryText, keywords) + (exerciseFocusedQuery ? 4 : 0);
        if (score <= 0) {
          continue;
        }

        const lines = [
          `资料：${mat.fileName}`,
          `- ${this._formatExerciseLabel(exercise)}：${this._compactText(exercise.summary, 130)}`,
          `考点：${this._compactList(exercise.keyPoints, 110)}`,
        ];
        if (exercise.relatedSections?.length) {
          lines.push(`对应小节：${this._compactList(exercise.relatedSections, 110)}`);
        }
        matched.push({
          order: order++,
          score,
          text: lines.join('\n'),
        });
      }
    }

    return this._selectBudgetedText(matched, 4200, fallback);
  }

  private async _buildRelevantExerciseSummaryText(
    materials: MaterialEntry[],
    query: string,
    keywords: string[],
  ): Promise<string> {
    const queryText = query.trim().toLowerCase();
    const exerciseFocusedQuery = /(习题|练习|题目|作业|例题|章末|复习|综合练习)/i.test(query);
    const matched: ScoredTextCandidate[] = [];
    const fallback: ScoredTextCandidate[] = [];
    let order = 0;

    for (const mat of materials) {
      const summary = await this._loadMaterialSummary(mat);
      if (!summary) {
        continue;
      }

      const exercises = summary.exerciseMappings || [];
      if (!exercises.length) {
        continue;
      }

      for (const item of this._sampleDistributed(exercises, 6)) {
        fallback.push({
          order: order++,
          score: 1,
          text: [
            `资料习题参考：${mat.fileName}`,
            `- ${this._formatExerciseLabel(item)}：${this._compactText(item.summary, 120)}`,
            `考点：${this._compactList(item.keyPoints, 100)}`,
          ].join('\n'),
        });
      }

      if (!queryText && !keywords.length) {
        continue;
      }

      for (const item of exercises) {
        const haystack = [
          item.chapterNumber,
          item.chapterTitle,
          item.sectionNumber,
          item.sectionTitle,
          item.title,
          item.exerciseType,
          item.summary,
          item.keyPoints.join(' '),
          item.topicMapping.join(' '),
          item.anchorTerms.join(' '),
          (item.relatedSections || []).join(' '),
        ].join(' ').toLowerCase();
        const score = this._scoreChunk(haystack, queryText, keywords) + (exerciseFocusedQuery ? 4 : 0);
        if (score <= 0) {
          continue;
        }

        const lines = [
          `资料习题参考：${mat.fileName}`,
          `- ${this._formatExerciseLabel(item)}：${this._compactText(item.summary, 130)}`,
        ];
        if (item.keyPoints.length) {
          lines.push(`考点：${this._compactList(item.keyPoints, 110)}`);
        }
        if (item.relatedSections?.length) {
          lines.push(`对应章节：${this._compactList(item.relatedSections, 110)}`);
        }
        matched.push({
          order: order++,
          score,
          text: lines.join('\n'),
        });
      }
    }

    return this._selectBudgetedText(matched, 3200, fallback);
  }

  private async _retrieveRelevantExcerptsWholeBook(
    materials: MaterialEntry[],
    queryText: string,
    keywords: string[],
    maxExcerpts: number,
  ): Promise<RetrievedExcerpt[]> {
    if (!queryText && !keywords.length) {
      return this._buildDistributedFallbackExcerpts(materials, maxExcerpts);
    }

    const results: RetrievedExcerpt[] = [];

    for (const material of materials) {
      const text = await this._readMaterialText(material);
      if (!text) {
        continue;
      }

      const chunks = this._chunkText(text);
      chunks.forEach((chunk, index) => {
        const score = this._scoreChunk(chunk.toLowerCase(), queryText, keywords);
        if (score <= 0) {
          return;
        }
        results.push({
          materialId: material.id,
          fileName: material.fileName,
          sourceLabel: `${material.fileName} / 片段 ${index + 1}`,
          excerpt: chunk,
          score,
        });
      });
    }

    if (!results.length) {
      return this._buildDistributedFallbackExcerpts(materials, maxExcerpts);
    }

    return results
      .sort((left, right) => right.score - left.score || left.excerpt.length - right.excerpt.length)
      .slice(0, maxExcerpts);
  }

  private async _buildDistributedFallbackExcerpts(
    materials: MaterialEntry[],
    maxExcerpts: number,
  ): Promise<RetrievedExcerpt[]> {
    const fallback: RetrievedExcerpt[] = [];

    for (const material of materials) {
      if (fallback.length >= maxExcerpts) {
        break;
      }

      const text = await this._readMaterialText(material);
      if (!text) {
        continue;
      }

      const chunks = this._chunkText(text);
      const sampledIndexes = this._sampleDistributed(
        chunks.map((_, index) => index),
        Math.min(3, maxExcerpts - fallback.length),
      );

      for (const chunkIndex of sampledIndexes) {
        if (fallback.length >= maxExcerpts) {
          break;
        }
        fallback.push({
          materialId: material.id,
          fileName: material.fileName,
          sourceLabel: `${material.fileName} / 片段 ${chunkIndex + 1}`,
          excerpt: chunks[chunkIndex],
          score: 1,
        });
      }
    }

    return fallback;
  }

  private _compactText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '暂无';
    }

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
  }

  private _compactList(values: string[] | undefined, maxChars: number, maxItems = 6): string {
    const cleaned = (values || [])
      .map(value => value.trim())
      .filter(Boolean)
      .slice(0, maxItems);

    if (!cleaned.length) {
      return '暂无';
    }

    return this._compactText(cleaned.join('、'), maxChars);
  }

  private _sampleDistributed<T>(items: T[], maxItems: number): T[] {
    if (!items.length || maxItems <= 0) {
      return [];
    }

    if (items.length <= maxItems) {
      return items;
    }

    const sampled: T[] = [];
    const usedIndexes = new Set<number>();

    for (let cursor = 0; cursor < maxItems; cursor++) {
      const ratio = maxItems === 1 ? 0 : cursor / (maxItems - 1);
      const index = Math.round(ratio * (items.length - 1));
      if (usedIndexes.has(index)) {
        continue;
      }
      usedIndexes.add(index);
      sampled.push(items[index]);
    }

    return sampled;
  }

  private _selectBudgetedText(
    matched: ScoredTextCandidate[],
    maxChars: number,
    fallback: ScoredTextCandidate[],
  ): string {
    const pool = matched.length
      ? [...matched].sort((left, right) => right.score - left.score || left.order - right.order)
      : [...fallback].sort((left, right) => left.order - right.order);

    let result = '';
    for (const candidate of pool) {
      const next = result ? `${result}\n\n${candidate.text}` : candidate.text;
      if (next.length > maxChars) {
        if (!result) {
          return candidate.text.slice(0, maxChars);
        }
        break;
      }
      result = next;
    }

    return result;
  }

  private _splitLongText(text: string, maxLength: number): string[] {
    const sentences = text
      .split(/(?<=[。！？.!?])\s+|\n+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    if (!sentences.length) {
      const parts: string[] = [];
      for (let i = 0; i < text.length; i += maxLength) {
        parts.push(text.slice(i, i + maxLength).trim());
      }
      return parts.filter(Boolean);
    }

    const parts: string[] = [];
    let current = '';
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence}` : sentence;
      if (next.length > maxLength && current) {
        parts.push(current);
        current = sentence;
      } else {
        current = next;
      }
    }
    if (current) {
      parts.push(current);
    }
    return parts;
  }

  private _extractSearchTerms(query: string): string[] {
    const normalized = query.toLowerCase();
    const terms = new Set<string>();

    const latinWords = normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
    latinWords.forEach(word => terms.add(word));

    const cjkPhrases = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    cjkPhrases.forEach(phrase => {
      terms.add(phrase);
      const maxGram = Math.min(4, phrase.length);
      for (let size = 2; size <= maxGram; size++) {
        for (let index = 0; index <= phrase.length - size; index++) {
          terms.add(phrase.slice(index, index + size));
        }
      }
    });

    return Array.from(terms)
      .filter(term => term.length > 1)
      .sort((left, right) => right.length - left.length)
      .slice(0, 24);
  }

  private _scoreChunk(chunk: string, query: string, keywords: string[]): number {
    let score = 0;

    if (query.length > 3 && chunk.includes(query)) {
      score += 30;
    }

    for (const keyword of keywords) {
      if (!chunk.includes(keyword)) { continue; }
      if (keyword.length >= 6) {
        score += 10;
      } else if (keyword.length >= 4) {
        score += 7;
      } else if (keyword.length >= 3) {
        score += 4;
      } else {
        score += 2;
      }
    }

    if (!keywords.length && chunk.length > 0) {
      score = 1;
    }

    return score;
  }
}
