import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ContentGenerator } from '../courses/contentGenerator';
import { Grader } from '../courses/grader';
import { CourseManager } from '../courses/courseManager';
import { ExerciseScanner } from '../courses/exerciseScanner';
import { MaterialManager } from '../materials/materialManager';
import { ProgressStore } from '../progress/progressStore';
import { PreferencesStore } from '../progress/preferencesStore';
import { AdaptiveEngine } from '../progress/adaptiveEngine';
import { CourseProfileStore, inferRevisionPreferenceTags } from '../progress/courseProfileStore';
import {
  SidebarResponse,
  ChatMessage,
  MaterialEntry,
  MaterialIndex,
  MaterialPreview,
  CourseOutline,
  ChatGroundingMode,
  AIProfile,
  AIWorkspaceOverride,
  LessonMeta,
  OutlineRebuildApplyRequest,
  OutlineRebuildImpactSummary,
  OutlineRebuildMode,
  OutlineRebuildPreviewRequest,
  OutlineRebuildPreviewResult,
  OutlineRebuildSelection,
  Subject,
  TopicOutline,
} from '../types';
import { AIClient } from '../ai/client';
import { AIProfileManager } from '../ai/profileManager';
import { chatPrompt, reviseMarkdownPatchPrompt, reviseMarkdownPrompt } from '../ai/prompts';
import { buildCourseSummaryMd, openMarkdownPreview, reprocessMarkdown, writeMarkdown, writeMarkdownAndPreview } from '../utils/markdown';
import { fileExists, ensureDir } from '../utils/fileSystem';
import { getDataDirectory } from '../config';

interface ChatEditTarget {
  subject: Subject;
  topicId: string;
  topicTitle: string;
  lessonId: string;
  lessonTitle: string;
  filePath: string;
  label: string;
}

interface MarkdownSection {
  headingLine: string;
  headingTitle: string;
  start: number;
  end: number;
  content: string;
}

interface MarkdownPatchResult {
  action: 'replace_section' | 'insert_after_section' | 'insert_before_section' | 'append_document';
  targetHeading?: string;
  content: string;
}

