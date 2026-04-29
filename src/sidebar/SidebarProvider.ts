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
  ExamPrepSession,
  ExamSubmission,
  ExamGradingResult,
  LessonMeta,
  OutlineRebuildApplyRequest,
  OutlineRebuildImpactSummary,
  OutlineRebuildMode,
  OutlineRebuildPreviewRequest,
  OutlineRebuildPreviewResult,
  OutlineRebuildSelection,
  Subject,
  TopicOutline,
  WrongQuestion,
  AnswerSubmission,
  Exercise,
  GradeResult,
} from '../types';
import { readJson } from '../utils/fileSystem';
import { AIClient } from '../ai/client';
import { AIProfileManager } from '../ai/profileManager';
import { chatPrompt, reviseMarkdownPatchPrompt, reviseMarkdownPrompt } from '../ai/prompts';
import { buildCourseSummaryMd, openMarkdownPreview, reprocessMarkdown, writeMarkdown, writeMarkdownAndPreview } from '../utils/markdown';
import { fileExists, ensureDir } from '../utils/fileSystem';
import { getDataDirectory } from '../config';
import { recordGradeForCoach } from '../coach/streakHook';

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

/** 由 extension.ts 注入的 Coach 框架共享实例。 */
export interface SidebarCoachDeps {
  coachEventBus: import('../coach/coachEventBus').CoachEventBus;
  coachStateStore: import('../coach/coachState').CoachStateStore;
  suggestionStore: import('../coach/suggestionStore').SuggestionStore;
  sessionLogger: import('../coach/sessionLogger').SessionLogger;
  learningPlanStore: import('../coach/learningPlanStore').LearningPlanStore;
}

