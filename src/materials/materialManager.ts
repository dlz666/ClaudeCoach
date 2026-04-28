import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GroundingSource, MaterialEntry, MaterialExerciseMapping, MaterialIndex, MaterialSectionMapping, MaterialSummary, Subject } from '../types';
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
  sectionLabel?: string;
}

interface LocatedSection {
  materialId: string;
  sectionLabel: string;
  anchorTerms: string[];
}

/**
 * v2 grounding context. Adds detailed `sources` so the front-end can render
 * which file/section/excerpt actually fed the prompt.
 *
 * `sourceLabels` 仍然保留，便于现有调用方平滑切换。
 */
interface GroundingContextV2 {
  summary: string;
  exerciseSummary?: string;
  excerpts: string;
  sourceLabels: string[];
  sources: GroundingSource[];
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

  async importMaterial(subject: Subject, materialType?: import('../types').MaterialType): Promise<MaterialEntry | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        '课程资料': ['pdf', 'txt', 'md'],
      },
      title: '选择课程资料文件',
    });

    if (!uris || uris.length === 0) { return null; }

    // 如果调用方未指定 materialType，弹一个 QuickPick 让用户选
    let resolvedType: import('../types').MaterialType = materialType ?? 'other';
    if (!materialType) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '📚 教材/参考书', value: 'textbook' as const },
          { label: '📝 课堂笔记/讲义', value: 'lecture-notes' as const },
          { label: '📖 官方文档/API', value: 'official-doc' as const },
          { label: '📋 真题/模拟卷', value: 'exam-paper' as const },
          { label: '📄 学术论文', value: 'paper' as const },
          { label: '🗂 速查表/汇总', value: 'cheatsheet' as const },
          { label: '🎬 视频字幕', value: 'video-transcript' as const },
          { label: '📁 其他/未分类', value: 'other' as const },
        ],
        {
          placeHolder: '资料类型（影响 AI 检索时如何使用这份资料）',
        },
      );
      if (choice) resolvedType = choice.value;
    }

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
      materialType: resolvedType,
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

  /** 更新资料类型（影响后续检索加权）。 */
  async setMaterialType(materialId: string, materialType: import('../types').MaterialType): Promise<boolean> {
    const index = await this.getIndex();
    const idx = index.materials.findIndex((m) => m.id === materialId);
    if (idx < 0) return false;
    index.materials[idx] = { ...index.materials[idx], materialType, updatedAt: new Date().toISOString() };
    await this.saveIndex(index);
    if (index.materials[idx].storageDir) {
      await writeJson(this.paths.materialMetaPath(index.materials[idx].subject, materialId), index.materials[idx]);
    }
    return true;
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
    options?: { materialId?: string; materialIds?: string[]; maxExcerpts?: number; courseTags?: import('../types').CourseTag[] }
  ): Promise<GroundingContextV2> {
    const material = options?.materialId ? await this.getMaterialById(options.materialId) : null;
    const summary = await this.getRelevantSummary(subject, query, options);
    const exerciseSummary = await this.getRelevantExerciseSummary(subject, query, options);
    const excerpts = await this.retrieveRelevantExcerpts(subject, query, options);

    const sources: GroundingSource[] = excerpts.map(item => ({
      materialId: item.materialId,
      fileName: item.fileName,
      excerpt: item.excerpt.slice(0, 240),
      score: item.score,
      sectionLabel: item.sectionLabel,
    }));

    return {
      summary,
      exerciseSummary,
      excerpts: this._formatExcerpts(excerpts),
      sourceLabels: Array.from(new Set(excerpts.map(item => item.fileName))),
      sources,
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
    options?: { materialId?: string; materialIds?: string[]; maxExcerpts?: number; courseTags?: import('../types').CourseTag[] }
  ): Promise<RetrievedExcerpt[]> {
    const materials = await this._getIndexedMaterials(subject, options);
    const maxExcerpts = options?.maxExcerpts ?? 4;
    const queryText = query.trim().toLowerCase();
    const keywords = this._extractSearchTerms(query);
    return this._retrieveRelevantExcerptsWholeBook(materials, queryText, keywords, maxExcerpts, options?.courseTags);
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

      // Lightweight fallback marker: 1 行说明，不再注入完整章节/示例习题列表。
      const fallbackTag = keywords.length
        ? '（未命中关键词）'
        : '';
      fallback.push({
        order: order++,
        score: 1,
        text: [
          `资料：${mat.fileName}`,
          `- 结构概览：章 ${chapters.length} / 节 ${sections.length} / 习题 ${exercises.length}${fallbackTag}`,
        ].join('\n'),
      });

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

    // 关键词非空且没命中：返回空字符串，避免 fallback 污染上下文。
    if (keywords.length && !matched.length) {
      return '';
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

      // 仅在“无关键词全局生成”场景下保留 fallback 提示：单行结构概览。
      const fallbackTag = keywords.length
        ? '（未命中关键词）'
        : '';
      fallback.push({
        order: order++,
        score: 1,
        text: [
          `资料习题参考：${mat.fileName}`,
          `- 结构概览：习题 ${exercises.length}${fallbackTag}`,
        ].join('\n'),
      });

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

    // 关键词非空且没命中：返回空字符串，避免 fallback 凑数污染。
    if (keywords.length && !matched.length) {
      return '';
    }

    return this._selectBudgetedText(matched, 3200, fallback);
  }

  private async _retrieveRelevantExcerptsWholeBook(
    materials: MaterialEntry[],
    queryText: string,
    keywords: string[],
    maxExcerpts: number,
    courseTags?: import('../types').CourseTag[],
  ): Promise<RetrievedExcerpt[]> {
    if (!queryText && !keywords.length) {
      return this._buildDistributedFallbackExcerpts(materials, maxExcerpts);
    }

    // === 第一阶段：定位候选章节（两阶段检索） ===
    const locatedSections = await this._locateRelevantSections(materials, keywords);
    const locatedByMaterial = new Map<string, LocatedSection[]>();
    for (const located of locatedSections) {
      const list = locatedByMaterial.get(located.materialId) ?? [];
      list.push(located);
      locatedByMaterial.set(located.materialId, list);
    }

    // === 收集所有 chunks 并预计算 document frequency 表（IDF） ===
    const materialChunks: Array<{ material: MaterialEntry; chunks: string[] }> = [];
    for (const material of materials) {
      const text = await this._readMaterialText(material);
      if (!text) {
        continue;
      }
      const chunks = this._chunkText(text);
      if (chunks.length) {
        materialChunks.push({ material, chunks });
      }
    }

    const totalChunks = materialChunks.reduce((sum, item) => sum + item.chunks.length, 0);
    const dfMap = this._computeDocumentFrequency(materialChunks.flatMap(item => item.chunks), keywords);

    // === 第二阶段：在 chunks 上打分；命中候选 section 的 chunks 额外加分 ===
    const results: RetrievedExcerpt[] = [];

    for (const { material, chunks } of materialChunks) {
      const candidates = locatedByMaterial.get(material.id) ?? [];
      // 把候选 section 的 anchor terms 与 sectionLabel 拆成可匹配字符串
      const anchorBag = new Set<string>();
      const sectionLabelBag: string[] = [];
      for (const candidate of candidates) {
        sectionLabelBag.push(candidate.sectionLabel.toLowerCase());
        for (const anchor of candidate.anchorTerms) {
          const normalized = anchor.trim().toLowerCase();
          if (normalized) {
            anchorBag.add(normalized);
          }
        }
      }

      // tag → materialType 加权：当前课程 tag 偏好这种类型的资料就给整份 material 加分
      const materialTypeBonus = this._computeMaterialTypeBonus(material, courseTags);

      chunks.forEach((chunk, index) => {
        const lowered = chunk.toLowerCase();
        let score = this._scoreChunkWithIDF(lowered, queryText, keywords, dfMap, totalChunks);

        // 第一阶段命中加成
        let matchedSectionLabel: string | undefined;
        for (const label of sectionLabelBag) {
          if (label && lowered.includes(label)) {
            score += 5;
            matchedSectionLabel = label;
            break;
          }
        }
        if (!matchedSectionLabel) {
          for (const anchor of anchorBag) {
            if (lowered.includes(anchor)) {
              score += 5;
              // 优先把对应 section label 挂上
              const found = candidates.find(c => c.anchorTerms.some(t => t.toLowerCase() === anchor));
              if (found) {
                matchedSectionLabel = found.sectionLabel;
              }
              break;
            }
          }
        }

        // tag→type 加权（对每个 chunk 同样加，让"对路"的资料整体浮上来）
        score += materialTypeBonus;

        if (score <= 0) {
          return;
        }

        results.push({
          materialId: material.id,
          fileName: material.fileName,
          sourceLabel: `${material.fileName} / 片段 ${index + 1}`,
          excerpt: chunk,
          score,
          sectionLabel: matchedSectionLabel,
        });
      });
    }

    // 关键词非空但没有命中任何 chunk：返回 []，不再调 fallback 凑数。
    if (!results.length) {
      return [];
    }

    return results
      .sort((left, right) => right.score - left.score || left.excerpt.length - right.excerpt.length)
      .slice(0, maxExcerpts);
  }

  /**
   * 第一阶段：基于 sectionMappings + chapters 的关键词命中，返回候选 section。
   * 按命中关键词数量降序排序，最多 5 条。
   */
  private async _locateRelevantSections(
    materials: MaterialEntry[],
    keywords: string[],
  ): Promise<LocatedSection[]> {
    if (!keywords.length) {
      return [];
    }

    const located: Array<LocatedSection & { hitCount: number }> = [];

    for (const material of materials) {
      const summary = await this._loadMaterialSummary(material);
      if (!summary) {
        continue;
      }

      for (const section of summary.sectionMappings || []) {
        const haystack = [
          section.chapterNumber,
          section.chapterTitle,
          section.sectionNumber,
          section.sectionTitle,
          section.summary,
          (section.keyPoints || []).join(' '),
          (section.topicMapping || []).join(' '),
          (section.anchorTerms || []).join(' '),
        ].join(' ').toLowerCase();
        const hitCount = keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0);
        if (hitCount === 0) {
          continue;
        }
        located.push({
          materialId: material.id,
          sectionLabel: this._formatSectionLabel(section),
          anchorTerms: [
            ...(section.anchorTerms || []),
            section.sectionTitle,
          ].filter((value): value is string => !!value && value.trim().length > 1),
          hitCount,
        });
      }

      for (const chapter of summary.chapters || []) {
        const haystack = [
          chapter.chapterNumber,
          chapter.title,
          chapter.summary,
          (chapter.keyPoints || []).join(' '),
          (chapter.topicMapping || []).join(' '),
        ].join(' ').toLowerCase();
        const hitCount = keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0);
        if (hitCount === 0) {
          continue;
        }
        located.push({
          materialId: material.id,
          sectionLabel: this._formatChapterLabel(chapter),
          anchorTerms: [chapter.title].filter((value): value is string => !!value && value.trim().length > 1),
          hitCount,
        });
      }
    }

    return located
      .sort((left, right) => right.hitCount - left.hitCount)
      .slice(0, 5)
      .map(({ materialId, sectionLabel, anchorTerms }) => ({ materialId, sectionLabel, anchorTerms }));
  }

  /**
   * 当前课程的 tag 命中这份资料的 materialType → 返回加权分。
   * 多 tag 时取最大权重（一个 tag 权重高足以让资料浮上来）。
   * 资料没有 type 时按 'other' 处理（基本零加权）。
   */
  private _computeMaterialTypeBonus(material: MaterialEntry, courseTags?: import('../types').CourseTag[]): number {
    if (!courseTags || courseTags.length === 0) return 0;
    const matType = material.materialType ?? 'other';
    const { TAG_MATERIAL_TYPE_WEIGHTS } = require('../types') as typeof import('../types');
    let best = 0;
    for (const tag of courseTags) {
      const table = TAG_MATERIAL_TYPE_WEIGHTS[tag];
      if (!table) continue;
      const w = (table as any)[matType];
      if (typeof w === 'number' && w > best) {
        best = w;
      }
    }
    return best;
  }

  /** 预计算每个 keyword 在 chunks 集合内出现的文档数（chunk count）。 */
  private _computeDocumentFrequency(chunks: string[], keywords: string[]): Map<string, number> {
    const dfMap = new Map<string, number>();
    if (!keywords.length || !chunks.length) {
      return dfMap;
    }

    const lowered = chunks.map(chunk => chunk.toLowerCase());
    for (const keyword of keywords) {
      let df = 0;
      for (const chunk of lowered) {
        if (chunk.includes(keyword)) {
          df += 1;
        }
      }
      dfMap.set(keyword, df);
    }

    return dfMap;
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
      score += this._keywordLengthWeight(keyword);
    }

    if (!keywords.length) {
      // 短 chunk 略优先（归一化）
      const length = chunk.length;
      if (length === 0) { return 0; }
      score = Math.max(0.5, 1 - Math.min(1, length / 1500));
    }

    return score;
  }

  /**
   * 在 _scoreChunk 基础上叠加 IDF 权重：常见词权重低、稀有词权重高。
   * IDF = log((totalChunks + 1) / (df + 1))
   */
  private _scoreChunkWithIDF(
    chunk: string,
    query: string,
    keywords: string[],
    dfMap: Map<string, number>,
    totalChunks: number,
  ): number {
    let score = 0;

    if (query.length > 3 && chunk.includes(query)) {
      score += 30;
    }

    for (const keyword of keywords) {
      if (!chunk.includes(keyword)) { continue; }
      const lengthWeight = this._keywordLengthWeight(keyword);
      const df = dfMap.get(keyword) ?? 0;
      const idf = Math.log((totalChunks + 1) / (df + 1));
      // idf 范围视语料而定；clamp 到 [0.2, ~3] 避免极端权重
      const idfFactor = Math.max(0.2, Math.min(3, idf));
      score += lengthWeight * idfFactor;
    }

    if (!keywords.length) {
      const length = chunk.length;
      if (length === 0) { return 0; }
      score = Math.max(0.5, 1 - Math.min(1, length / 1500));
    }

    return score;
  }

  private _keywordLengthWeight(keyword: string): number {
    if (keyword.length >= 6) { return 12; }
    if (keyword.length >= 4) { return 7; }
    if (keyword.length >= 3) { return 4; }
    return 2;
  }
}