interface OutlineRebuildPreviewCacheEntry {
  previewId: string;
  subject: Subject;
  mode: OutlineRebuildMode;
  selection?: OutlineRebuildSelection;
  instruction?: string;
  materialIds: string[];
  materialTitles: string[];
  sourceOutlineHash: string;
  previewOutline: CourseOutline;
  impact: OutlineRebuildImpactSummary;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private contentGen = new ContentGenerator();
  private grader = new Grader();
  private courseManager = new CourseManager();
  private materialManager = new MaterialManager();
  private progressStore = new ProgressStore();
  private prefsStore = new PreferencesStore();
  private adaptiveEngine = new AdaptiveEngine();
  private courseProfileStore = new CourseProfileStore();
  private exerciseScanner = new ExerciseScanner();
  private _taskId = 0;
  private _activeTaskKeys = new Map<string, string>();
  private aiClient = new AIClient();
  private chatHistory: ChatMessage[] = [];
  private lastOpenedLessonFile?: ChatEditTarget;
  private selectedMaterialId?: string;
  private readonly outlineRebuildPreviews = new Map<string, OutlineRebuildPreviewCacheEntry>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly aiProfiles: AIProfileManager,
    private readonly onAIConfigChanged?: () => void,
  ) {
    this.materialManager.onDidChangeIndex((index) => {
      this._post({ type: 'materials', data: index });
      void this._refreshSelectedMaterialPreview(index);
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'sidebar', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'out', 'sidebar', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
      ],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    void this._pushAIConfigState();
    this._reconcileMaterialsInBackground();
  }

  sendCommand(command: { type: string; [key: string]: unknown }) {
    this._view?.webview.postMessage(command);
  }

  private _post(msg: SidebarResponse) {
    this._view?.webview.postMessage(msg);
  }

  private async _refreshCourses() {
    await this.courseManager.syncLessonStatuses();
    const courses = await this.courseManager.getAllCourses();
    this._post({ type: 'courses', data: courses });
  }

  private async _refreshMaterials() {
    const index = await this.materialManager.getIndex();
    this._post({ type: 'materials', data: index });
    await this._refreshSelectedMaterialPreview(index);
  }

  private async _refreshSelectedMaterialPreview(index?: MaterialIndex) {
    if (!this.selectedMaterialId) {
      return;
    }

    const snapshot = index ?? await this.materialManager.getIndex();
    const entry = snapshot.materials.find((item) => item.id === this.selectedMaterialId);
    if (!entry) {
      return;
    }

    this._post({ type: 'materialPreview', data: await this._buildMaterialPreview(entry) });
  }

  private _reconcileMaterialsInBackground(subject?: Subject, materialId?: string) {
    void this.materialManager.reconcileMaterials(subject, { materialId }).catch((error) => {
      console.error('Material reconciliation failed:', error);
    });
  }

  private async _pushAIConfigState() {
    const [resolved, workspaceOverride] = await Promise.all([
      this.aiProfiles.resolveConfig(),
      this.aiProfiles.getWorkspaceOverride(),
    ]);
    this._view?.webview.postMessage({ type: 'resolvedAIConfig', data: resolved, workspaceOverride });
  }

  async refreshAIConfigState() {
    await this._pushAIConfigState();
  }

  private async _afterAIConfigMutation(logMessage?: string) {
    await this._pushAIConfigState();
    if (logMessage) {
      this._post({ type: 'log', message: logMessage, level: 'info' });
    }
    this.onAIConfigChanged?.();
  }

  private _buildCourseOutlineSummary(outline: any): string {
    if (!outline) { return ''; }

    let summary = `课程标题：${outline.title}\n`;
    for (const topic of outline.topics || []) {
      const lessonTitles = (topic.lessons || []).map((lesson: any) => lesson.title).join('、');
      summary += `- ${topic.title}`;
      if (lessonTitles) {
        summary += `：${lessonTitles}`;
      }
      summary += '\n';
    }
    return summary.slice(0, 2500);
  }

  private _buildCourseOutlineSummarySafe(outline: CourseOutline | null): string {
    if (!outline) { return ''; }

    let summary = `课程标题：${outline.title}\n`;
    for (const topic of outline.topics) {
      const lessonTitles = topic.lessons.map(lesson => lesson.title).join('、');
      summary += `- ${topic.title}`;
      if (lessonTitles) {
        summary += `：${lessonTitles}`;
      }
      summary += '\n';
    }
    return summary.slice(0, 2500);
  }

  private async _buildSubjectGrounding(
    subject: string | undefined,
    query: string,
    options?: { materialId?: string; materialIds?: string[]; maxExcerpts?: number },
  ): Promise<{
    currentCourseTitle?: string;
    courseOutlineSummary?: string;
    materialSummary?: string;
    materialExerciseSummary?: string;
    retrievedExcerpts?: string;
    selectedMaterialTitle?: string;
  }> {
    if (!subject) {
      return {};
    }

    const outline = await this.courseManager.getCourseOutline(subject);
    const grounding = await this.materialManager.buildGroundingContext(subject, query, {
      materialId: options?.materialId,
      materialIds: options?.materialIds,
      maxExcerpts: options?.maxExcerpts,
    });

    return {
      currentCourseTitle: outline?.title,
      courseOutlineSummary: this._buildCourseOutlineSummarySafe(outline),
      materialSummary: grounding.summary,
      materialExerciseSummary: grounding.exerciseSummary,
      retrievedExcerpts: grounding.excerpts,
      selectedMaterialTitle: grounding.materialTitle,
    };
  }

  private async _buildChatGrounding(
    message: string,
    subject: string | undefined,
    mode: ChatGroundingMode | undefined,
    materialId: string | undefined,
  ): Promise<{
    currentCourseTitle?: string;
    courseOutlineSummary?: string;
    materialSummary?: string;
    materialExerciseSummary?: string;
    retrievedExcerpts?: string;
    selectedMaterialTitle?: string;
  }> {
    if (!subject) {
      return {};
    }

    const resolvedMode: ChatGroundingMode = mode ?? 'course';
    if (resolvedMode === 'general') {
      return {};
    }

    return this._buildSubjectGrounding(subject, message, {
      materialId: resolvedMode === 'material' ? materialId : undefined,
      maxExcerpts: resolvedMode === 'material' ? 5 : 4,
    });
  }

  private _normalizeMaterialIds(materialIds?: string[]): string[] {
    return Array.from(new Set((materialIds ?? []).map((materialId) => String(materialId ?? '').trim()).filter(Boolean)));
  }

  private _hashOutline(outline: CourseOutline): string {
    return JSON.stringify({
      title: outline.title,
      topics: outline.topics.map((topic) => ({
        title: topic.title,
        code: topic.code ?? topic.id,
        lessons: topic.lessons.map((lesson) => ({
          title: lesson.title,
          code: lesson.code ?? lesson.id,
          difficulty: lesson.difficulty,
        })),
      })),
    });
  }

  private _buildOutlineRebuildRangeLabel(outline: CourseOutline, selection?: OutlineRebuildSelection): string | undefined {
    if (!selection) {
      return undefined;
    }

    const startTopic = outline.topics[selection.startIndex];
    const endTopic = outline.topics[selection.endIndex];
    if (!startTopic || !endTopic) {
      return undefined;
    }

    return `${selection.startIndex + 1}-${selection.endIndex + 1}: ${startTopic.title} -> ${endTopic.title}`;
  }

  private _buildOutlineRebuildImpact(
    currentOutline: CourseOutline,
    previewOutline: CourseOutline,
    mode: OutlineRebuildMode,
    selection: OutlineRebuildSelection | undefined,
    materialTitles: string[],
    instruction?: string,
  ): OutlineRebuildImpactSummary {
    const replacedTopics = selection
      ? currentOutline.topics.slice(selection.startIndex, selection.endIndex + 1)
      : currentOutline.topics;
    const replacementCount = mode === 'partial'
      ? previewOutline.topics.length - (currentOutline.topics.length - replacedTopics.length)
      : previewOutline.topics.length;
    const renumberedTopicTitles = currentOutline.topics
      .filter((topic, index) => {
        if (!selection || index <= selection.endIndex) {
          return false;
        }
        const shiftedIndex = index - replacedTopics.length + replacementCount;
        const nextTopic = previewOutline.topics[shiftedIndex];
        return !!nextTopic && topic.id !== nextTopic.id;
      })
      .map((topic) => topic.title);

    return {
      titleChanged: currentOutline.title !== previewOutline.title,
      oldTitle: currentOutline.title,
      newTitle: previewOutline.title,
      oldTopicCount: currentOutline.topics.length,
      newTopicCount: previewOutline.topics.length,
      replacedTopicCount: replacedTopics.length,
      replacementTopicCount: mode === 'partial' ? replacementCount : previewOutline.topics.length,
      affectedRangeLabel: this._buildOutlineRebuildRangeLabel(currentOutline, selection),
      clearedTopicTitles: replacedTopics.map((topic) => topic.title),
      renumberedTopicTitles,
      selectedMaterialTitles: materialTitles,
      instruction: String(instruction ?? '').trim() || undefined,
    };
  }

  private _validateOutlineRebuildPreviewRequest(
    request: OutlineRebuildPreviewRequest,
    currentOutline: CourseOutline,
  ): OutlineRebuildSelection | undefined {
    if (request.mode !== 'partial') {
      return undefined;
    }

    if (!request.selection) {
      throw new Error('部分重构必须先选择连续主题区间。');
    }

    const startIndex = Number(request.selection.startIndex);
    const endIndex = Number(request.selection.endIndex);
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex < startIndex) {
      throw new Error('部分重构的主题选区无效，请重新选择。');
    }
    if (endIndex >= currentOutline.topics.length) {
      throw new Error('部分重构的主题选区超出当前课程范围。');
    }

    return { startIndex, endIndex };
  }

  private async _resolveMaterialTitles(materialIds: string[]): Promise<string[]> {
    const titles = await Promise.all(
      materialIds.map(async (materialId) => (await this.materialManager.getMaterialById(materialId))?.fileName ?? null)
    );
    return titles.filter((title): title is string => !!title);
  }

  private async _previewCourseOutlineRebuild(request: OutlineRebuildPreviewRequest): Promise<void> {
    const currentOutline = await this.courseManager.getCourseOutline(request.subject);
    if (!currentOutline) {
      throw new Error('当前课程大纲不存在，无法生成重构预览。');
    }

    const selection = this._validateOutlineRebuildPreviewRequest(request, currentOutline);
    const materialIds = this._normalizeMaterialIds(request.materialIds);
    if (materialIds.length > 0) {
      await this.materialManager.reconcileMaterials(undefined, { materialIds });
    }

    const [prefs, diag, profile, materialTitles] = await Promise.all([
      this.prefsStore.get(),
      this.adaptiveEngine.getLatestDiagnosis(request.subject),
      this.progressStore.getProfile(),
      this._resolveMaterialTitles(materialIds),
    ]);

    const courseProfileContext = await this._buildCourseProfileContext(request.subject);
    const grounding = await this._buildSubjectGrounding(
      request.subject,
      [currentOutline.title, request.instruction ?? '', 'course outline rebuild'].join(' ').trim(),
      { materialIds, maxExcerpts: 6 },
    );

    const previewOutline = request.mode === 'full'
      ? await this.contentGen.previewFullRebuild(request.subject, currentOutline, {
          profile,
          preferences: prefs,
          diagnosis: diag,
          ...courseProfileContext,
          ...grounding,
        }, request.instruction)
      : await this.contentGen.previewPartialRebuild(request.subject, currentOutline, selection!, {
          profile,
          preferences: prefs,
          diagnosis: diag,
          ...courseProfileContext,
          ...grounding,
        }, request.instruction);

    const previewId = `outline-preview-${Date.now()}`;
    const impact = this._buildOutlineRebuildImpact(
      currentOutline,
      previewOutline,
      request.mode,
      selection,
      materialTitles,
      request.instruction,
    );

    const cacheEntry: OutlineRebuildPreviewCacheEntry = {
      previewId,
      subject: request.subject,
      mode: request.mode,
      selection,
      instruction: String(request.instruction ?? '').trim() || undefined,
      materialIds,
      materialTitles,
      sourceOutlineHash: this._hashOutline(currentOutline),
      previewOutline,
      impact,
    };
    this.outlineRebuildPreviews.set(previewId, cacheEntry);

    const response: OutlineRebuildPreviewResult = {
      previewId,
      subject: request.subject,
      mode: request.mode,
      outline: previewOutline,
      impact,
      selection,
      materialIds,
      materialTitles,
      instruction: cacheEntry.instruction,
    };

    this._post({ type: 'outlineRebuildPreview', data: response });
    this._post({
      type: 'log',
      message: request.mode === 'full'
        ? `已生成课程重构预览：${currentOutline.title}`
        : `已生成部分重构预览：${currentOutline.title}`,
      level: 'info',
    });
  }

  private async _applyCourseOutlineRebuild(request: OutlineRebuildApplyRequest): Promise<void> {
    const preview = this.outlineRebuildPreviews.get(request.previewId);
    if (!preview) {
      throw new Error('当前预览已失效，请重新生成预览后再应用。');
    }

    const currentOutline = await this.courseManager.getCourseOutline(preview.subject);
    if (!currentOutline) {
      throw new Error('当前课程大纲不存在，无法应用重构。');
    }

    if (this._hashOutline(currentOutline) !== preview.sourceOutlineHash) {
      this.outlineRebuildPreviews.delete(request.previewId);
      throw new Error('预览生成后课程大纲已发生变化，请重新生成预览后再应用。');
    }

    const appliedOutline = preview.mode === 'full'
      ? await this.courseManager.applyFullRebuild(preview.subject, preview.previewOutline)
      : await this.courseManager.applyPartialRebuild(preview.subject, currentOutline, preview.previewOutline, preview.selection!);

    await writeMarkdown(
      this.courseManager.getCourseSummaryPath(preview.subject),
      buildCourseSummaryMd(appliedOutline.title, appliedOutline.topics),
    );

    this.outlineRebuildPreviews.delete(request.previewId);
    this.lastOpenedLessonFile = undefined;
    await this._refreshCourses();
    this._post({
      type: 'outlineRebuildApplied',
      previewId: request.previewId,
      mode: preview.mode,
      outline: appliedOutline,
    });
    this._view?.webview.postMessage({
      type: 'chatResponse',
      content: preview.mode === 'full'
        ? `已应用完整重构预览。\n\n- 课程标题：${appliedOutline.title}\n- 主题数量：${appliedOutline.topics.length}\n- 旧讲义与旧练习已按完整重构规则清理并重建结构`
        : `已应用部分重构预览。\n\n- 课程标题保持为：${appliedOutline.title}\n- 当前主题数量：${appliedOutline.topics.length}\n- 选区旧内容已清理，未选区内容已按新编号迁移`,
    });
    this._post({
      type: 'log',
      message: preview.mode === 'full'
        ? `已应用全量重构：${appliedOutline.title}`
        : `已应用部分重构：${appliedOutline.title}`,
      level: 'info',
    });
  }

  private _normalizeMaterialPreview(
    entry: MaterialEntry,
    format: MaterialPreview['format'],
    sourceLabel: string,
    content: string,
  ): MaterialPreview {
    const prefix = entry.status === 'failed' && entry.lastError
      ? `[索引失败]\n${entry.lastError}\n\n`
      : '';
    const cleaned = `${prefix}${content}`.replace(/\u0000/g, '');
    const maxChars = 30000;
    const truncated = cleaned.length > maxChars;
    return {
      materialId: entry.id,
      title: entry.fileName,
      format,
      sourceLabel,
      content: truncated
        ? `${cleaned.slice(0, maxChars)}\n\n[预览内容已截断，请在编辑器中打开原文件查看完整内容。]`
        : (cleaned || '该资料暂无可预览内容。'),
    };
  }

  private async _buildMaterialPreview(entry: MaterialEntry): Promise<MaterialPreview> {
    const ext = path.extname(entry.fileName).toLowerCase();

    if (ext === '.md' || ext === '.markdown') {
      const content = await fs.readFile(entry.filePath, 'utf-8');
      return this._normalizeMaterialPreview(entry, 'markdown', 'Markdown 原文', content);
    }

    if (ext === '.txt') {
      const content = await fs.readFile(entry.filePath, 'utf-8');
      return this._normalizeMaterialPreview(entry, 'text', 'TXT 原文', content);
    }

    if (ext === '.pdf') {
      if (await fileExists(entry.textPath)) {
        const content = await this.materialManager.ensureMaterialText(entry);
        return this._normalizeMaterialPreview(entry, 'text', 'PDF 提取文本', content);
      }
      return this._normalizeMaterialPreview(entry, 'text', 'PDF', '这份 PDF 还在解析中，请稍后再试。');
    }

    try {
      const content = await fs.readFile(entry.filePath, 'utf-8');
      return this._normalizeMaterialPreview(entry, 'text', '文本预览', content);
    } catch {
      return this._normalizeMaterialPreview(entry, 'text', '文件预览', '当前文件类型暂不支持在学习页内预览。');
    }
  }

  private _rememberLessonTarget(
    subject: Subject,
    topicId: string,
    topicTitle: string | undefined,
    lessonId: string,
    lessonTitle: string | undefined,
  ) {
    this.lastOpenedLessonFile = {
      subject,
      topicId,
      topicTitle: topicTitle ?? '',
      lessonId,
      lessonTitle: lessonTitle ?? '',
      filePath: this.courseManager.getLessonPath(subject, topicId, lessonId),
      label: `${lessonId} ${lessonTitle ?? '讲义'}`.trim(),
    };
  }

  private _normalizeLookup(value: string | undefined): string {
    return (value ?? '')
      .toLowerCase()
      .replace(/[\s`~!@#$%^&*()+=[\]{};:'"\\|,.<>/?，。！？；：、“”‘’（）《》【】—\-_]+/g, '');
  }

  private _shortLessonCode(lesson: LessonMeta): string {
    if (Number.isFinite(lesson.chapterNumber) && Number.isFinite(lesson.lessonNumber)) {
      return `${String(lesson.chapterNumber).padStart(2, '0')}-${String(lesson.lessonNumber).padStart(2, '0')}`;
    }

    const fallback = (lesson.code ?? lesson.id).split('-');
    return fallback.length >= 2 ? `${fallback[0]}-${fallback[1]}` : (lesson.code ?? lesson.id);
  }

  private _scoreLessonMatch(message: string, topic: TopicOutline, lesson: LessonMeta): number {
    const raw = message.toLowerCase();
    const normalizedMessage = this._normalizeLookup(message);
    const lessonCode = (lesson.code ?? lesson.id).toLowerCase();
    const shortCode = this._shortLessonCode(lesson).toLowerCase();
    const lessonTitle = this._normalizeLookup(lesson.title);
    const topicTitle = this._normalizeLookup(topic.title);
    const combinedTitle = this._normalizeLookup(`${topic.title}${lesson.title}`);
    const topicLessonText = this._normalizeLookup(`${topic.title} ${lesson.title}`);

    let score = 0;

    if (lessonCode && raw.includes(lessonCode)) {
      score += 120;
    }
    if (shortCode && raw.includes(shortCode)) {
      score += 100;
    }
    if (combinedTitle && normalizedMessage.includes(combinedTitle)) {
      score += 90;
    }
    if (topicLessonText && normalizedMessage.includes(topicLessonText)) {
      score += 80;
    }
    if (lessonTitle && normalizedMessage.includes(lessonTitle)) {
      score += 55;
    }
    if (topicTitle && normalizedMessage.includes(topicTitle)) {
      score += 15;
    }
    if (topicTitle && lessonTitle && normalizedMessage.includes(topicTitle) && normalizedMessage.includes(lessonTitle)) {
      score += 20;
    }

    return score;
  }

  private _buildChatEditTarget(subject: Subject, topic: TopicOutline, lesson: LessonMeta): ChatEditTarget {
    const shortCode = this._shortLessonCode(lesson);
    return {
      subject,
      topicId: topic.id,
      topicTitle: topic.title,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      filePath: this.courseManager.getLessonPath(subject, topic.id, lesson.id),
      label: `${shortCode} ${lesson.title}`.trim(),
    };
  }

  private _isChatEditIntent(message: string): boolean {
    const normalized = message.replace(/\s+/g, '');
    return /(修改|改一下|改下|改成|改为|重写|改写|重构|调整|完善|补充|补全|补上|润色|更新|删掉|删除|删去|扩写|压缩|精简|重排|修订|优化|合并|拆分)/.test(normalized);
  }

  private async _resolveChatEditTarget(subject: Subject | undefined, message: string): Promise<ChatEditTarget | null> {
    const fallback = this.lastOpenedLessonFile && (!subject || this.lastOpenedLessonFile.subject === subject)
      ? this.lastOpenedLessonFile
      : null;

    if (!subject) {
      return fallback;
    }

    const outline = await this.courseManager.getCourseOutline(subject);
    if (!outline) {
      return fallback;
    }

    const matches: Array<{ score: number; target: ChatEditTarget }> = [];
    for (const topic of outline.topics) {
      for (const lesson of topic.lessons) {
        const score = this._scoreLessonMatch(message, topic, lesson);
        if (score > 0) {
          matches.push({ score, target: this._buildChatEditTarget(subject, topic, lesson) });
        }
      }
    }

    if (matches.length === 0) {
      return fallback;
    }

    matches.sort((a, b) => b.score - a.score);
    if (matches.length === 1 || matches[0].score > matches[1].score) {
      return matches[0].target;
    }

    if (fallback) {
      const exactFallback = matches.find(match => match.target.filePath === fallback.filePath);
      if (exactFallback) {
        return exactFallback.target;
      }
    }

    return null;
  }

  private _stripMarkdownFence(content: string): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
    return fenced?.[1]?.trim() ?? trimmed;
  }

  private _extractSearchTerms(query: string): string[] {
    const normalized = query.toLowerCase();
    const terms = new Set<string>();

    const latin = normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
    for (const item of latin) {
      if (item.length > 1) {
        terms.add(item);
      }
    }

    const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const phrase of cjk) {
      terms.add(phrase);
      const maxGram = Math.min(4, phrase.length);
      for (let size = 2; size <= maxGram; size += 1) {
        for (let index = 0; index <= phrase.length - size; index += 1) {
          terms.add(phrase.slice(index, index + size));
        }
      }
    }

    return Array.from(terms)
      .filter((term) => term.length > 1)
      .sort((left, right) => right.length - left.length)
      .slice(0, 20);
  }

  private _parseMarkdownSections(markdown: string): MarkdownSection[] {
    const normalized = markdown.replace(/\r\n/g, '\n');
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    const matches = Array.from(normalized.matchAll(headingRegex));

    if (matches.length === 0) {
      return [{
        headingLine: '__FULL_DOCUMENT__',
        headingTitle: 'Full Document',
        start: 0,
        end: normalized.length,
        content: normalized,
      }];
    }

    const sections: MarkdownSection[] = [];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const start = match.index ?? 0;
      const end = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
      sections.push({
        headingLine: match[0].trim(),
        headingTitle: match[2].trim(),
        start,
        end,
        content: normalized.slice(start, end).trim(),
      });
    }

    return sections;
  }

  private _scoreMarkdownSection(message: string, section: MarkdownSection): number {
    const keywords = this._extractSearchTerms(message);
    const haystack = `${section.headingLine}\n${section.content}`.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
      if (!haystack.includes(keyword)) {
        continue;
      }
      if (section.headingTitle.toLowerCase().includes(keyword)) {
        score += 20;
      } else {
        score += Math.min(12, keyword.length * 2);
      }
    }

    return score;
  }

  private _buildMarkdownOutlineSummary(sections: MarkdownSection[]): string {
    return sections
      .map((section, index) => `${index + 1}. ${section.headingLine}`)
      .join('\n')
      .slice(0, 3000);
  }

  private _buildRelevantSectionsSummary(sections: MarkdownSection[], message: string): string {
    const ranked = sections
      .map((section) => ({ section, score: this._scoreMarkdownSection(message, section) }))
      .sort((left, right) => right.score - left.score);

    const picked = ranked.some((item) => item.score > 0)
      ? ranked.filter((item) => item.score > 0).slice(0, 3).map((item) => item.section)
      : sections.slice(0, Math.min(3, sections.length));

    return picked.map((section) => {
      const snippet = section.content.length > 2200
        ? `${section.content.slice(0, 2200)}\n...`
        : section.content;
      return `${section.headingLine}\n${snippet}`;
    }).join('\n\n---\n\n');
  }

  private _applyMarkdownPatch(markdown: string, sections: MarkdownSection[], patch: MarkdownPatchResult): string {
    const content = this._stripMarkdownFence(String(patch.content ?? '')).trim();
    if (!content) {
      return markdown;
    }

    if (patch.action === 'append_document') {
      return `${markdown.replace(/\s+$/, '')}\n\n${content}\n`;
    }

    const target = sections.find((section) => section.headingLine === String(patch.targetHeading ?? '').trim());
    if (!target) {
      return `${markdown.replace(/\s+$/, '')}\n\n${content}\n`;
    }

    if (patch.action === 'replace_section') {
      return `${markdown.slice(0, target.start)}${content}\n\n${markdown.slice(target.end).replace(/^\s+/, '')}`.trim() + '\n';
    }

    if (patch.action === 'insert_before_section') {
      return `${markdown.slice(0, target.start)}${content}\n\n${markdown.slice(target.start)}`.trim() + '\n';
    }

    return `${markdown.slice(0, target.end).replace(/\s+$/, '')}\n\n${content}\n\n${markdown.slice(target.end).replace(/^\s+/, '')}`.trim() + '\n';
  }

  private async _buildEditGrounding(subject: Subject | undefined): Promise<{
    currentCourseTitle?: string;
    courseOutlineSummary?: string;
  }> {
    if (!subject) {
      return {};
    }

    const outline = await this.courseManager.getCourseOutline(subject);
    return {
      currentCourseTitle: outline?.title,
      courseOutlineSummary: this._buildCourseOutlineSummarySafe(outline),
    };
  }

  private async _buildCourseProfileContext(subject?: Subject, topicId?: string) {
    return this.courseProfileStore.buildPromptContext(subject, topicId);
  }

  private async _recordRevisionFeedbackEvent(options: {
    type: 'lecture-revision' | 'answer-revision';
    subject?: Subject;
    topicId?: string | null;
    lessonId?: string | null;
    userMessage: string;
    summaryTarget: string;
    rawRefs?: string[];
  }): Promise<void> {
    if (!options.subject) {
      return;
    }

    const preferenceTags = inferRevisionPreferenceTags(options.userMessage);
    if (!preferenceTags.length) {
      return;
    }

    await this.courseProfileStore.recordEvent(options.subject, {
      id: `${options.type}-${Date.now()}`,
      type: options.type,
      subject: options.subject,
      topicId: options.topicId ?? null,
      lessonId: options.lessonId ?? null,
      createdAt: new Date().toISOString(),
      summary: `${options.summaryTarget}. User revision intent: ${options.userMessage.slice(0, 180)}`,
      weaknessTags: [],
      strengthTags: [],
      preferenceTags,
      rawRefs: options.rawRefs ?? [],
      metadata: {
        target: options.summaryTarget,
      },
    });
  }

  private async _reviseLectureViaChat(
    userMessage: string,
    subject: Subject | undefined,
    prefs: any,
    diag: any,
    profile: any
  ): Promise<string> {
    const target = await this._resolveChatEditTarget(subject, userMessage);
    if (!target) {
      const reply = '无法定位唯一讲义。先打开对应小节，或在消息里明确写出课时编号或标题。';
      this._recordChatTurn(userMessage, reply);
      this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
      this._post({ type: 'log', message: '聊天编辑未执行：未定位到唯一讲义文件', level: 'warn' });
      return reply;
    }

    if (!await fileExists(target.filePath)) {
      const reply = `已定位到 ${target.label}，但讲义文件还不存在。先生成这节讲义，再继续让我修改。`;
      this._rememberResolvedTarget(target);
      this._recordChatTurn(userMessage, reply);
      this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
      this._post({ type: 'log', message: `聊天编辑未执行：讲义文件不存在 ${target.label}`, level: 'warn' });
      return reply;
    }

    const currentContent = await fs.readFile(target.filePath, 'utf-8');
    const editGrounding = await this._buildEditGrounding(subject ?? target.subject);
    const courseProfileContext = await this._buildCourseProfileContext(target.subject, target.topicId);
    let revisedContent = currentContent;

    const sections = this._parseMarkdownSections(currentContent);
    const shouldUsePatchMode = sections.length > 1 && currentContent.length > 8000;

    if (shouldUsePatchMode) {
      const patchMessages = reviseMarkdownPatchPrompt(
        userMessage,
        target.label,
        this._buildMarkdownOutlineSummary(sections),
        this._buildRelevantSectionsSummary(sections, userMessage),
        {
          profile,
          preferences: prefs,
          diagnosis: diag,
          ...courseProfileContext,
          ...editGrounding,
        }
      );
      const patch = await this.aiClient.chatJson<MarkdownPatchResult>(patchMessages, {
        temperature: 0.2,
        maxTokens: 1800,
      });
      revisedContent = this._applyMarkdownPatch(currentContent, sections, patch);
    } else {
      const reviseMessages = reviseMarkdownPrompt(userMessage, currentContent, target.label, {
        profile,
        preferences: prefs,
        diagnosis: diag,
        ...courseProfileContext,
        ...editGrounding,
      });
      const revisedRaw = await this.aiClient.chatCompletion(reviseMessages, {
        temperature: 0.2,
      });
      revisedContent = this._stripMarkdownFence(revisedRaw);
    }

    const changed = revisedContent.trim() !== currentContent.trim();
    if (changed) {
      await writeMarkdownAndPreview(target.filePath, revisedContent);
      await this._recordRevisionFeedbackEvent({
        type: 'lecture-revision',
        subject: target.subject,
        topicId: target.topicId,
        lessonId: target.lessonId,
        userMessage,
        summaryTarget: target.label,
        rawRefs: [target.filePath],
      });
    }

    this._rememberResolvedTarget(target);
    const reply = changed
      ? `已按要求更新 ${target.label} 并写回讲义文件。`
      : `已检查 ${target.label}，这次没有生成实质性改动。请把修改要求写得更具体。`;
    this._recordChatTurn(userMessage, reply);
    this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
    this._post({ type: 'log', message: changed ? `聊天编辑已写回：${target.label}` : `聊天编辑无改动：${target.label}`, level: 'info' });
    return reply;
  }

  private _rememberResolvedTarget(target: ChatEditTarget) {
    this.lastOpenedLessonFile = target;
  }

  private _recordChatTurn(userMessage: string, reply: string) {
    this.chatHistory.push({ role: 'user', content: userMessage });
    this.chatHistory.push({ role: 'assistant', content: reply });
    if (this.chatHistory.length > 20) {
      this.chatHistory = this.chatHistory.slice(-20);
    }
  }

  private async _handleMessage(msg: any) {
    try {
      switch (msg.type) {
        case 'confirmDeleteCourse': {
          const choice = await vscode.window.showWarningMessage(
            `移除课程 "${msg.title}"（讲义和练习文件不会被删除）`,
            '移除', '取消'
          );
          if (choice === '移除') {
            await this.courseManager.deleteCourse(msg.subject);
            this._post({ type: 'log', message: `课程已移除：${msg.title}`, level: 'info' });
            await this._refreshCourses();
          }
          break;
        }

        case 'getCourses': {
          await this._refreshCourses();
          break;
        }

        case 'generateCourse': {
          const existingOutline = await this.courseManager.getCourseOutline(msg.subject);
          if (existingOutline) {
            const choice = await vscode.window.showWarningMessage(
              `学科 "${existingOutline.title}" 已有课程大纲，是否重新生成？`,
              '重新生成', '取消'
            );
            if (choice !== '重新生成') {
              this._post({ type: 'log', message: '已取消生成课程大纲', level: 'info' });
              break;
            }
          }
          this._startTask(msg.subject + ' 课程大纲', async () => {
            const [prefs, diag, profile] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
            ]);
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject);
            const materialSummary = await this.materialManager.getRelevantSummary(msg.subject, '');
            const outline = await this.contentGen.generateCourse(msg.subject, {
              profile, preferences: prefs, diagnosis: diag, materialSummary, ...courseProfileContext,
            });
            await this._refreshCourses();
            this._post({ type: 'courseGenerated', outline });
            this._post({ type: 'log', message: `课程已生成：${outline.title}`, level: 'info' });
          });
          break;
        }

        case 'rebuildCourseOutline': {
          const currentOutline = await this.courseManager.getCourseOutline(msg.subject);
          if (!currentOutline) {
            throw new Error('当前学科还没有课程大纲，无法重构');
          }

          this._startTask(currentOutline.title + ' 大纲重构', async () => {
            const [prefs, diag, profile] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
            ]);
            const grounding = await this._buildSubjectGrounding(
              msg.subject,
              [currentOutline.title, '重构课程大纲'].join(' '),
              { materialId: msg.materialId, maxExcerpts: 6 },
            );
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject);
            const rebuilt = await this.contentGen.rebuildCourse(msg.subject, currentOutline, {
              profile,
              preferences: prefs,
              diagnosis: diag,
              ...courseProfileContext,
              ...grounding,
            });

            this.lastOpenedLessonFile = undefined;
            await this._refreshCourses();
            this._view?.webview.postMessage({
              type: 'chatResponse',
              content: `已按“完全重构”模式重建课程。\n\n- 课程标题：${rebuilt.title}\n- 主题数量：${rebuilt.topics.length}\n- 旧大纲、旧讲义、旧练习已清空\n- 已写入新的 \`course-outline.json\` 和 \`course-summary.md\`\n\n课程树已经刷新，你现在看到的是全新的课程结构。`,
            });
            this._post({ type: 'log', message: `课程已完全重构：${rebuilt.title}（旧课程内容已清空）`, level: 'info' });
          });
          break;
        }

        case 'previewRebuildCourseOutline': {
          const request = msg.request as OutlineRebuildPreviewRequest;
          const outline = await this.courseManager.getCourseOutline(request.subject);
          if (!outline) {
            throw new Error('当前课程大纲不存在，无法生成重构预览。');
          }

          this._startTask(`${outline.title} 大纲预览重构`, async () => {
            await this._previewCourseOutlineRebuild(request);
          });
          break;
        }

        case 'applyRebuildCourseOutline': {
          const request = msg.request as OutlineRebuildApplyRequest;
          const preview = this.outlineRebuildPreviews.get(request.previewId);
          const taskLabel = preview ? `${preview.previewOutline.title} 应用大纲重构` : '应用大纲重构';
          this._startTask(taskLabel, async () => {
            await this._applyCourseOutlineRebuild(request);
          });
          break;
        }

        case 'openOrGenerateLesson':
        case 'generateLesson': {
          const lessonPath = this.courseManager.getLessonPath(msg.subject, msg.topicId, msg.lessonId);
          const lessonExists = await fileExists(lessonPath);
          if (lessonExists && msg.type === 'openOrGenerateLesson') {
            this._rememberLessonTarget(msg.subject, msg.topicId, msg.topicTitle, msg.lessonId, msg.lessonTitle);
            await openMarkdownPreview(lessonPath);
            break;
          }
          if (lessonExists) {
            const choice = await vscode.window.showWarningMessage(
              `讲义 "${msg.lessonTitle}" 已存在，是否重新生成？`,
              '打开现有', '重新生成', '取消'
            );
            if (choice === '打开现有') {
              this._rememberLessonTarget(msg.subject, msg.topicId, msg.topicTitle, msg.lessonId, msg.lessonTitle);
              await openMarkdownPreview(lessonPath);
              break;
            }
            if (choice !== '重新生成') { break; }
          }
          this._startTask(msg.lessonTitle + ' 讲义', async () => {
            const [prefs, diag, profile] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
            ]);
            const grounding = await this._buildSubjectGrounding(
              msg.subject,
              [msg.topicTitle, msg.lessonTitle, '讲义'].filter(Boolean).join(' '),
              { maxExcerpts: 5 },
            );
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject, msg.topicId);
            await this.contentGen.generateLesson(
              msg.subject, msg.topicId, msg.topicTitle, msg.lessonId, msg.lessonTitle, msg.difficulty,
              { profile, preferences: prefs, diagnosis: diag, ...courseProfileContext, ...grounding },
            );
            this._rememberLessonTarget(msg.subject, msg.topicId, msg.topicTitle, msg.lessonId, msg.lessonTitle);
            this._post({ type: 'log', message: `讲义已生成：${msg.lessonTitle}`, level: 'info' });
            const courses = await this.courseManager.getAllCourses();
            this._post({ type: 'courses', data: courses });
          });
          break;
        }

        case 'openLessonContent': {
          const lPath = this.courseManager.getLessonPath(msg.subject, msg.topicId, msg.lessonId);
          if (await fileExists(lPath)) {
            this._rememberLessonTarget(msg.subject, msg.topicId, msg.topicTitle, msg.lessonId, msg.lessonTitle);
            await openMarkdownPreview(lPath);
          } else {
            vscode.window.showInformationMessage('该小节尚未生成讲义，请点击“讲义”按钮生成。');
          }
          break;
        }

        case 'openOrGenerateExercises':
        case 'generateExercises': {
          const expectedSessionId = await this.courseManager.getDeterministicSessionId(msg.subject, msg.topicId, msg.lessonId);
          const expectedPath = this.courseManager.getExercisePath(msg.subject, msg.topicId, expectedSessionId);

          if (msg.type === 'openOrGenerateExercises') {
            if (await fileExists(expectedPath)) {
              await openMarkdownPreview(expectedPath);
              break;
            }
          } else if (await fileExists(expectedPath)) {
            const choice = await vscode.window.showWarningMessage(
              `"${msg.lessonTitle}" 的练习文件已存在，是否重新生成覆盖？`,
              '覆盖生成', '取消'
            );
            if (choice !== '覆盖生成') { break; }
          }

          this._startTask(msg.lessonTitle + ' 练习', async () => {
            const [prefs, diag, profile] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
            ]);
            const grounding = await this._buildSubjectGrounding(
              msg.subject,
              [msg.topicTitle, msg.lessonTitle, '练习题'].filter(Boolean).join(' '),
              { maxExcerpts: 5 },
            );
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject, msg.topicId);
            await this.contentGen.generateExercises(
              msg.subject, msg.topicId, msg.lessonId, msg.lessonTitle, msg.count, msg.difficulty,
              { profile, preferences: prefs, diagnosis: diag, ...courseProfileContext, ...grounding },
            );
            await this.progressStore.incrementSession();
            await this._refreshCourses();
            this._post({ type: 'log', message: `已生成 ${msg.count} 道练习题`, level: 'info' });
          });
          break;
        }

        case 'resetLessonProgress': {
          this._startTask(msg.lessonTitle + ' 重置', async () => {
            await this.courseManager.resetLessonProgress(msg.subject, msg.topicId, msg.lessonId);
            await this._refreshCourses();
            this._post({ type: 'log', message: `已重置：${msg.lessonTitle}`, level: 'info' });
          });
          break;
        }

        case 'markLessonCompleted': {
          await this.courseManager.markLessonCompleted(msg.subject, msg.topicId, msg.lessonId);
          await this._refreshCourses();
          this._post({ type: 'log', message: `已标记完成：${msg.lessonTitle}`, level: 'info' });
          break;
        }

        case 'submitAnswer': {
          this._startTask('批改', async () => {
            const [prefs, diag, profile] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
            ]);
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject, msg.topicId);
            const result = await this.grader.grade(
              msg.exercise, msg.answer, msg.subject, msg.topicId, msg.sessionId,
              { profile, preferences: prefs, diagnosis: diag, ...courseProfileContext },
            );
            await this.progressStore.incrementExercises(1);
            this._post({ type: 'gradeResult', result });
            this._post({ type: 'log', message: `批改完成，得分 ${result.score}/100`, level: 'info' });
          });
          break;
        }

        case 'getDiagnosis': {
          if (!msg.subject) {
            this._post({ type: 'diagnosis', data: null });
            this._post({ type: 'log', message: '请先选择当前课程，再运行学习诊断', level: 'warn' });
            break;
          }
          if (!msg.run) {
            const diag = await this.adaptiveEngine.getLatestDiagnosis(msg.subject);
            this._post({ type: 'diagnosis', data: diag });
            break;
          }
          this._startTask('学习诊断', async () => {
            const diag = await this.adaptiveEngine.runDiagnosis(msg.subject);
            this._post({ type: 'diagnosis', data: diag });
            await this._refreshCourses();
            this._post({ type: 'log', message: '学习诊断已完成', level: 'info' });
          });
          break;
        }

        case 'scanExercises': {
          this._startTask('扫描练习', async () => {
            const count = await this.exerciseScanner.scanAndGradeAll();
            await this.courseManager.syncLessonStatuses();
            await this._refreshCourses();
            this._post({ type: 'log', message: count > 0 ? `自动批改 ${count} 道练习` : '没有发现未批改的练习', level: 'info' });
          });
          break;
        }

        case 'reprocessAllMarkdown': {
          this._startTask('重处理公式', async () => {
            const dataDir = getDataDirectory();
            const { readdir } = await import('fs/promises');
            let count = 0;
            const walkDir = async (dir: string) => {
              let entries: any[];
              try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
              for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { await walkDir(full); }
                else if (e.name.endsWith('.md')) {
                  await reprocessMarkdown(full);
                  count++;
                }
              }
            };
            await walkDir(dataDir);
            this._post({ type: 'log', message: `已重处理 ${count} 个 MD 文件`, level: 'info' });
          });
          break;
        }

        case 'renameCourse': {
          const newTitle = await vscode.window.showInputBox({
            prompt: '输入新的课程标题',
            value: msg.currentTitle,
          });
          if (newTitle && newTitle !== msg.currentTitle) {
            const outline = await this.courseManager.getCourseOutline(msg.subject);
            if (outline) {
              outline.title = newTitle;
              await this.courseManager.saveCourseOutline(msg.subject, outline);
              this._post({ type: 'log', message: `课程已重命名：${newTitle}`, level: 'info' });
              const courses = await this.courseManager.getAllCourses();
              this._post({ type: 'courses', data: courses });
            }
          }
          break;
        }

        case 'getPreferences': {
          const prefs = await this.prefsStore.get();
          this._post({ type: 'preferences', data: prefs });
          break;
        }

        case 'savePreferences': {
          await this.prefsStore.save(msg.preferences);
          this._post({ type: 'log', message: '设置已保存', level: 'info' });
          break;
        }

        case 'getResolvedAIConfig': {
          await this._pushAIConfigState();
          break;
        }

        case '__legacy_saveAIProfile__': {
          await this.aiProfiles.saveProfile({
            id: msg.profile.id,
            name: msg.profile.name,
            provider: msg.profile.provider,
            baseUrl: msg.profile.baseUrl,
            anthropicBaseUrl: msg.profile.anthropicBaseUrl,
            apiToken: msg.profile.apiToken ?? '',
            model: msg.profile.model,
            wireApi: msg.profile.wireApi,
            reasoningEffort: msg.profile.reasoningEffort,
            contextWindow: msg.profile.contextWindow,
            maxTokens: msg.profile.maxTokens ?? 4096,
            notes: msg.profile.notes ?? '',
            source: msg.profile.source ?? 'manual',
          });
          await this._afterAIConfigMutation('AI 配置已保存');
          break;
        }

        case '__legacy_deleteAIProfile__': {
          await this.aiProfiles.deleteProfile(msg.profileId);
          await this._afterAIConfigMutation('AI 配置已删除');
          break;
        }

        case '__legacy_duplicateAIProfile__': {
          const duplicated = await this.aiProfiles.duplicateProfile(msg.profileId);
          await this._afterAIConfigMutation(`已复制 AI 配置：${duplicated.name}`);
          break;
        }

        case '__legacy_activateAIProfile__': {
          await this.aiProfiles.activateProfile(msg.profileId);
          await this._afterAIConfigMutation('已切换当前 AI 配置');
          break;
        }

        case '__legacy_saveWorkspaceAIOverride__': {
          await this.aiProfiles.saveWorkspaceOverride(msg.override as AIWorkspaceOverride);
          await this._afterAIConfigMutation('项目级 AI 覆盖已更新');
          break;
        }

        case 'importAIProfile': {
          try {
            const result = await this.aiProfiles.importProfile(msg.source, { activate: true });
            this._post({ type: 'aiImportResult', data: result });
            await this._afterAIConfigMutation(`已导入 AI 配置：${result.profile.name}`);
          } catch (error: any) {
            if (String(error?.message || '').includes('已取消')) {
              this._post({ type: 'log', message: error.message, level: 'info' });
              break;
            }
            throw error;
          }
          break;
        }

        case '__legacy_exportAIProfile__': {
          await this.aiProfiles.exportProfile(msg.profileId, !!msg.includeToken);
          this._post({ type: 'log', message: 'AI 配置已导出', level: 'info' });
          break;
        }

        case '__legacy_testAIProfile__': {
          try {
            const message = await this.aiProfiles.testResolvedConfig(msg.profile as Partial<AIProfile> | undefined);
            this._view?.webview.postMessage({ type: 'aiTestResult', success: true, message });
            this._post({ type: 'log', message, level: 'info' });
          } catch (error: any) {
            const message = error?.message || 'AI 配置测试失败';
            this._view?.webview.postMessage({ type: 'aiTestResult', success: false, message });
            this._post({ type: 'log', message, level: 'error' });
          }
          break;
        }

        case 'importMaterial': {
          const entry = await this.materialManager.importMaterial(msg.subject);
          if (entry) {
            this._reconcileMaterialsInBackground(msg.subject, entry.id);
          }
          if (entry) {
            this._post({ type: 'log', message: `资料已导入：${entry.fileName}`, level: 'info' });
          } else {
            this._post({ type: 'log', message: '取消导入资料', level: 'info' });
          }
          await this._refreshMaterials();
          break;
        }

        case 'getMaterials': {
          await this._refreshMaterials();
          this._reconcileMaterialsInBackground();
          break;
        }

        case 'deleteMaterial': {
          await this.materialManager.deleteMaterial(msg.materialId);
          const suffix = msg.fileName ? `：${msg.fileName}` : '';
          this._post({ type: 'log', message: `资料已删除${suffix}`, level: 'info' });
          const updatedIndex = await this.materialManager.getIndex();
          this._post({ type: 'materials', data: updatedIndex });
          break;
        }

        case 'requestDeleteMaterial': {
          const fileName = String(msg.fileName ?? '资料');
          const choice = await vscode.window.showWarningMessage(
            `确认删除资料 "${fileName}"？`,
            '删除',
            '取消'
          );
          if (choice !== '删除') {
            break;
          }

          await this.materialManager.deleteMaterial(msg.materialId);
          this._post({ type: 'log', message: `资料已删除：${fileName}`, level: 'info' });
          const updatedIndex = await this.materialManager.getIndex();
          this._post({ type: 'materials', data: updatedIndex });
          break;
        }

        case 'getDataDir': {
          const dataDir = getDataDirectory();
          this._view?.webview.postMessage({ type: 'dataDir', path: dataDir });
          break;
        }

        case 'openDataDir': {
          const dir = getDataDirectory();
          await ensureDir(dir);
          const dirUri = vscode.Uri.file(dir);
          try {
            await vscode.commands.executeCommand('revealFileInOS', dirUri);
          } catch {
            await vscode.env.openExternal(dirUri);
          }
          break;
        }

        case 'openFile': {
          const uri = vscode.Uri.file(msg.filePath);
          await vscode.commands.executeCommand('markdown.showPreview', uri);
          break;
        }

        case 'previewMaterial': {
          this.selectedMaterialId = msg.materialId;
          const index = await this.materialManager.getIndex();
          const entry = index.materials.find((item) => item.id === msg.materialId);
          if (!entry) {
            this._post({ type: 'error', message: '未找到要预览的资料文件。' });
            break;
          }
          this._reconcileMaterialsInBackground(entry.subject, entry.id);
          this._post({ type: 'materialPreview', data: await this._buildMaterialPreview(entry) });
          break;
        }

        case 'chat': {
          const userMessage = String(msg.message ?? '').trim();
          if (!userMessage) {
            break;
          }

          const shouldTryEdit = this._isChatEditIntent(userMessage) && (!!msg.subject || !!this.lastOpenedLessonFile);
          const diagnosisSubject = shouldTryEdit ? (msg.subject ?? this.lastOpenedLessonFile?.subject) : msg.subject;
          this._startTask(shouldTryEdit ? '修改讲义' : 'AI 对话', async () => {
            const [prefs, diag, profile] = await Promise.all([
              this.prefsStore.get(),
              diagnosisSubject ? this.adaptiveEngine.getLatestDiagnosis(diagnosisSubject) : Promise.resolve(null),
              this.progressStore.getProfile(),
            ]);

            if (shouldTryEdit) {
              await this._reviseLectureViaChat(userMessage, msg.subject, prefs, diag, profile);
              return;
            }

            const grounding = await this._buildChatGrounding(userMessage, msg.subject, msg.mode, msg.materialId);
            const activeLessonTarget = this.lastOpenedLessonFile?.subject === msg.subject
              ? this.lastOpenedLessonFile
              : undefined;
            const chatTopicId = activeLessonTarget?.topicId;
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject, chatTopicId);
            const messages = chatPrompt(userMessage, this.chatHistory, {
              profile,
              preferences: prefs,
              diagnosis: diag,
              ...courseProfileContext,
              ...grounding,
            });
            const reply = await this.aiClient.chatCompletion(messages);
            await this._recordRevisionFeedbackEvent({
              type: 'answer-revision',
              subject: msg.subject,
              topicId: chatTopicId ?? null,
              lessonId: activeLessonTarget?.lessonId ?? null,
              userMessage,
              summaryTarget: 'chat-answer',
            });
            this._recordChatTurn(userMessage, reply);
            this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
            this._post({ type: 'log', message: `AI 回复完成（${reply.length} 字）`, level: 'info' });
          });
          return;
          /*

          const [prefs, diag, profile] = await Promise.all([
            this.prefsStore.get(),
            this.adaptiveEngine.getLatestDiagnosis(),
            this.progressStore.getProfile(),
          ]);
          const grounding = await this._buildChatGrounding(userMessage, msg.subject, msg.mode, msg.materialId);
          const shouldTryFileEdit = this._isChatEditIntent(userMessage) && (!!msg.subject || !!this.lastOpenedLessonFile);

          if (shouldTryFileEdit) {
            const target = await this._resolveChatEditTarget(msg.subject, userMessage);
            if (!target) {
              const reply = '我理解你是在让我直接改讲义文件，但当前没有定位到唯一目标。请先打开对应小节，或者在消息里带上课时编号或标题，例如“在 05-03 中补充一个更精确的判别法”。';
              this._recordChatTurn(userMessage, reply);
              this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
              this._post({ type: 'log', message: '聊天编辑未执行：未定位到唯一讲义文件', level: 'warn' });
              break;
            }

            const resolvedTarget = target;
            if (!await fileExists(resolvedTarget.filePath)) {
              const reply = `我已经定位到 ${resolvedTarget.label}，但这节课的讲义文件还没生成。先点一次“讲义”按钮生成内容，之后你在对话里继续提修改意见，我就能直接写回文件。`;
              this._rememberResolvedTarget(resolvedTarget);
              this._recordChatTurn(userMessage, reply);
              this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
              this._post({ type: 'log', message: `聊天编辑未执行：讲义文件不存在 ${resolvedTarget.label}`, level: 'warn' });
              break;
            }

            const currentContent = await fs.readFile(resolvedTarget.filePath, 'utf-8');
            const reviseMessages = reviseMarkdownPrompt(userMessage, currentContent, resolvedTarget.label, {
              profile,
              preferences: prefs,
              diagnosis: diag,
              ...grounding,
            });
            const revisedRaw = await this.aiClient.chatCompletion(reviseMessages, {
              temperature: 0.2,
            });
            const revisedContent = this._stripMarkdownFence(revisedRaw);
            const changed = revisedContent.trim() !== currentContent.trim();

            if (changed) {
              await writeMarkdownAndPreview(resolvedTarget.filePath, revisedContent);
            }

            this._rememberResolvedTarget(resolvedTarget);
            const reply = changed
              ? `已根据你的反馈更新 ${resolvedTarget.label}，并写回讲义文件。你可以继续直接说“再补一个例题”或“把这一段压缩一点”，我会继续改同一小节。`
              : `我检查了 ${resolvedTarget.label}，这次生成结果没有产生实质改动，所以暂时没有重写文件。你可以再具体一点，比如指出要补哪部分、删哪段或改成什么风格。`;
            this._recordChatTurn(userMessage, reply);
            this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
            this._post({ type: 'log', message: changed ? `聊天编辑已写回：${resolvedTarget.label}` : `聊天编辑无改动：${resolvedTarget.label}`, level: 'info' });
            break;
          }

          const messages = chatPrompt(userMessage, this.chatHistory, {
            profile,
            preferences: prefs,
            diagnosis: diag,
            ...grounding,
          });
          const reply = await this.aiClient.chatCompletion(messages);
          this._recordChatTurn(userMessage, reply);
          this._view?.webview.postMessage({ type: 'chatResponse', content: reply });
          this._post({ type: 'log', message: `AI 回复完成（${reply.length} 字）`, level: 'info' });
          break;
          */
        }
      }
    } catch (err: any) {
      const message = err?.message || '发生未知错误';
      this._post({ type: 'loading', active: false });
      this._post({ type: 'error', message });
      vscode.window.showErrorMessage(`ClaudeCoach: ${message}`);
    }
  }

  private _startTask(name: string, fn: () => Promise<void>) {
    const taskKey = name.trim();
    if (this._activeTaskKeys.has(taskKey)) {
      this._post({ type: 'log', message: `任务已在运行：${taskKey}`, level: 'warn' });
      return;
    }

    const id = String(++this._taskId);
    this._activeTaskKeys.set(taskKey, id);
    this._view?.webview.postMessage({ type: 'taskStart', id, name, key: taskKey });
    this._post({ type: 'log', message: `开始：${name}`, level: 'info' });
    fn().then(() => {
      this._activeTaskKeys.delete(taskKey);
      this._view?.webview.postMessage({ type: 'taskEnd', id, key: taskKey });
    }).catch((err: any) => {
      const message = err?.message || `任务失败：${name}`;
      const detail = err?.message ? ` - ${err.message}` : '';
      this._activeTaskKeys.delete(taskKey);
      this._view?.webview.postMessage({ type: 'taskEnd', id, key: taskKey });
      if (taskKey === 'AI 对话' || taskKey === '修改讲义') {
        this._view?.webview.postMessage({ type: 'chatResponse', content: `请求失败：${message}` });
      }
      this._post({ type: 'error', message });
      this._post({ type: 'log', message: `失败：${name}${detail}`, level: 'error' });
      vscode.window.showErrorMessage(`ClaudeCoach: ${message}`);
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'sidebar', 'webview', 'index.html');
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'sidebar', 'webview', 'style.css')
    );
    const katexStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css')
    );
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js')
    );
    const katexScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.js')
    );
    const katexAutoRenderUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'katex', 'dist', 'contrib', 'auto-render.min.js')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'sidebar', 'webview', 'main.js')
    );

    // Read HTML template and replace placeholders
    try {
      const fs = require('fs');
      let html = fs.readFileSync(htmlPath, 'utf-8');
      html = html.replace('{{styleUri}}', styleUri.toString());
      html = html.replace('{{katexStyleUri}}', katexStyleUri.toString());
      html = html.replace('{{markdownItUri}}', markdownItUri.toString());
      html = html.replace('{{katexScriptUri}}', katexScriptUri.toString());
      html = html.replace('{{katexAutoRenderUri}}', katexAutoRenderUri.toString());
      html = html.replace('{{scriptUri}}', scriptUri.toString());
      return html;
    } catch {
      // Fallback: inline HTML
      return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${styleUri}">
<link rel="stylesheet" href="${katexStyleUri}">
</head><body>
<p>加载侧边栏失败，请重新加载窗口。</p>
<script src="${markdownItUri}"></script>
<script src="${katexScriptUri}"></script>
<script src="${katexAutoRenderUri}"></script>
<script src="${scriptUri}"></script>
</body></html>`;
    }
  }
}