/** 由 extension.ts 注入的备考模式共享实例。 */
export interface SidebarExamDeps {
  examPrepStore: import('../exam/examPrepStore').ExamPrepStore;
  examAnalyzer: import('../exam/examAnalyzer').ExamAnalyzer;
  examVariantGenerator: import('../exam/examVariantGenerator').ExamVariantGenerator;
  examGrader: import('../exam/examGrader').ExamGrader;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private contentGen = new ContentGenerator();
  private grader = new Grader();
  private courseManager = new CourseManager();
  /**
   * MaterialManager 由 extension.ts 注入（必须 — 共享 hybrid RAG 依赖）。
   * 之前的 bug：SidebarProvider 自己 new MaterialManager()，跟 extension.ts
   * 的实例不是同一个，导致 setHybridDeps 配的 vectorIndex 永远拿不到，所有
   * 资料显示"未向量化"且无法 reindex（"hybrid 未初始化"错误）。
   */
  private readonly materialManager: MaterialManager;
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
  private coachAgent?: import('../coach/coachAgent').CoachAgent;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly aiProfiles: AIProfileManager,
    private readonly onAIConfigChanged?: () => void,
    private readonly coachDeps?: SidebarCoachDeps,
    private readonly examDeps?: SidebarExamDeps,
    /** Hybrid RAG 共享：必须从 extension.ts 注入已 setHybridDeps 的实例 */
    materialManager?: MaterialManager,
  ) {
    this.materialManager = materialManager ?? new MaterialManager();
    this.materialManager.onDidChangeIndex((index) => {
      void this._collectVectorStats(index).then((vectorStats) => {
        this._post({ type: 'materials', data: index, vectorStats });
        void this._refreshSelectedMaterialPreview(index);
      });
    });
    // 向量化进度向 webview 广播 log（可视化感知）
    this.materialManager.onDidVectorize((event) => {
      if (event.kind === 'done') {
        this._post({
          type: 'log',
          message: `[向量化] ${event.fileName ?? ''} 完成`,
          level: 'info',
        });
        // 索引变化后刷新一次资料列表，让卡片状态变绿
        void this._refreshMaterials().catch(() => undefined);
      } else if (event.kind === 'error') {
        this._post({
          type: 'log',
          message: `[向量化失败] ${event.fileName ?? ''}：${event.message ?? ''}`,
          level: 'warn',
        });
      }
    });
  }

  /** 由 extension.ts 注入 CoachAgent（避免循环依赖在 ctor 处理）。 */
  attachCoachAgent(agent: import('../coach/coachAgent').CoachAgent): void {
    this.coachAgent = agent;
  }

  /** 给 CoachAgent 用：把建议等响应推到 webview。 */
  postMessage(msg: SidebarResponse): void {
    this._view?.webview.postMessage(msg);
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
    // Coach: 把 visibility 变化推给事件总线
    webviewView.onDidChangeVisibility(() => {
      this.coachDeps?.coachEventBus.emit({
        kind: webviewView.visible ? 'webview-visible' as any : 'webview-hidden' as any,
        at: new Date().toISOString(),
      });
    });
    // 首次解析就视作可见
    this.coachDeps?.coachEventBus.emit({
      kind: 'webview-visible' as any,
      at: new Date().toISOString(),
    });
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

  private async _refreshWrongQuestions(subject: Subject) {
    try {
      const list = await this.courseManager.listWrongQuestions(subject, { onlyUnresolved: true, limit: 50 });
      this._post({ type: 'wrongQuestions', subject, data: list });
    } catch (error) {
      console.error('Refresh wrong questions failed:', error);
    }
  }

  private async _refreshMaterials() {
    const index = await this.materialManager.getIndex();
    const vectorStats = await this._collectVectorStats(index);
    this._post({ type: 'materials', data: index, vectorStats });
    await this._refreshSelectedMaterialPreview(index);
  }

  /**
   * 收集 index 内所有资料的向量索引状态。
   * 静态读单文件 + JSON parse，几十份资料 < 50ms，可接受。
   * 同时返回 chapter 数量，用于 UI 区分 v1（无章节）/ v2（含章节）。
   */
  private async _collectVectorStats(index: MaterialIndex): Promise<
    Record<string, {
      exists: boolean;
      chunks: number;
      chapters?: number;
      version?: number;
      model?: string;
      dimension?: number;
    }>
  > {
    const out: Record<string, {
      exists: boolean;
      chunks: number;
      chapters?: number;
      version?: number;
      model?: string;
      dimension?: number;
    }> = {};
    await Promise.all(
      index.materials.map(async (m) => {
        try {
          const stats = await this.materialManager.getVectorIndexStats(m);
          // 多读一次 raw 文件取 chapters 数 + version（getVectorIndexStats 没暴露这俩）
          let chapterCount: number | undefined;
          let version: number | undefined;
          if (stats.exists) {
            try {
              const fs = await import('fs/promises');
              const path = await import('path');
              const vecPath = path.join(m.storageDir ?? '', 'vector-index.json');
              const raw = await fs.readFile(vecPath, 'utf-8');
              const parsed = JSON.parse(raw);
              chapterCount = Array.isArray(parsed.chapters) ? parsed.chapters.length : 0;
              version = Number(parsed.version) || undefined;
            } catch { /* fallback to undefined */ }
          }
          out[m.id] = {
            exists: stats.exists,
            chunks: stats.chunks,
            chapters: chapterCount,
            version,
            model: stats.model,
            dimension: stats.dimension,
          };
        } catch {
          out[m.id] = { exists: false, chunks: 0 };
        }
      }),
    );
    return out;
  }

  /**
   * Insights Panel 用的 courseProfile 推送（裁剪敏感字段后的精简版）。
   * 整份 CourseProfile 含 recentEvents 200+ 条，前端只需要 chapters + overall 用于可视化。
   */
  private async _pushCourseProfile(subject: Subject): Promise<void> {
    try {
      const profile = await this.courseProfileStore.getProfile(subject);
      if (!profile) return;
      // 裁剪：去掉 recentEvents（webview 不需要原始事件流，那是 Evidence Trail 单独的事）
      const slim = {
        subject: profile.subject,
        courseTitle: profile.courseTitle,
        updatedAt: profile.updatedAt,
        overall: profile.overall,
        chapters: profile.chapters.map((c) => ({
          topicId: c.topicId,
          chapterNumber: c.chapterNumber,
          title: c.title,
          status: c.status,
          masteryPercent: c.masteryPercent,
          gradeCount: c.gradeCount,
          weaknessTags: c.weaknessTags,
          strengthTags: c.strengthTags,
          weaknessTrend: c.weaknessTrend,
          recentScores: c.recentScores,
        })),
      };
      this._post({ type: 'courseProfile', subject, data: slim as any });
    } catch (err) {
      console.warn('[SidebarProvider] _pushCourseProfile failed', err);
    }
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

  /**
   * 读用户偏好的检索片段数（retrieval.maxExcerpts），按场景档位轻量加权。
   * - 'light'  ：日常 chat / 默认课程问答（接近用户原值）
   * - 'normal' ：练习 / 讲义生成（用户值 +0/+1）
   * - 'deep'   ：大纲重构 / 整本资料对话（用户值 +2，给更多上下文）
   * 用户值范围 2-8，最终结果再 clamp 到 [2, 10]，避免极端值。
   */
  private async _resolveMaxExcerpts(tier: 'light' | 'normal' | 'deep' = 'light'): Promise<number> {
    let base = 4;
    try {
      const prefs = await this.prefsStore.get();
      const v = Number((prefs as any)?.retrieval?.maxExcerpts);
      if (Number.isFinite(v) && v > 0) {
        base = Math.max(2, Math.min(8, Math.round(v)));
      }
    } catch {
      /* keep default */
    }
    const bump = tier === 'deep' ? 2 : tier === 'normal' ? 1 : 0;
    return Math.max(2, Math.min(10, base + bump));
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
    sources: import('../types').GroundingSource[];
  }> {
    if (!subject) {
      return { sources: [] };
    }

    const outline = await this.courseManager.getCourseOutline(subject);
    const grounding = await this.materialManager.buildGroundingContext(subject, query, {
      materialId: options?.materialId,
      materialIds: options?.materialIds,
      maxExcerpts: options?.maxExcerpts,
      // 把课程教学法 tag 传给检索：tag 偏好的 materialType 会获得加权
      courseTags: outline?.tags,
    });

    return {
      currentCourseTitle: outline?.title,
      courseOutlineSummary: this._buildCourseOutlineSummarySafe(outline),
      materialSummary: grounding.summary,
      materialExerciseSummary: grounding.exerciseSummary,
      retrievedExcerpts: grounding.excerpts,
      selectedMaterialTitle: grounding.materialTitle,
      sources: (grounding as any).sources ?? [],
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
    sources: import('../types').GroundingSource[];
  }> {
    if (!subject) {
      return { sources: [] };
    }

    const resolvedMode: ChatGroundingMode = mode ?? 'course';
    if (resolvedMode === 'general') {
      return { sources: [] };
    }

    const maxExcerpts = await this._resolveMaxExcerpts(
      resolvedMode === 'material' ? 'normal' : 'light',
    );
    return this._buildSubjectGrounding(subject, message, {
      materialId: resolvedMode === 'material' ? materialId : undefined,
      maxExcerpts,
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
    const outlineMaxExcerpts = await this._resolveMaxExcerpts('deep');
    const grounding = await this._buildSubjectGrounding(
      request.subject,
      [currentOutline.title, request.instruction ?? '', 'course outline rebuild'].join(' ').trim(),
      { materialIds, maxExcerpts: outlineMaxExcerpts },
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
    const base = await this.courseProfileStore.buildPromptContext(subject, topicId);
    // 课程教学法 tag：从课程大纲读取，与 courseProfileContext 一起注入到 prompt ctx
    let courseTags: import('../types').CourseTag[] | undefined;
    if (subject) {
      try {
        const outline = await this.courseManager.getCourseOutline(subject);
        if (outline?.tags && outline.tags.length > 0) {
          courseTags = outline.tags;
        }
      } catch (error) {
        console.warn('[SidebarProvider] failed to read course tags:', error);
      }
    }
    return { ...base, courseTags };
  }

  /**
   * 给备考相关的 prompt 拼一份完整 ctx：复用 _buildCourseProfileContext + 学生画像 + 偏好。
   */
  private async _buildExamPromptContext(subject: Subject) {
    const [prefs, profile, courseProfileContext] = await Promise.all([
      this.prefsStore.get(),
      this.progressStore.getProfile(),
      this._buildCourseProfileContext(subject),
    ]);
    return { profile, preferences: prefs, ...courseProfileContext };
  }

  /**
   * 备考批改后把错题归档到错题本（source='exam-session'）。
   */
  private async _archiveExamWrongQuestions(
    session: ExamPrepSession,
    variantSet: import('../types').ExamVariantSet | null,
    grading: ExamGradingResult,
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const q of grading.perQuestion) {
      if (q.correct === true) continue; // 只归档错题（含 partial）

      // 找题面：优先 variantSet，其次 paperAnalyses 的 rawSnippet
      let prompt = '';
      let exerciseId = `exam-${session.id}-${q.questionNumber}`;
      let topicId = `exam-prep`;
      let topicTitle = '备考训练';
      let lessonId = session.id;
      let lessonTitle = session.name;

      if (variantSet) {
        const matched = variantSet.questions.find((vq) => vq.number === q.questionNumber || vq.id === q.questionNumber);
        if (matched) {
          prompt = matched.prompt;
          exerciseId = `${variantSet.id}-${matched.id}`;
        }
      }
      if (!prompt) {
        for (const analysis of session.paperAnalyses) {
          for (const sec of analysis.sections) {
            const found = sec.questions.find((pq) => pq.number === q.questionNumber);
            if (found) {
              prompt = found.rawSnippet ?? `真题 ${q.questionNumber}（${found.knowledgePoints.join('、')}）`;
              break;
            }
          }
          if (prompt) break;
        }
      }
      if (!prompt) {
        prompt = `备考题 ${q.questionNumber}（${q.knowledgePoints.join('、') || '未识别考点'}）`;
      }

      const wrong: WrongQuestion = {
        id: `wrong-${session.id}-${q.questionNumber}-${Date.now()}`,
        exerciseId,
        subject: session.subject,
        topicId,
        topicTitle,
        lessonId,
        lessonTitle,
        prompt,
        studentAnswer: q.studentAnswerOcr || '[未识别]',
        score: Math.round((q.score / Math.max(1, q.maxScore)) * 100),
        feedback: q.feedback,
        weaknesses: q.knowledgePoints,
        weaknessTags: q.weaknessTags ?? [],
        attempts: 1,
        firstFailedAt: now,
        lastAttemptedAt: now,
        resolved: false,
        source: 'exam-session',
        examSessionId: session.id,
      };
      try {
        await this.courseManager.upsertWrongQuestion(session.subject, wrong);
      } catch (err) {
        console.warn('[ExamPrep] archive wrong question failed:', err);
      }
    }
  }

  private async _loadLessonExercises(subject: Subject, topicId: string, lessonId: string): Promise<Exercise[]> {
    const sessionId = await this.courseManager.getDeterministicSessionId(subject, topicId, lessonId);
    const jsonPath = this.courseManager.getExerciseJsonPath(subject, topicId, sessionId);
    const exercises = await readJson<Exercise[]>(jsonPath);
    return Array.isArray(exercises) ? exercises : [];
  }

  /**
   * 容错匹配：兼容旧练习中 AI 给的 `ex-01` 格式与新 webview 解析出的 `ex-1`。
   * 优先严格相等，其次按尾数字位置（ex-N → 第 N 道），再按尾数字相等（ex-1 ↔ ex-01）。
   */
  private _matchExerciseLoosely(exercises: Exercise[], submissionId: string): Exercise | undefined {
    const strict = exercises.find((item) => item.id === submissionId);
    if (strict) return strict;

    const numMatch = String(submissionId).match(/(\d+)\s*$/);
    if (!numMatch) return undefined;
    const num = Number.parseInt(numMatch[1], 10);
    if (!Number.isFinite(num)) return undefined;

    if (num >= 1 && num <= exercises.length) {
      return exercises[num - 1];
    }
    return exercises.find((item) => {
      const itemMatch = String(item.id).match(/(\d+)\s*$/);
      if (!itemMatch) return false;
      return Number.parseInt(itemMatch[1], 10) === num;
    });
  }

  private async _gradeOneAnswer(args: {
    subject: Subject;
    topicId: string;
    topicTitle: string;
    lessonId: string;
    lessonTitle: string;
    exercise: Exercise;
    answer: string;
  }): Promise<GradeResult> {
    const [prefs, diag, profile, courseProfileContext] = await Promise.all([
      this.prefsStore.get(),
      this.adaptiveEngine.getLatestDiagnosis(args.subject),
      this.progressStore.getProfile(),
      this._buildCourseProfileContext(args.subject, args.topicId),
    ]);

    const sessionId = await this.courseManager.getDeterministicSessionId(args.subject, args.topicId, args.lessonId);
    const result = await this.grader.grade(
      args.exercise,
      args.answer,
      args.subject,
      args.topicId,
      sessionId,
      { profile, preferences: prefs, diagnosis: diag, ...courseProfileContext },
      { topicTitle: args.topicTitle, lessonTitle: args.lessonTitle, lessonId: args.lessonId },
    );

    return result;
  }

  /**
   * 批改完成后让 Coach（streak / 跨课时 weakness / loop fanout）联动一次。
   * Fire-and-forget：失败不影响批改主流程。
   */
  private _coachAfterGrade(args: {
    subject: Subject;
    topicId: string;
    topicTitle: string;
    lessonId: string;
    lessonTitle: string;
    result: GradeResult;
  }): void {
    if (!this.coachDeps || !this.coachAgent) {
      return;
    }
    const bus = this.coachDeps.coachEventBus;
    const agent = this.coachAgent;
    const adaptiveEngine = this.adaptiveEngine;
    void (async () => {
      try {
        const outline = await this.courseManager.getCourseOutline(args.subject).catch(() => null);
        await recordGradeForCoach({
          subject: args.subject,
          topicId: args.topicId,
          topicTitle: args.topicTitle,
          lessonId: args.lessonId,
          lessonTitle: args.lessonTitle,
          score: args.result.score,
          weaknessTags: args.result.weaknessTags ?? [],
          adaptiveEngine,
          bus,
          agent,
          outline,
        });
      } catch (err) {
        console.error('[SidebarProvider] _coachAfterGrade error:', err);
      }
    })();
  }

  /**
   * Fire-and-forget 风格：如果触发器命中，启动一个独立 "自动诊断" task。
   * 不阻塞调用方，让批改任务能立即完成。
   */
  private _scheduleAutoDiagnosis(subject: Subject): void {
    void (async () => {
      try {
        const trigger = await this.adaptiveEngine.getTriggerState(subject);
        // 提前判断是否需要：避免无意义启动 task
        if (trigger.gradesSinceLastDiagnosis < 1) {
          return;
        }

        this._startTask('自动诊断', async () => {
          const outcome = await this.adaptiveEngine.maybeAutoRunDiagnosis(subject);
          if (outcome.ran && outcome.diagnosis) {
            this._view?.webview.postMessage({
              type: 'autoDiagnosisRan',
              subject,
              reason: outcome.reason ?? 'manual',
            });
            this._post({ type: 'diagnosis', data: outcome.diagnosis });
            await this._refreshCourses();
            this._post({
              type: 'log',
              message: `已自动重新诊断（${outcome.reason ?? 'manual'}）`,
              level: 'info',
            });
          }
        });
      } catch (error) {
        console.error('Auto diagnosis schedule failed:', error);
      }
    })();
  }

  private async _maybeRunAutoDiagnosis(subject: Subject): Promise<void> {
    this._scheduleAutoDiagnosis(subject);
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

        case 'setCourseTags': {
          const subject = msg.subject as Subject;
          const tags = Array.isArray(msg.tags) ? msg.tags : [];
          if (!subject) break;
          const ok = await this.courseManager.setCourseTags(subject, tags);
          if (ok) {
            this._post({
              type: 'log',
              message: `已为 "${subject}" 设置教学法 tag：${tags.join(' / ') || '（无）'}`,
              level: 'info',
            });
            await this._refreshCourses();
          } else {
            this._post({ type: 'log', message: `设置 tag 失败：课程不存在`, level: 'warn' });
          }
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
            const rebuildMaxExcerpts = await this._resolveMaxExcerpts('deep');
            const grounding = await this._buildSubjectGrounding(
              msg.subject,
              [currentOutline.title, '重构课程大纲'].join(' '),
              { materialId: msg.materialId, maxExcerpts: rebuildMaxExcerpts },
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
            // 按偏好分发：自渲染 webview / VS Code 原生 preview
            const prefs = await this.prefsStore.get();
            const viewerMode = prefs.coach?.lecture?.viewerMode ?? 'lecture-webview';
            if (viewerMode === 'lecture-webview' || viewerMode === 'split-both') {
              await vscode.commands.executeCommand('claudeCoach.openLectureViewer', {
                filePath: lessonPath,
                subject: msg.subject,
                topicId: msg.topicId,
                topicTitle: msg.topicTitle,
                lessonId: msg.lessonId,
                lessonTitle: msg.lessonTitle,
              });
              if (viewerMode === 'split-both') {
                await openMarkdownPreview(lessonPath, 'native-preview');
              }
            } else {
              await openMarkdownPreview(lessonPath, 'native-preview');
            }
            // 给事件总线一个 lesson-opened 信号
            this.coachDeps?.coachEventBus.emit({
              kind: 'lesson-opened',
              at: new Date().toISOString(),
              subject: msg.subject,
              topicId: msg.topicId,
              lessonId: msg.lessonId,
            });
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
            const [prefs, diag, profile, lessonWrongs] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
              this.courseManager.listWrongQuestions(msg.subject, {
                topicId: msg.topicId,
                lessonId: msg.lessonId,
                onlyUnresolved: true,
                limit: 4,
              }),
            ]);
            const lessonMaxExcerpts = await this._resolveMaxExcerpts('normal');
            const grounding = await this._buildSubjectGrounding(
              msg.subject,
              [msg.topicTitle, msg.lessonTitle, '讲义'].filter(Boolean).join(' '),
              { maxExcerpts: lessonMaxExcerpts },
            );
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject, msg.topicId);
            await this.contentGen.generateLesson(
              msg.subject, msg.topicId, msg.topicTitle, msg.lessonId, msg.lessonTitle, msg.difficulty,
              { profile, preferences: prefs, diagnosis: diag, ...courseProfileContext, ...grounding },
              lessonWrongs,
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
            const prefs = await this.prefsStore.get();
            const viewerMode = prefs.coach?.lecture?.viewerMode ?? 'lecture-webview';
            if (viewerMode === 'lecture-webview' || viewerMode === 'split-both') {
              await vscode.commands.executeCommand('claudeCoach.openLectureViewer', {
                filePath: lPath,
                subject: msg.subject,
                topicId: msg.topicId,
                topicTitle: msg.topicTitle,
                lessonId: msg.lessonId,
                lessonTitle: msg.lessonTitle,
              });
              if (viewerMode === 'split-both') {
                await openMarkdownPreview(lPath, 'native-preview');
              }
            } else {
              await openMarkdownPreview(lPath, 'native-preview');
            }
            this.coachDeps?.coachEventBus.emit({
              kind: 'lesson-opened',
              at: new Date().toISOString(),
              subject: msg.subject,
              topicId: msg.topicId,
              lessonId: msg.lessonId,
            });
          } else {
            vscode.window.showInformationMessage('该小节尚未生成讲义，请点击"讲义"按钮生成。');
          }
          break;
        }

        case 'openOrGenerateExercises':
        case 'generateExercises': {
          const expectedSessionId = await this.courseManager.getDeterministicSessionId(msg.subject, msg.topicId, msg.lessonId);
          await this.courseManager.migrateExerciseMarkdownNameIfNeeded(msg.subject, msg.topicId, expectedSessionId);
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
            const [prefs, diag, profile, lessonWrongs, triggerState] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(msg.subject),
              this.progressStore.getProfile(),
              this.courseManager.listWrongQuestions(msg.subject, {
                topicId: msg.topicId,
                lessonId: msg.lessonId,
                onlyUnresolved: true,
                limit: 5,
              }),
              this.adaptiveEngine.getTriggerState(msg.subject),
            ]);
            const exerciseMaxExcerpts = await this._resolveMaxExcerpts('normal');
            const grounding = await this._buildSubjectGrounding(
              msg.subject,
              [msg.topicTitle, msg.lessonTitle, '练习题'].filter(Boolean).join(' '),
              { maxExcerpts: exerciseMaxExcerpts },
            );
            const courseProfileContext = await this._buildCourseProfileContext(msg.subject, msg.topicId);
            await this.contentGen.generateExercises(
              msg.subject, msg.topicId, msg.lessonId, msg.lessonTitle, msg.count, msg.difficulty,
              {
                profile,
                preferences: prefs,
                diagnosis: diag,
                ...courseProfileContext,
                ...grounding,
                // P1-3: streak 信号让难度调节即便单 grade 也能生效
                streak: triggerState.streak,
                streakDirection: triggerState.streakDirection,
              },
              lessonWrongs,
            );
            await this.progressStore.incrementSession();
            await this._refreshCourses();
            this._post({
              type: 'log',
              message: lessonWrongs.length > 0
                ? `已生成 ${msg.count} 道练习题（已结合 ${lessonWrongs.length} 道历史错题）`
                : `已生成 ${msg.count} 道练习题`,
              level: 'info',
            });
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
          const subject = msg.subject as Subject;
          const topicId = String(msg.topicId ?? '');
          const lessonId = String(msg.lessonId ?? '');
          const exerciseId = String(msg.exerciseId ?? '');
          const answer = String(msg.answer ?? '').trim();
          const topicTitle = String(msg.topicTitle ?? topicId);
          const lessonTitle = String(msg.lessonTitle ?? lessonId);

          if (!subject || !topicId || !lessonId || !exerciseId || !answer) {
            this._post({ type: 'log', message: '提交答案缺少必要参数', level: 'warn' });
            break;
          }

          this._startTask(`批改 ${lessonTitle}`, async () => {
            await this.courseManager.migrateExerciseMarkdownNameIfNeeded(subject, topicId, lessonId);
            const exercises = await this._loadLessonExercises(subject, topicId, lessonId);
            const exercise = this._matchExerciseLoosely(exercises, exerciseId);
            if (!exercise) {
              throw new Error(`未在练习 JSON 中找到 ${exerciseId}`);
            }
            const result = await this._gradeOneAnswer({
              subject, topicId, topicTitle, lessonId, lessonTitle, exercise, answer,
            });
            await this.progressStore.incrementExercises(1);
            this._post({ type: 'gradeResult', result });
            this._post({ type: 'log', message: `批改完成，得分 ${result.score}/100`, level: 'info' });
            await this.courseManager.syncLessonStatus(subject, topicId, lessonId);
            await this._refreshCourses();
            this._coachAfterGrade({ subject, topicId, topicTitle, lessonId, lessonTitle, result });
            await this._maybeRunAutoDiagnosis(subject);
          });
          break;
        }

        case 'submitAllAnswers': {
          const subject = msg.subject as Subject;
          const topicId = String(msg.topicId ?? '');
          const lessonId = String(msg.lessonId ?? '');
          const topicTitle = String(msg.topicTitle ?? topicId);
          const lessonTitle = String(msg.lessonTitle ?? lessonId);
          const submissions: AnswerSubmission[] = Array.isArray(msg.answers) ? msg.answers : [];
          const valid = submissions
            .map((item) => ({ exerciseId: String(item?.exerciseId ?? '').trim(), answer: String(item?.answer ?? '').trim() }))
            .filter((item) => item.exerciseId && item.answer);

          if (!subject || !topicId || !lessonId || valid.length === 0) {
            this._post({ type: 'log', message: '没有可提交的答案', level: 'warn' });
            break;
          }

          this._startTask(`批改 ${lessonTitle}`, async () => {
            await this.courseManager.migrateExerciseMarkdownNameIfNeeded(subject, topicId, lessonId);
            const exercises = await this._loadLessonExercises(subject, topicId, lessonId);
            const total = valid.length;
            let succeeded = 0;
            let lastResult: GradeResult | null = null;
            const scores: number[] = [];

            for (let index = 0; index < valid.length; index += 1) {
              const submission = valid[index];
              const exercise = this._matchExerciseLoosely(exercises, submission.exerciseId);
              if (!exercise) {
                this._post({ type: 'log', message: `跳过未匹配的练习 ${submission.exerciseId}（共 ${exercises.length} 道）`, level: 'warn' });
                continue;
              }
              this._view?.webview.postMessage({
                type: 'gradingProgress',
                current: index + 1,
                total,
                lessonTitle,
              });
              try {
                lastResult = await this._gradeOneAnswer({
                  subject, topicId, topicTitle, lessonId, lessonTitle, exercise, answer: submission.answer,
                });
                scores.push(lastResult.score);
                this._post({ type: 'gradeResult', result: lastResult });
                succeeded += 1;
                this._coachAfterGrade({
                  subject, topicId, topicTitle, lessonId, lessonTitle, result: lastResult,
                });
              } catch (error: any) {
                this._post({
                  type: 'log',
                  message: `批改失败 ${submission.exerciseId}：${error?.message || error}`,
                  level: 'error',
                });
              }
            }

            if (succeeded > 0) {
              await this.progressStore.incrementExercises(succeeded);
              const avg = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0;
              this._post({
                type: 'log',
                message: `批改 ${succeeded}/${total} 道完成，平均分 ${avg}`,
                level: 'info',
              });
              await this.courseManager.syncLessonStatus(subject, topicId, lessonId);
              await this._refreshCourses();
              await this._refreshWrongQuestions(subject);
              // 触发器计数 +succeeded：先静默 record (succeeded-1) 次，最后一次走 maybeAutoRun（自带 +1）
              for (let extraIndex = 0; extraIndex < succeeded - 1; extraIndex += 1) {
                try {
                  await this.adaptiveEngine.recordGradeForAdaptive(subject);
                } catch (error) {
                  console.error('Recording adaptive grade failed:', error);
                }
              }
              this._scheduleAutoDiagnosis(subject);
            } else {
              this._post({ type: 'log', message: '本次批改未成功完成任何一题', level: 'warn' });
            }
          });
          break;
        }

        case 'getDiagnosis': {
          if (!msg.subject) {
            this._post({ type: 'diagnosis', data: null });
            this._post({ type: 'log', message: '请先选择当前课程，再运行学习诊断', level: 'warn' });
            break;
          }
          // 顺手推一份 courseProfile（Insights Panel 用的）—— 比单独走一个消息更省 round-trip
          void this._pushCourseProfile(msg.subject);
          if (!msg.run) {
            const diag = await this.adaptiveEngine.getLatestDiagnosis(msg.subject);
            this._post({ type: 'diagnosis', data: diag });
            break;
          }
          this._startTask('学习诊断', async () => {
            const diag = await this.adaptiveEngine.runDiagnosis(msg.subject);
            this._post({ type: 'diagnosis', data: diag });
            await this._refreshCourses();
            void this._pushCourseProfile(msg.subject);
            this._post({ type: 'log', message: '学习诊断已完成', level: 'info' });
          });
          break;
        }

        case 'getCourseProfile': {
          if (!msg.subject) break;
          await this._pushCourseProfile(msg.subject);
          break;
        }

        case 'scanExercises':
        case 'scanAllExercises': {
          this._startTask('扫描练习', async () => {
            const count = await this.exerciseScanner.scanAndGradeAll();
            await this.courseManager.syncLessonStatuses();
            await this._refreshCourses();
            this._post({ type: 'log', message: count > 0 ? `自动批改 ${count} 道练习` : '没有发现未批改的练习', level: 'info' });
            if (count > 0 && msg.subject) {
              await this._maybeRunAutoDiagnosis(msg.subject as Subject);
            } else if (count > 0 && this.lastOpenedLessonFile?.subject) {
              await this._maybeRunAutoDiagnosis(this.lastOpenedLessonFile.subject);
            }
          });
          break;
        }

        case 'retryMaterial': {
          const materialId = String(msg.materialId ?? '');
          if (!materialId) {
            this._post({ type: 'log', message: '缺少要重试的资料 ID', level: 'warn' });
            break;
          }
          this._startTask('重试资料索引', async () => {
            const entries = await this.materialManager.reconcileMaterials(undefined, { materialId });
            const refreshed = entries.find((entry) => entry.id === materialId);
            this._post({
              type: 'log',
              message: refreshed
                ? `资料已重新处理：${refreshed.fileName}（状态 ${refreshed.status}）`
                : `资料 ${materialId} 未找到或处理失败`,
              level: refreshed?.status === 'failed' ? 'warn' : 'info',
            });
            await this._refreshMaterials();
          });
          break;
        }

        case 'getWrongQuestions': {
          const subject = (msg.subject ?? this.lastOpenedLessonFile?.subject) as Subject | undefined;
          if (!subject) {
            this._post({ type: 'wrongQuestions', subject: undefined, data: [] });
            break;
          }
          await this._refreshWrongQuestions(subject);
          break;
        }

        case 'resolveWrongQuestion': {
          const subject = msg.subject as Subject;
          const questionId = String(msg.questionId ?? '');
          if (!subject || !questionId) {
            this._post({ type: 'log', message: '缺少错题信息', level: 'warn' });
            break;
          }
          await this.courseManager.resolveWrongQuestion(subject, questionId);
          this._post({ type: 'log', message: '已标记错题为已解决', level: 'info' });
          await this._refreshWrongQuestions(subject);
          break;
        }

        case 'practiceAdaptiveNext': {
          // 流式难度：基于刚做完几道的表现，再出 1 题
          const subject = msg.subject as Subject;
          const topicId = String(msg.topicId ?? '');
          const lessonId = String(msg.lessonId ?? '');
          const lessonTitle = String(msg.lessonTitle ?? lessonId);
          const topicTitle = String((msg as any).topicTitle ?? '');
          const baseDifficulty = Number(msg.baseDifficulty) || 3;
          if (!subject || !topicId || !lessonId) {
            this._post({ type: 'log', message: '缺少必要参数', level: 'warn' });
            break;
          }
          this._startTask(`自适应出题 · ${lessonTitle}`, async () => {
            const [prefs, diag, profile, recentGrades, triggerState] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(subject),
              this.progressStore.getProfile(),
              this.courseManager.listRecentLessonGrades(subject, topicId, lessonId, 5),
              this.adaptiveEngine.getTriggerState(subject),
            ]);
            const recentSessionScores = recentGrades.map((g) => g.score).filter((n) => Number.isFinite(n));
            if (!recentSessionScores.length) {
              this._post({ type: 'log', message: '本节还没批改记录，请先做完一批练习再用自适应模式', level: 'warn' });
              return;
            }

            const groundingMaxExcerpts = await this._resolveMaxExcerpts('light');
            const grounding = await this._buildSubjectGrounding(
              subject,
              [topicTitle, lessonTitle, '自适应出题'].filter(Boolean).join(' '),
              { maxExcerpts: groundingMaxExcerpts },
            );
            const courseProfileContext = await this._buildCourseProfileContext(subject, topicId);

            await this.contentGen.generateExercises(
              subject, topicId, lessonId, lessonTitle, 1, baseDifficulty,
              {
                profile,
                preferences: prefs,
                diagnosis: diag,
                ...courseProfileContext,
                ...grounding,
                streak: triggerState.streak,
                streakDirection: triggerState.streakDirection,
                recentSessionScores,
              },
            );
            const avg = Math.round(recentSessionScores.reduce((s, x) => s + x, 0) / recentSessionScores.length);
            this._post({
              type: 'log',
              message: `已生成 1 道自适应题（最近 ${recentSessionScores.length} 道平均 ${avg} 分 → 难度自调）`,
              level: 'info',
            });
            await this._refreshCourses();
          });
          break;
        }

        case 'practiceWrongQuestions': {
          const subject = msg.subject as Subject;
          const topicId = String(msg.topicId ?? '');
          const lessonId = String(msg.lessonId ?? '');
          const lessonTitle = String(msg.lessonTitle ?? lessonId);
          const count = Number.isFinite(Number(msg.count)) ? Number(msg.count) : 5;

          if (!subject || !topicId || !lessonId) {
            this._post({ type: 'log', message: '请先在课程树中点开任一课时再触发针对错题再练', level: 'warn' });
            break;
          }

          this._startTask(`错题再练 ${lessonTitle}`, async () => {
            const wrongs = await this.courseManager.listWrongQuestions(subject, {
              onlyUnresolved: true,
              limit: 8,
            });
            if (wrongs.length === 0) {
              this._post({ type: 'log', message: '错题本为空，无需再练', level: 'info' });
              return;
            }

            const lessonWrongs = wrongs.filter((item) => item.lessonId === lessonId);
            const focusedWrongs = (lessonWrongs.length ? lessonWrongs : wrongs).slice(0, 3);

            const [prefs, diag, profile, triggerState] = await Promise.all([
              this.prefsStore.get(),
              this.adaptiveEngine.getLatestDiagnosis(subject),
              this.progressStore.getProfile(),
              this.adaptiveEngine.getTriggerState(subject),
            ]);
            const wrongPracticeMaxExcerpts = await this._resolveMaxExcerpts('light');
            const grounding = await this._buildSubjectGrounding(
              subject,
              [lessonTitle, '错题再练', '薄弱点强化'].join(' '),
              { maxExcerpts: wrongPracticeMaxExcerpts },
            );
            const courseProfileContext = await this._buildCourseProfileContext(subject, topicId);

            await this.contentGen.generateExercises(
              subject, topicId, lessonId, lessonTitle, count, 3,
              {
                profile,
                preferences: prefs,
                diagnosis: diag,
                ...courseProfileContext,
                ...grounding,
                streak: triggerState.streak,
                streakDirection: triggerState.streakDirection,
              },
              focusedWrongs,
            );
            await this._refreshCourses();
            this._post({
              type: 'log',
              message: `已基于 ${focusedWrongs.length} 道错题为 ${lessonTitle} 再出 ${count} 道练习`,
              level: 'info',
            });
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

        case 'listAIProfiles': {
          const state = await this.aiProfiles.getState();
          this._view?.webview.postMessage({
            type: 'aiProfilesList',
            data: state.profiles,
            activeProfileId: state.activeProfileId,
          });
          break;
        }

        case '__legacy_saveAIProfile__':
        case 'saveAIProfile': {
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
          // 自动重发 list
          const stateAfter = await this.aiProfiles.getState();
          this._view?.webview.postMessage({
            type: 'aiProfilesList',
            data: stateAfter.profiles,
            activeProfileId: stateAfter.activeProfileId,
          });
          break;
        }

        case '__legacy_deleteAIProfile__':
        case 'deleteAIProfile': {
          const profileName = String(msg.profileName ?? msg.profileId ?? 'profile');
          const choice = await vscode.window.showWarningMessage(
            `确认删除 AI Profile "${profileName}"？此操作不可撤销。`,
            { modal: true },
            '删除',
          );
          if (choice !== '删除') {
            this._post({ type: 'log', message: '已取消删除 AI Profile', level: 'info' });
            break;
          }
          await this.aiProfiles.deleteProfile(msg.profileId);
          await this._afterAIConfigMutation('AI 配置已删除');
          const stateAfter = await this.aiProfiles.getState();
          this._view?.webview.postMessage({
            type: 'aiProfilesList',
            data: stateAfter.profiles,
            activeProfileId: stateAfter.activeProfileId,
          });
          break;
        }

        case '__legacy_duplicateAIProfile__':
        case 'duplicateAIProfile': {
          const duplicated = await this.aiProfiles.duplicateProfile(msg.profileId);
          await this._afterAIConfigMutation(`已复制 AI 配置：${duplicated.name}`);
          const stateAfter = await this.aiProfiles.getState();
          this._view?.webview.postMessage({
            type: 'aiProfilesList',
            data: stateAfter.profiles,
            activeProfileId: stateAfter.activeProfileId,
          });
          break;
        }

        case '__legacy_activateAIProfile__':
        case 'activateAIProfile': {
          await this.aiProfiles.activateProfile(msg.profileId);
          await this._afterAIConfigMutation('已切换当前 AI 配置');
          const stateAfter = await this.aiProfiles.getState();
          this._view?.webview.postMessage({
            type: 'aiProfilesList',
            data: stateAfter.profiles,
            activeProfileId: stateAfter.activeProfileId,
          });
          break;
        }

        case '__legacy_saveWorkspaceAIOverride__':
        case 'saveWorkspaceAIOverride': {
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

        case '__legacy_exportAIProfile__':
        case 'exportAIProfile': {
          // 让用户在原生 QuickPick 选择是否导出 token
          const choice = await vscode.window.showQuickPick(
            [
              { label: '不含 Token（脱敏，默认推荐）', value: false },
              { label: '含 Token（仅在你完全信任目标设备时）', value: true },
            ],
            { placeHolder: '导出 AI 配置 - 是否包含 Token？' },
          );
          if (!choice) {
            this._post({ type: 'log', message: '已取消导出', level: 'info' });
            break;
          }
          await this.aiProfiles.exportProfile(msg.profileId, choice.value);
          this._post({ type: 'log', message: 'AI 配置已导出', level: 'info' });
          break;
        }

        case '__legacy_testAIProfile__':
        case 'testAIProfile': {
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

        // ===== 数据管理 =====

        case 'clearWrongQuestions': {
          const subject = msg.subject as Subject;
          if (!subject) break;
          if (msg.requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              `确认清空 "${subject}" 的错题本？此操作不可撤销。`,
              { modal: true },
              '清空',
            );
            if (choice !== '清空') {
              this._post({ type: 'log', message: '已取消', level: 'info' });
              break;
            }
          }
          const book = await this.courseManager.getWrongQuestionBook(subject);
          for (const q of book.questions) {
            await this.courseManager.resolveWrongQuestion(subject, q.id);
          }
          await this.courseManager.clearResolvedWrongQuestions(subject);
          this._post({ type: 'dataOpResult', operation: 'clearWrongQuestions', ok: true, message: subject });
          await this._refreshWrongQuestions(subject);
          break;
        }

        case 'clearDiagnosisHistory': {
          const subject = msg.subject as Subject;
          if (!subject) break;
          if (msg.requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              `确认清空 "${subject}" 的诊断历史？最近一次诊断会保留。`,
              { modal: true },
              '清空',
            );
            if (choice !== '清空') break;
          }
          try {
            const { rm } = await import('fs/promises');
            const paths = (await import('../storage/pathResolver')).getStoragePathResolver();
            await rm(paths.diagnosisHistoryDirForSubject(subject), { recursive: true, force: true });
            this._post({ type: 'dataOpResult', operation: 'clearDiagnosisHistory', ok: true, message: subject });
          } catch (error: any) {
            this._post({ type: 'dataOpResult', operation: 'clearDiagnosisHistory', ok: false, message: error?.message });
          }
          break;
        }

        case 'resetCourseProgress': {
          const subject = msg.subject as Subject;
          if (!subject) break;
          if (msg.requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              `确认重置 "${subject}" 的所有课时进度？讲义和练习文件会保留，但状态全部清零。`,
              { modal: true },
              '重置',
            );
            if (choice !== '重置') break;
          }
          const outline = await this.courseManager.getCourseOutline(subject);
          if (!outline) {
            this._post({ type: 'dataOpResult', operation: 'resetCourseProgress', ok: false, message: '课程不存在' });
            break;
          }
          for (const topic of outline.topics) {
            for (const lesson of topic.lessons) {
              await this.courseManager.updateLessonStatus(subject, topic.id, lesson.id, 'not-started');
            }
          }
          this._post({ type: 'dataOpResult', operation: 'resetCourseProgress', ok: true, message: subject });
          await this._refreshCourses();
          break;
        }

        case 'exportLearningData': {
          const dir = getDataDirectory();
          await ensureDir(dir);
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
          this._post({ type: 'dataOpResult', operation: 'exportLearningData', ok: true, message: dir });
          break;
        }

        case 'importLearningData': {
          if (msg.requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              '导入学习数据会覆盖现有数据，确认继续？',
              { modal: true },
              '继续',
            );
            if (choice !== '继续') break;
          }
          this._post({ type: 'dataOpResult', operation: 'importLearningData', ok: false, message: '请手动复制文件到数据目录后重启扩展。' });
          break;
        }

        case 'resetAllPreferences': {
          if (msg.requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              '确认恢复全部默认设置？所有偏好会被重置（AI 配置除外）。',
              { modal: true },
              '恢复默认',
            );
            if (choice !== '恢复默认') break;
          }
          await this.prefsStore.resetAll();
          const fresh = await this.prefsStore.get();
          this._post({ type: 'preferences', data: fresh });
          this._post({ type: 'log', message: '已恢复全部默认设置', level: 'info' });
          break;
        }

        case 'exportPreferences': {
          try {
            const data = await this.prefsStore.exportRaw();
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file('claude-coach-preferences.json'),
              filters: { 'JSON': ['json'] },
              saveLabel: '导出偏好',
            });
            if (uri) {
              const { writeFile } = await import('fs/promises');
              await writeFile(uri.fsPath, JSON.stringify(data, null, 2), 'utf-8');
              this._post({ type: 'log', message: `偏好已导出到 ${uri.fsPath}`, level: 'info' });
            }
          } catch (error: any) {
            this._post({ type: 'log', message: `导出失败：${error?.message}`, level: 'error' });
          }
          break;
        }

        case 'importPreferences': {
          try {
            const [uri] = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectMany: false,
              filters: { 'JSON': ['json'] },
              openLabel: '导入偏好',
            }) ?? [];
            if (!uri) break;
            const { readFile } = await import('fs/promises');
            const text = await readFile(uri.fsPath, 'utf-8');
            const parsed = JSON.parse(text);
            const merged = await this.prefsStore.importRaw(parsed);
            this._post({ type: 'preferences', data: merged });
            this._post({ type: 'log', message: '偏好已导入', level: 'info' });
          } catch (error: any) {
            this._post({ type: 'log', message: `导入失败：${error?.message}`, level: 'error' });
          }
          break;
        }

        // ===== 向量检索 / Hybrid RAG =====

        case 'testEmbedding': {
          // 用临时 profile（msg 携带）测连通性，避免必须先 save 才能测
          try {
            const tempCfg = (msg as any).config || {};
            const { EmbeddingClient: EC } = await import('../ai/embeddingClient');
            const client = new EC(async () => ({
              enabled: true,
              baseUrl: String(tempCfg.baseUrl ?? '').trim(),
              apiToken: String(tempCfg.apiToken ?? '').trim(),
              model: String(tempCfg.model ?? '').trim() || 'BAAI/bge-m3',
              dimension: Number(tempCfg.dimension) || undefined,
            }));
            const result = await client.testConnection();
            this._post({ type: 'embeddingTestResult', data: result });
            this._post({
              type: 'log',
              message: `Embedding 测试：${result.message}`,
              level: result.ok ? 'info' : 'warn',
            });
          } catch (err: any) {
            this._post({
              type: 'embeddingTestResult',
              data: { ok: false, message: err?.message || String(err) },
            });
          }
          break;
        }

        case 'reindexAllVectors': {
          const subject = (msg as any).subject as Subject | undefined;
          if (!subject) {
            this._post({ type: 'log', message: '请选择学科再重建向量索引', level: 'warn' });
            break;
          }
          // confirm() 在 webview 里不工作；用原生 modal warning 询问
          if ((msg as any).requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              `将为学科「${subject}」的所有资料重建向量索引。此操作可能需要数分钟（视资料体量）。是否继续？`,
              { modal: true },
              '继续重建',
            );
            if (choice !== '继续重建') {
              this._post({ type: 'log', message: '已取消向量索引重建', level: 'info' });
              break;
            }
          }
          this._startTask(`向量化资料（${subject}）`, async () => {
            const result = await this.materialManager.reindexAllVectors(subject, (event) => {
              if (event.kind === 'start' || event.kind === 'chunk-batch') {
                this._post({
                  type: 'log',
                  message: `[${event.fileName ?? ''}] ${event.message ?? ''}`,
                  level: 'info',
                });
              } else if (event.kind === 'error') {
                this._post({
                  type: 'log',
                  message: `[${event.fileName ?? ''}] ${event.message ?? '失败'}`,
                  level: 'error',
                });
              }
            });
            this._post({
              type: 'log',
              message: `向量索引完成：成功 ${result.processed} 份，失败 ${result.failed} 份`,
              level: result.ok ? 'info' : 'warn',
            });
            this._post({ type: 'vectorReindexComplete', data: result });
          });
          break;
        }

        case 'reextractMaterialMarker': {
          // 用 marker 重新提取（GPU/CPU 自动）+ 重新解析章节 + 重建向量索引一条龙
          const materialId = String((msg as any).materialId ?? '');
          if (!materialId) break;
          this._startTask(`Marker 重提取 + 重建 · ${materialId}`, async () => {
            const idx = await this.materialManager.getIndex();
            const material = idx.materials.find((m) => m.id === materialId);
            if (!material) {
              this._post({ type: 'log', message: `未找到资料 ${materialId}`, level: 'warn' });
              return;
            }
            this._post({
              type: 'log',
              message: `Marker 提取启动（首次会下载 ~3GB 模型；之后单本约 5-30 分钟）`,
              level: 'info',
            });
            const reextract = await this.materialManager.reextractMaterialWithMarker(materialId, (event) => {
              const headline = event.pages && event.totalPages
                ? `Marker [${event.pages}/${event.totalPages}]`
                : `Marker [${event.stage}]`;
              this._post({
                type: 'log',
                message: `[${material.subject}] ${headline} ${event.message ?? ''}`,
                level: event.stage === 'error' ? 'warn' : 'info',
              });
            });
            if (!reextract.ok) {
              this._post({
                type: 'log',
                message: `Marker 提取失败：${reextract.error ?? '未知'}（提示：pip install marker-pdf；CUDA torch 可加速 5-10x）`,
                level: 'error',
              });
              return;
            }
            this._post({
              type: 'log',
              message: `Marker 提取成功（${reextract.chars} 字符），开始重建向量索引...`,
              level: 'info',
            });
            // 删旧 vector index 强制完全重建（chunks 内容也变了）
            await this.materialManager.removeVectorIndexFor(material);
            const buildResult = await this.materialManager.ensureVectorIndexFor(material, (event) => {
              if (event.kind === 'error') {
                this._post({ type: 'log', message: `[向量化] ${event.fileName}：${event.message ?? ''}`, level: 'warn' });
              }
            });
            this._post({
              type: 'log',
              message: buildResult.ok
                ? `Marker 流水线完成：文本 ${reextract.chars} 字符 + ${buildResult.chunks} 块 + 章节索引`
                : `Marker 流水线最后一步失败：${buildResult.error ?? '未知'}`,
              level: buildResult.ok ? 'info' : 'warn',
            });
            await this._refreshMaterials();
          });
          break;
        }

        case 'reparseMaterialSummary': {
          // 重新解析 summary.json 的章节结构 + **自动级联重建** 向量索引应用新章节
          const materialId = String((msg as any).materialId ?? '');
          if (!materialId) break;
          this._startTask(`重新解析章节 + 重建 · ${materialId}`, async () => {
            const reparseResult = await this.materialManager.reparseMaterialSummary(materialId);
            if (!reparseResult.ok) {
              this._post({
                type: 'log',
                message: `章节重新解析失败：${reparseResult.error ?? '未知'}`,
                level: 'error',
              });
              return;
            }
            this._post({
              type: 'log',
              message: `章节重新解析完成：${reparseResult.chaptersBefore} → ${reparseResult.chaptersAfter} 章，正在自动重建向量索引...`,
              level: 'info',
            });

            // 自动级联重建（用户不用再去找绿徽章点）
            const idx = await this.materialManager.getIndex();
            const material = idx.materials.find((m) => m.id === materialId);
            if (material) {
              const buildResult = await this.materialManager.ensureVectorIndexFor(material, (event) => {
                if (event.kind === 'error') {
                  this._post({ type: 'log', message: `[向量化失败] ${event.fileName}：${event.message ?? ''}`, level: 'warn' });
                }
              });
              this._post({
                type: 'log',
                message: buildResult.ok
                  ? `章节索引已应用：${reparseResult.chaptersAfter} 章 + ${buildResult.chunks} 块 (${buildResult.embedded} 新 / ${buildResult.reused} 复用)`
                  : `重建失败：${buildResult.error ?? '未知'}（请稍后再点徽章重试）`,
                level: buildResult.ok ? 'info' : 'warn',
              });
            }
            await this._refreshMaterials();
          });
          break;
        }

        case 'reindexSingleMaterial': {
          // 单条资料重建 / 升级（用户点击徽章）。
          // 关键修复：**不再先 remove**，让 ensureVectorIndexFor 内部走增量逻辑：
          //   - chunks 走 textHash diff，未变的复用
          //   - 模型变更会被 vectorIndex.diff 自动检测并整体重建
          //   - chapters 单独构建（chunks 已 ready 后调 _buildChapterVectorIndex）
          // 这样万一中途失败（如 embedding API 限流），原索引文件不会被破坏。
          const subject = (msg as any).subject as Subject | undefined;
          const materialId = String((msg as any).materialId ?? '');
          if (!subject || !materialId) break;
          this._startTask(`向量化 · ${materialId}`, async () => {
            const idx = await this.materialManager.getIndex();
            const material = idx.materials.find((m) => m.id === materialId);
            if (!material) {
              this._post({ type: 'log', message: `未找到资料 ${materialId}`, level: 'warn' });
              return;
            }
            const result = await this.materialManager.ensureVectorIndexFor(material, (event) => {
              if (event.kind === 'error') {
                this._post({ type: 'log', message: `[向量化失败] ${event.fileName}：${event.message ?? ''}`, level: 'error' });
              }
            });
            this._post({
              type: 'log',
              message: result.ok
                ? `资料已向量化：${material.fileName}（${result.embedded} 新 / ${result.reused} 复用）`
                : `资料向量化失败：${material.fileName} — ${result.error ?? '未知'}（旧索引保留）`,
              level: result.ok ? 'info' : 'warn',
            });
            await this._refreshMaterials();
          });
          break;
        }

        case 'reindexAllSubjectsAllVectors': {
          // 全学科一键全部重建（升级所有 v1 → v2，建所有缺失索引）
          if ((msg as any).requireConfirm) {
            const choice = await vscode.window.showWarningMessage(
              `将为所有学科的所有资料重建向量索引（升级 v1 → v2）。可能需要数分钟（视资料体量）。是否继续？`,
              { modal: true },
              '继续重建',
            );
            if (choice !== '继续重建') {
              this._post({ type: 'log', message: '已取消全量重建', level: 'info' });
              break;
            }
          }
          this._startTask('全学科向量化', async () => {
            const idx = await this.materialManager.getIndex();
            let succ = 0;
            let fail = 0;
            for (const material of idx.materials) {
              if (material.status !== 'indexed') continue;
              try {
                // 不先 remove，走增量复用：模型/dim 变了 vectorIndex.diff 会自动 force 重建
                const result = await this.materialManager.ensureVectorIndexFor(material, () => {});
                if (result.ok) { succ++; } else { fail++; }
                this._post({
                  type: 'log',
                  message: `[${material.subject}] ${material.fileName} → ${result.ok ? `✓ ${result.embedded} 新 / ${result.reused} 复用` : `✗ ${result.error ?? ''}`}`,
                  level: result.ok ? 'info' : 'warn',
                });
              } catch (err: any) {
                fail++;
                this._post({ type: 'log', message: `[${material.subject}] 异常：${err?.message ?? err}`, level: 'error' });
              }
            }
            this._post({
              type: 'log',
              message: `全学科向量化完成：成功 ${succ} / 失败 ${fail}`,
              level: fail === 0 ? 'info' : 'warn',
            });
            await this._refreshMaterials();
          });
          break;
        }

        case 'getVectorIndexStats': {
          // 返回当前学科所有资料的索引状态
          const subject = (msg as any).subject as Subject | undefined;
          if (!subject) break;
          try {
            const idx = await this.materialManager.getIndex();
            const subjectMaterials = idx.materials.filter((m) => m.subject === subject);
            const stats = await Promise.all(
              subjectMaterials.map(async (m) => ({
                materialId: m.id,
                fileName: m.fileName,
                ...(await this.materialManager.getVectorIndexStats(m)),
              })),
            );
            this._post({ type: 'vectorIndexStats', data: { subject, stats } });
          } catch (err: any) {
            this._post({
              type: 'log',
              message: `读取向量索引状态失败：${err?.message}`,
              level: 'error',
            });
          }
          break;
        }

        // ===== Inline 内联编辑路由 =====

        case 'openLectureViewer': {
          await vscode.commands.executeCommand('claudeCoach.openLectureViewer', {
            filePath: this.courseManager.getLessonPath(msg.subject as Subject, msg.topicId, msg.lessonId),
            subject: msg.subject,
            topicId: msg.topicId,
            topicTitle: msg.topicTitle,
            lessonId: msg.lessonId,
            lessonTitle: msg.lessonTitle,
          });
          break;
        }

        // ===== Coach 消息 =====

        case 'getDailyBrief': {
          // Phase 3 Loop 1 实现具体生成；这里先返回占位让 UI 不空
          this._post({
            type: 'dailyBrief',
            data: {
              dateKey: new Date().toISOString().slice(0, 10),
              subject: msg.subject as Subject | undefined,
              generatedAt: new Date().toISOString(),
              yesterdayRecap: '今日 Coach 模块已就绪。Loop 1 待 Phase 3 实施完整 brief 生成。',
              todaySuggestions: ['完成今日错题复习', '尝试 Inline 编辑功能（Alt+I）', '在设置页配置 Coach 偏好'],
              srDueCount: 0,
            },
          });
          break;
        }

        case 'coachAction': {
          const id = String(msg.suggestionId ?? '');
          if (!id || !this.coachDeps) break;
          await this.coachDeps.suggestionStore.markActed(id);
          break;
        }

        case 'coachDismissSuggestion': {
          const id = String(msg.suggestionId ?? '');
          if (!id || !this.coachDeps) break;
          await this.coachDeps.suggestionStore.markDismissed(id);
          this._post({
            type: 'coachSuggestions',
            data: (await this.coachDeps.suggestionStore.getActive()) as unknown as import('../types').CoachSuggestion[],
          });
          break;
        }

        case 'setDoNotDisturb': {
          if (!this.coachDeps) break;
          const minutes = Number(msg.durationMinutes);
          const until = Number.isFinite(minutes) && minutes > 0
            ? new Date(Date.now() + minutes * 60 * 1000).toISOString()
            : null;
          await this.coachDeps.coachStateStore.setDoNotDisturb(until);
          this._post({ type: 'doNotDisturbState', until });
          this._post({ type: 'log', message: until ? `已勿扰至 ${until}` : '已取消勿扰', level: 'info' });
          break;
        }

        case 'getLearningPlan': {
          if (!this.coachDeps) break;
          const subject = msg.subject as Subject;
          const plan = await this.coachDeps.learningPlanStore.get(subject);
          this._post({ type: 'learningPlan', subject, data: plan as any });
          break;
        }

        case 'setLearningPlan': {
          if (!this.coachDeps) break;
          const planInput = msg.plan as any;
          const subject = planInput.subject as Subject;
          // 简化拆解：按章节数平均分配（Phase 3 Loop 5 改进 AI 拆解）
          const outline = await this.courseManager.getCourseOutline(subject);
          const milestones = (outline?.topics ?? []).map((topic, index) => {
            const targetEnd = new Date(planInput.goal.targetEndDate);
            const startDate = new Date();
            const totalMs = targetEnd.getTime() - startDate.getTime();
            const total = (outline?.topics?.length ?? 1);
            const milestoneTime = startDate.getTime() + (totalMs * (index + 1)) / total;
            return {
              topicId: topic.id,
              topicTitle: topic.title,
              expectedDoneBy: new Date(milestoneTime).toISOString().slice(0, 10),
              status: 'pending' as const,
            };
          });
          const plan = {
            schemaVersion: 1,
            subject,
            goal: {
              targetEndDate: planInput.goal.targetEndDate,
              dailyMinutes: planInput.goal.dailyMinutes,
              extraNotes: planInput.goal.extraNotes,
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            milestones,
            driftThresholdDays: planInput.driftThresholdDays ?? 2,
            lastDriftCheckAt: null,
          };
          await this.coachDeps.learningPlanStore.save(plan as any);
          this._post({ type: 'learningPlan', subject, data: plan as any });
          this._post({ type: 'log', message: `已保存学习计划，共 ${milestones.length} 个里程碑`, level: 'info' });
          break;
        }

        case 'metacogAnswer': {
          // 简化版：仅记录到 courseProfileStore 作为 reflection 事件
          const subject = msg.subject as Subject;
          if (!subject) break;
          await this.courseProfileStore.recordEvent(subject, {
            id: `metacog-${Date.now()}`,
            type: 'answer-revision',
            subject,
            topicId: msg.topicId ?? null,
            lessonId: msg.lessonId ?? null,
            createdAt: new Date().toISOString(),
            summary: `Metacog Q: ${msg.question} | A: ${String(msg.answer ?? '').slice(0, 200)}`,
            weaknessTags: [],
            strengthTags: [],
            rawRefs: [],
          });
          this._post({ type: 'log', message: '元认知反思已记录', level: 'info' });
          break;
        }

        case 'getCoachSuggestions': {
          if (!this.coachDeps) {
            this._post({ type: 'coachSuggestions', data: [] });
            break;
          }
          this._post({
            type: 'coachSuggestions',
            data: (await this.coachDeps.suggestionStore.getActive()) as unknown as import('../types').CoachSuggestion[],
          });
          break;
        }

        case 'getActivityLog': {
          if (!this.coachDeps) {
            this._post({ type: 'activityLog', data: [] });
            break;
          }
          this._post({
            type: 'activityLog',
            data: (await this.coachDeps.sessionLogger.recentActivity(50)) as any,
          });
          break;
        }

        // ===================================================================
        // 备考模式（Exam Prep）13 个 case
        // ===================================================================

        case 'createExamSession': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const session = await this.examDeps.examPrepStore.createSession({
            subject: msg.subject,
            name: String(msg.name ?? '未命名备考'),
            examDate: msg.examDate ? String(msg.examDate) : undefined,
            sourcePaperIds: Array.isArray(msg.sourcePaperIds) ? msg.sourcePaperIds.map(String) : [],
          });
          this._post({ type: 'examSession', data: session });
          this._post({ type: 'log', message: `已创建备考会话：${session.name}`, level: 'info' });
          break;
        }

        case 'listExamSessions': {
          if (!this.examDeps) {
            this._post({ type: 'examSessionsList', subject: msg.subject, data: [] });
            break;
          }
          const sessions = await this.examDeps.examPrepStore.listSessions(msg.subject);
          this._post({ type: 'examSessionsList', subject: msg.subject, data: sessions });
          break;
        }

        case 'getExamSession': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const session = await this.examDeps.examPrepStore.getSession(String(msg.sessionId));
          if (session) {
            this._post({ type: 'examSession', data: session });
          } else {
            this._post({ type: 'error', message: `备考会话不存在：${msg.sessionId}` });
          }
          break;
        }

        case 'archiveExamSession': {
          if (!this.examDeps) break;
          await this.examDeps.examPrepStore.archiveSession(String(msg.sessionId));
          this._post({ type: 'log', message: `已归档备考会话 ${msg.sessionId}`, level: 'info' });
          // 推一份最新列表
          const list = await this.examDeps.examPrepStore.listSessions();
          this._post({ type: 'examSessionsList', data: list });
          break;
        }

        case 'analyzeExamPaper': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const sessionId = String(msg.sessionId);
          const paperId = String(msg.paperId);
          const examDeps = this.examDeps;
          this._startTask(`分析真题 ${paperId}`, async () => {
            const session = await examDeps.examPrepStore.getSession(sessionId);
            if (!session) throw new Error(`备考会话不存在：${sessionId}`);
            const promptCtx = await this._buildExamPromptContext(session.subject);
            const analysis = await examDeps.examAnalyzer.analyzePaper(paperId, promptCtx);
            await examDeps.examPrepStore.addPaperAnalysis(sessionId, analysis);
            this._post({ type: 'examPaperAnalyzed', sessionId, analysis });
          });
          break;
        }

        case 'generateExamVariants': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const sessionId = String(msg.sessionId);
          const count = Number.isFinite(Number(msg.count)) ? Math.max(1, Math.min(20, Number(msg.count))) : 5;
          const focusMode = (msg.focusMode === 'cover-all' || msg.focusMode === 'mock-full')
            ? msg.focusMode
            : 'reinforce-weakness';
          const examDeps = this.examDeps;
          this._startTask(`生成 ${count} 道变体`, async () => {
            const session = await examDeps.examPrepStore.getSession(sessionId);
            if (!session) throw new Error(`备考会话不存在：${sessionId}`);
            const wrongs = await this.courseManager.listWrongQuestions(session.subject, {
              onlyUnresolved: true,
              limit: 30,
            });
            const weakKnowledgePoints = Array.from(new Set(wrongs.flatMap((w) => w.weaknesses).filter(Boolean)));
            const promptCtx = await this._buildExamPromptContext(session.subject);
            const set = await examDeps.examVariantGenerator.generate({
              session,
              paperAnalyses: session.paperAnalyses,
              weakKnowledgePoints,
              count,
              focusMode,
              promptCtx,
            });
            await examDeps.examPrepStore.addVariantSet(sessionId, set);
            this._post({ type: 'examVariantsGenerated', sessionId, variantSet: set });
          });
          break;
        }

        case 'exportExamVariantsPdf': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          await vscode.commands.executeCommand('claudeCoach.openExamVariantsPreview', {
            sessionId: String(msg.sessionId),
            variantSetId: String(msg.variantSetId),
          });
          break;
        }

        case 'uploadExamSubmissionImages': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const sessionId = String(msg.sessionId);
          const variantSetId = msg.variantSetId ? String(msg.variantSetId) : undefined;
          const session = await this.examDeps.examPrepStore.getSession(sessionId);
          if (!session) {
            this._post({ type: 'error', message: `备考会话不存在：${sessionId}` });
            break;
          }
          const incoming: Array<{ name: string; mimeType: string; base64: string }> = Array.isArray(msg.images) ? msg.images : [];
          if (incoming.length === 0) {
            this._post({ type: 'error', message: '没有要上传的图片。' });
            break;
          }
          const submissionId = `sub-${Date.now()}`;
          const imagePaths: string[] = [];
          for (const [i, img] of incoming.entries()) {
            const safeName = img.name && /\.(png|jpe?g|webp)$/i.test(img.name)
              ? `${i + 1}-${img.name}`
              : `${i + 1}.png`;
            const fullPath = await this.examDeps.examPrepStore.saveSubmissionImage(sessionId, submissionId, {
              name: safeName,
              mimeType: img.mimeType ?? 'image/png',
              base64: img.base64 ?? '',
            });
            imagePaths.push(fullPath);
          }
          const submission: ExamSubmission = {
            id: submissionId,
            sessionId,
            variantSetId,
            uploadedAt: new Date().toISOString(),
            imagePaths,
          };
          await this.examDeps.examPrepStore.addSubmission(sessionId, submission);
          this._post({ type: 'examSubmissionUploaded', sessionId, submission });
          break;
        }

        case 'gradeExamSubmission': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const sessionId = String(msg.sessionId);
          const submissionId = String(msg.submissionId);
          const examDeps = this.examDeps;
          this._startTask('AI 视觉批改', async () => {
            try {
              const session = await examDeps.examPrepStore.getSession(sessionId);
              const sub = session?.submissions.find((s) => s.id === submissionId);
              if (!session || !sub) throw new Error(`提交不存在：${submissionId}`);

              const variantSet = sub.variantSetId
                ? await examDeps.examPrepStore.getVariantSet(sessionId, sub.variantSetId)
                : null;
              const promptCtx = await this._buildExamPromptContext(session.subject);

              // 读图片为 base64
              const fsMod = await import('fs/promises');
              const images = await Promise.all(sub.imagePaths.map(async (p) => {
                const data = await fsMod.readFile(p);
                const lower = p.toLowerCase();
                const mimeType = lower.endsWith('.jpg') || lower.endsWith('.jpeg')
                  ? 'image/jpeg'
                  : lower.endsWith('.webp')
                    ? 'image/webp'
                    : 'image/png';
                return { filePath: p, base64: data.toString('base64'), mimeType };
              }));

              const grading = await examDeps.examGrader.gradeWithImages({
                images,
                variantSet,
                paperAnalyses: session.paperAnalyses,
                promptCtx,
              });
              await examDeps.examPrepStore.updateSubmissionGrading(sessionId, submissionId, grading);

              // 错题归档
              await this._archiveExamWrongQuestions(session, variantSet, grading);

              // 自动重算就绪度
              if (this.coachDeps) {
                const { ExamReadinessCalculator } = await import('../exam/examReadinessCalculator');
                const calc = new ExamReadinessCalculator(
                  this.courseManager,
                  this.courseProfileStore,
                  this.coachDeps.learningPlanStore,
                  this.aiClient,
                );
                const refreshed = await examDeps.examPrepStore.getSession(sessionId);
                if (refreshed) {
                  const snapshot = await calc.compute(refreshed, promptCtx);
                  await examDeps.examPrepStore.updateReadiness(sessionId, snapshot);
                  this._post({ type: 'examReadinessUpdated', sessionId, snapshot });
                }
              }

              const updatedSession = await examDeps.examPrepStore.getSession(sessionId);
              const updatedSub = updatedSession?.submissions.find((s) => s.id === submissionId);
              if (updatedSub) {
                this._post({ type: 'examSubmissionGraded', sessionId, submission: updatedSub });
              }
            } catch (err: any) {
              if (err?.name === 'VisionUnsupportedError') {
                this._post({
                  type: 'examVisionUnsupported',
                  modelName: err.modelName,
                  suggestedModels: err.suggestedModels ?? [],
                });
                return;
              }
              throw err;
            }
          });
          break;
        }

        case 'submitExamTextAnswers': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          const sessionId = String(msg.sessionId);
          const variantSetId = msg.variantSetId ? String(msg.variantSetId) : undefined;
          const answers: Array<{ questionNumber: string; answer: string }> = Array.isArray(msg.answers) ? msg.answers : [];
          const examDeps = this.examDeps;
          this._startTask('文字答案批改', async () => {
            const session = await examDeps.examPrepStore.getSession(sessionId);
            if (!session) throw new Error(`备考会话不存在：${sessionId}`);
            const variantSet = variantSetId
              ? await examDeps.examPrepStore.getVariantSet(sessionId, variantSetId)
              : null;
            const promptCtx = await this._buildExamPromptContext(session.subject);

            const grading = await examDeps.examGrader.gradeWithText({
              answers,
              variantSet,
              paperAnalyses: session.paperAnalyses,
              promptCtx,
            });

            const submissionId = `sub-${Date.now()}`;
            const submission: ExamSubmission = {
              id: submissionId,
              sessionId,
              variantSetId,
              uploadedAt: new Date().toISOString(),
              imagePaths: [],
              textAnswers: answers,
              gradingResult: grading,
            };
            await examDeps.examPrepStore.addSubmission(sessionId, submission);
            await this._archiveExamWrongQuestions(session, variantSet, grading);

            // 自动重算就绪度
            if (this.coachDeps) {
              const { ExamReadinessCalculator } = await import('../exam/examReadinessCalculator');
              const calc = new ExamReadinessCalculator(
                this.courseManager,
                this.courseProfileStore,
                this.coachDeps.learningPlanStore,
                this.aiClient,
              );
              const refreshed = await examDeps.examPrepStore.getSession(sessionId);
              if (refreshed) {
                const snapshot = await calc.compute(refreshed, promptCtx);
                await examDeps.examPrepStore.updateReadiness(sessionId, snapshot);
                this._post({ type: 'examReadinessUpdated', sessionId, snapshot });
              }
            }

            this._post({ type: 'examSubmissionUploaded', sessionId, submission });
            this._post({ type: 'examSubmissionGraded', sessionId, submission });
          });
          break;
        }

        case 'recomputeExamReadiness': {
          if (!this.examDeps) {
            this._post({ type: 'error', message: '备考模块未初始化。' });
            break;
          }
          if (!this.coachDeps) {
            this._post({ type: 'error', message: 'Coach 模块未初始化，无法计算就绪度。' });
            break;
          }
          const sessionId = String(msg.sessionId);
          const examDeps = this.examDeps;
          const coachDeps = this.coachDeps;
          this._startTask('计算备考就绪度', async () => {
            const session = await examDeps.examPrepStore.getSession(sessionId);
            if (!session) throw new Error(`备考会话不存在：${sessionId}`);
            const promptCtx = await this._buildExamPromptContext(session.subject);
            const { ExamReadinessCalculator } = await import('../exam/examReadinessCalculator');
            const calc = new ExamReadinessCalculator(
              this.courseManager,
              this.courseProfileStore,
              coachDeps.learningPlanStore,
              this.aiClient,
            );
            const snapshot = await calc.compute(session, promptCtx);
            await examDeps.examPrepStore.updateReadiness(sessionId, snapshot);
            this._post({ type: 'examReadinessUpdated', sessionId, snapshot });
          });
          break;
        }

        case 'openExamWorkbench': {
          await vscode.commands.executeCommand('claudeCoach.openExamWorkbench', {
            sessionId: String(msg.sessionId),
          });
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

        case 'setMaterialType': {
          const materialId = String(msg.materialId ?? '');
          const materialType = msg.materialType as import('../types').MaterialType;
          if (!materialId || !materialType) break;
          const ok = await this.materialManager.setMaterialType(materialId, materialType);
          if (ok) {
            this._post({ type: 'log', message: `已更新资料类型`, level: 'info' });
            await this._refreshMaterials();
          }
          break;
        }

        case 'deleteMaterial': {
          await this.materialManager.deleteMaterial(msg.materialId);
          const suffix = msg.fileName ? `：${msg.fileName}` : '';
          this._post({ type: 'log', message: `资料已删除${suffix}`, level: 'info' });
          const updatedIndex = await this.materialManager.getIndex();
          const updatedStats = await this._collectVectorStats(updatedIndex);
          this._post({ type: 'materials', data: updatedIndex, vectorStats: updatedStats });
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
          const updatedStats = await this._collectVectorStats(updatedIndex);
          this._post({ type: 'materials', data: updatedIndex, vectorStats: updatedStats });
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

          const turnId = String(msg.turnId ?? `turn-${Date.now()}`);
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
            this._view?.webview.postMessage({ type: 'chatResponse', content: reply, turnId });
            if (grounding.sources && grounding.sources.length > 0) {
              this._view?.webview.postMessage({
                type: 'groundingSources',
                turnId,
                sources: grounding.sources,
              });
            }
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
    const hljsScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js')
    );
    const hljsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css')
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
      html = html.replace('{{hljsScriptUri}}', hljsScriptUri.toString());
      html = html.replace('{{hljsStyleUri}}', hljsStyleUri.toString());
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
