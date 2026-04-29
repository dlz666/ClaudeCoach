import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';

import { AIClient } from '../ai/client';
import { PreferencesStore } from '../progress/preferencesStore';
import { ProgressStore } from '../progress/progressStore';
import { AdaptiveEngine } from '../progress/adaptiveEngine';
import { CourseProfileStore } from '../progress/courseProfileStore';
import { CourseManager } from '../courses/courseManager';
import { MaterialManager } from '../materials/materialManager';
import { ExamPrepStore } from '../exam/examPrepStore';
import type {
  ExamPrepSession,
  ExamPaperAnalysis,
  ExamVariantSet,
  ExamSubmission,
  ExamReadinessSnapshot,
} from '../types';

interface WorkbenchPanelArgs {
  sessionId: string;
}

interface VariantsPdfPanelArgs {
  sessionId: string;
  variantSetId: string;
}

interface PanelContext {
  panel: vscode.WebviewPanel;
  kind: 'workbench' | 'variants-pdf';
  sessionId: string;
  variantSetId?: string;
}

/**
 * 备考工作台 + 变体题 PDF 预览的 webview provider。
 *
 * 架构说明：
 * 这个 provider 只做 panel 生命周期 + HTML 渲染 + 消息路由。所有真正的"业务逻辑"
 * （生成变体、批改截图、计算就绪度等）由 deps 中的 store / analyzer / grader 等
 * 模块完成。本文件意图保持薄、可测试、与后端解耦。
 *
 * 当前后端模块还没全部就绪（另一个 subagent 在做），所以 deps 接口里有些字段是
 * 可选 / loose-typed 的（用 any 占位）。后端到位后把 any 收紧成强类型即可，
 * 不影响本文件的 panel / 消息路由逻辑。
 */
export interface ExamWebviewDeps {
  ai: AIClient;
  preferencesStore: PreferencesStore;
  progressStore: ProgressStore;
  adaptiveEngine: AdaptiveEngine;
  courseProfileStore: CourseProfileStore;
  courseManager: CourseManager;
  materialManager: MaterialManager;
  examPrepStore: ExamPrepStore;
  /** 后端：试卷分析 / 变体生成 / 批改 / 就绪度，由另一个 subagent 提供。 */
  examAnalyzer?: any;
  examVariantGenerator?: any;
  examGrader?: any;
  examReadinessCalculator?: any;
}

const VIEW_TYPE_WORKBENCH = 'claudeCoach.examWorkbench';
const VIEW_TYPE_VARIANTS_PDF = 'claudeCoach.examVariantsPreview';

export class ExamWebviewProvider {
  /** key 形如 'workbench:<sessionId>' 或 'variants:<sessionId>:<variantSetId>'。 */
  private readonly panels = new Map<string, PanelContext>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ExamWebviewDeps,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    deps: ExamWebviewDeps,
  ): ExamWebviewProvider {
    const provider = new ExamWebviewProvider(extensionUri, deps);
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'claudeCoach.openExamWorkbench',
        async (args: WorkbenchPanelArgs) => {
          if (!args || typeof args.sessionId !== 'string') {
            vscode.window.showErrorMessage('ClaudeCoach: 缺少备考会话 ID。');
            return;
          }
          await provider.openWorkbench(args);
        },
      ),
      vscode.commands.registerCommand(
        'claudeCoach.openExamVariantsPreview',
        async (args: VariantsPdfPanelArgs) => {
          if (!args || typeof args.sessionId !== 'string' || typeof args.variantSetId !== 'string') {
            vscode.window.showErrorMessage('ClaudeCoach: 缺少变体题集 ID。');
            return;
          }
          await provider.openVariantsPreview(args);
        },
      ),
      provider,
    );
    return provider;
  }

  // =====================================================================
  // 备考工作台 panel
  // =====================================================================

  async openWorkbench(args: WorkbenchPanelArgs): Promise<void> {
    const key = `workbench:${args.sessionId}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      // 重新拉一份最新 session 推过去
      void this.pushSessionToPanel(existing).catch((err) => {
        console.warn('[ExamWebview] reload session failed:', err);
      });
      return;
    }

    let session: ExamPrepSession | null = null;
    try {
      session = await this.deps.examPrepStore.getSession(args.sessionId);
    } catch (err) {
      console.warn('[ExamWebview] load session failed:', err);
    }

    if (!session) {
      vscode.window.showErrorMessage(`ClaudeCoach: 找不到备考会话 ${args.sessionId}`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE_WORKBENCH,
      `🎯 备考：${session.name || args.sessionId}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'exam-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'out', 'sidebar', 'exam-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules'),
        ],
      },
    );
    panel.webview.html = this.buildWorkbenchHtml(panel.webview);

    const ctx: PanelContext = {
      panel,
      kind: 'workbench',
      sessionId: args.sessionId,
    };
    this.panels.set(key, ctx);

    panel.webview.onDidReceiveMessage((msg) => {
      void this.handleWorkbenchMessage(ctx, msg).catch((err) => {
        console.error('[ExamWebview] workbench message handler failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        try {
          ctx.panel.webview.postMessage({ type: 'error', message });
        } catch {
          /* noop */
        }
      });
    });

    panel.onDidDispose(() => {
      this.panels.delete(key);
    });

    // 推一份初始 session 数据
    panel.webview.postMessage({ type: 'init', sessionId: args.sessionId });
    panel.webview.postMessage({ type: 'examSession', data: session });
  }

  // =====================================================================
  // 变体题 PDF 预览 panel
  // =====================================================================

  async openVariantsPreview(args: VariantsPdfPanelArgs): Promise<void> {
    const key = `variants:${args.sessionId}:${args.variantSetId}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      void this.pushVariantSetToPanel(existing).catch((err) => {
        console.warn('[ExamWebview] reload variant set failed:', err);
      });
      return;
    }

    let session: ExamPrepSession | null = null;
    let variantSet: ExamVariantSet | null = null;
    try {
      session = await this.deps.examPrepStore.getSession(args.sessionId);
      variantSet = await this.deps.examPrepStore.getVariantSet(args.sessionId, args.variantSetId);
    } catch (err) {
      console.warn('[ExamWebview] load variant set failed:', err);
    }
    if (!variantSet) {
      vscode.window.showErrorMessage(`ClaudeCoach: 找不到变体题集 ${args.variantSetId}`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE_VARIANTS_PDF,
      `📄 变体题：${session?.name || args.sessionId}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'exam-pdf-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'out', 'sidebar', 'exam-pdf-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules'),
        ],
      },
    );
    panel.webview.html = this.buildVariantsPdfHtml(panel.webview);

    const ctx: PanelContext = {
      panel,
      kind: 'variants-pdf',
      sessionId: args.sessionId,
      variantSetId: args.variantSetId,
    };
    this.panels.set(key, ctx);

    panel.webview.onDidReceiveMessage(() => {
      // 预览面板消息很少；后续若需要可加 print 后的回执处理
    });

    panel.onDidDispose(() => {
      this.panels.delete(key);
    });

    panel.webview.postMessage({
      type: 'init',
      sessionId: args.sessionId,
      variantSetId: args.variantSetId,
      sessionName: session?.name || '',
      variantSet,
    });
  }

  dispose(): void {
    for (const ctx of this.panels.values()) {
      try {
        ctx.panel.dispose();
      } catch {
        /* noop */
      }
    }
    this.panels.clear();
  }

  // =====================================================================
  // 消息处理 — workbench
  // =====================================================================

  private async handleWorkbenchMessage(ctx: PanelContext, msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'getExamSession':
        await this.pushSessionToPanel(ctx);
        return;

      case 'analyzeExamPaper':
        await this.handleAnalyzeExamPaper(ctx, msg);
        return;

      case 'generateExamVariants':
        await this.handleGenerateExamVariants(ctx, msg);
        return;

      case 'exportExamVariantsPdf': {
        // 直接打开预览面板
        const sessionId = String(msg.sessionId || ctx.sessionId);
        const variantSetId = String(msg.variantSetId || '');
        if (!variantSetId) return;
        await this.openVariantsPreview({ sessionId, variantSetId });
        return;
      }

      case 'uploadExamSubmissionImages':
        await this.handleUploadSubmission(ctx, msg);
        return;

      case 'gradeExamSubmission':
        await this.handleGradeSubmission(ctx, msg);
        return;

      case 'submitExamTextAnswers':
        await this.handleSubmitTextAnswers(ctx, msg);
        return;

      case 'recomputeExamReadiness':
        await this.handleRecomputeReadiness(ctx, msg);
        return;

      case 'getCourseExamPapers':
        await this.handleGetCourseExamPapers(ctx);
        return;

      default:
        // 静默忽略未知消息类型；调试需要再加 console.warn
        return;
    }
  }

  private async pushSessionToPanel(ctx: PanelContext): Promise<void> {
    const session = await this.deps.examPrepStore.getSession(ctx.sessionId);
    if (!session) return;
    ctx.panel.webview.postMessage({ type: 'examSession', data: session });
  }

  private async pushVariantSetToPanel(ctx: PanelContext): Promise<void> {
    if (!ctx.variantSetId) return;
    const session = await this.deps.examPrepStore.getSession(ctx.sessionId);
    const variantSet = await this.deps.examPrepStore.getVariantSet(ctx.sessionId, ctx.variantSetId);
    if (!variantSet) return;
    ctx.panel.webview.postMessage({
      type: 'init',
      sessionId: ctx.sessionId,
      variantSetId: ctx.variantSetId,
      sessionName: session?.name || '',
      variantSet,
    });
  }

  private async handleGetCourseExamPapers(ctx: PanelContext): Promise<void> {
    const session = await this.deps.examPrepStore.getSession(ctx.sessionId);
    if (!session) return;
    let materials: any[] = [];
    try {
      const idx = await this.deps.materialManager.getIndex();
      materials = (idx?.materials || []).filter((m: any) => m.subject === session.subject);
    } catch (err) {
      console.warn('[ExamWebview] load materials failed:', err);
    }
    // 偏好真题/模拟卷类型，但也允许其他类型作为兜底
    const examPapers = materials.filter((m: any) => m.materialType === 'exam-paper');
    const others = materials.filter((m: any) => m.materialType !== 'exam-paper');
    ctx.panel.webview.postMessage({
      type: 'courseExamPapers',
      data: { examPapers, others },
    });
  }

  private async handleAnalyzeExamPaper(ctx: PanelContext, msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || ctx.sessionId);
    const paperId = String(msg.paperId || '');
    if (!paperId) {
      ctx.panel.webview.postMessage({ type: 'error', message: '缺少 paperId' });
      return;
    }

    ctx.panel.webview.postMessage({ type: 'loading', active: true, task: '分析真题中…' });
    try {
      let analysis: ExamPaperAnalysis | null = null;
      const analyzer = this.deps.examAnalyzer;
      if (analyzer && typeof analyzer.analyze === 'function') {
        analysis = await analyzer.analyze({ sessionId, paperId });
      }

      if (!analysis) {
        // 后端尚未就绪：先把 paperId 关联进 session 让 UI 可以渲染占位
        const session = await this.deps.examPrepStore.getSession(sessionId);
        if (session && !session.sourcePaperIds.includes(paperId)) {
          session.sourcePaperIds.push(paperId);
          session.updatedAt = new Date().toISOString();
          await this.deps.examPrepStore.saveSession(session);
        }
        ctx.panel.webview.postMessage({
          type: 'log',
          level: 'warn',
          message: '试卷分析后端尚未接入；已把真题关联到本会话。',
        });
        await this.pushSessionToPanel(ctx);
        return;
      }

      await this.deps.examPrepStore.addPaperAnalysis(sessionId, analysis);
      ctx.panel.webview.postMessage({ type: 'examPaperAnalyzed', sessionId, analysis });
      await this.pushSessionToPanel(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.panel.webview.postMessage({ type: 'error', message: `试卷分析失败：${message}` });
    } finally {
      ctx.panel.webview.postMessage({ type: 'loading', active: false });
    }
  }

  private async handleGenerateExamVariants(ctx: PanelContext, msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || ctx.sessionId);
    const count = Math.max(1, Math.min(50, Number(msg.count) || 5));
    const focusMode: 'cover-all' | 'reinforce-weakness' | 'mock-full' =
      msg.focusMode === 'cover-all' || msg.focusMode === 'mock-full'
        ? msg.focusMode
        : 'reinforce-weakness';

    ctx.panel.webview.postMessage({ type: 'loading', active: true, task: '生成变体题中…' });
    try {
      let variantSet: ExamVariantSet | null = null;
      const generator = this.deps.examVariantGenerator;
      if (generator && typeof generator.generate === 'function') {
        variantSet = await generator.generate({ sessionId, count, focusMode });
      }

      if (!variantSet) {
        ctx.panel.webview.postMessage({
          type: 'log',
          level: 'warn',
          message: '变体出题后端尚未接入。',
        });
        return;
      }

      await this.deps.examPrepStore.addVariantSet(sessionId, variantSet);
      ctx.panel.webview.postMessage({ type: 'examVariantsGenerated', sessionId, variantSet });
      await this.pushSessionToPanel(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.panel.webview.postMessage({ type: 'error', message: `生成变体题失败：${message}` });
    } finally {
      ctx.panel.webview.postMessage({ type: 'loading', active: false });
    }
  }

  private async handleUploadSubmission(ctx: PanelContext, msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || ctx.sessionId);
    const variantSetId = msg.variantSetId ? String(msg.variantSetId) : undefined;
    const images = Array.isArray(msg.images) ? msg.images : [];
    if (!images.length) {
      ctx.panel.webview.postMessage({ type: 'error', message: '没有要上传的图片。' });
      return;
    }

    ctx.panel.webview.postMessage({ type: 'loading', active: true, task: '上传截图中…' });
    try {
      const submissionId = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const imagePaths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img || typeof img.base64 !== 'string') continue;
        const ext = guessExtension(img.mimeType, img.name);
        const fileName = `${String(i + 1).padStart(2, '0')}${ext}`;
        const fullPath = await this.deps.examPrepStore.saveSubmissionImage(
          sessionId,
          submissionId,
          { name: fileName, mimeType: img.mimeType, base64: img.base64 },
        );
        imagePaths.push(fullPath);
      }

      const submission: ExamSubmission = {
        id: submissionId,
        sessionId,
        variantSetId,
        uploadedAt: new Date().toISOString(),
        imagePaths,
      };
      await this.deps.examPrepStore.addSubmission(sessionId, submission);
      ctx.panel.webview.postMessage({ type: 'examSubmissionUploaded', sessionId, submission });
      await this.pushSessionToPanel(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.panel.webview.postMessage({ type: 'error', message: `上传失败：${message}` });
    } finally {
      ctx.panel.webview.postMessage({ type: 'loading', active: false });
    }
  }

  private async handleGradeSubmission(ctx: PanelContext, msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || ctx.sessionId);
    const submissionId = String(msg.submissionId || '');
    if (!submissionId) {
      ctx.panel.webview.postMessage({ type: 'error', message: '缺少 submissionId' });
      return;
    }

    ctx.panel.webview.postMessage({ type: 'loading', active: true, task: 'AI 批改中…' });
    try {
      const grader = this.deps.examGrader;
      if (!grader || typeof grader.gradeSubmission !== 'function') {
        ctx.panel.webview.postMessage({
          type: 'log',
          level: 'warn',
          message: '批改后端尚未接入。',
        });
        return;
      }

      let result: { submission: ExamSubmission; visionUnsupported?: boolean; modelName?: string; suggestedModels?: string[] } | null = null;
      try {
        result = await grader.gradeSubmission({ sessionId, submissionId });
      } catch (err: any) {
        // grader 应当在 vision 不可用时抛 VisionUnsupportedError，这里 fallback 检查
        if (err && (err.code === 'VISION_UNSUPPORTED' || err.name === 'VisionUnsupportedError')) {
          ctx.panel.webview.postMessage({
            type: 'examVisionUnsupported',
            modelName: err.modelName,
            suggestedModels: err.suggestedModels || ['gpt-4o', 'claude-3-5-sonnet-20240620'],
          });
          return;
        }
        throw err;
      }

      if (!result) return;
      if (result.visionUnsupported) {
        ctx.panel.webview.postMessage({
          type: 'examVisionUnsupported',
          modelName: result.modelName,
          suggestedModels: result.suggestedModels || ['gpt-4o', 'claude-3-5-sonnet-20240620'],
        });
        return;
      }

      ctx.panel.webview.postMessage({
        type: 'examSubmissionGraded',
        sessionId,
        submission: result.submission,
      });

      // 批改完成后自动重算就绪度
      await this.handleRecomputeReadiness(ctx, { sessionId });
      await this.pushSessionToPanel(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.panel.webview.postMessage({ type: 'error', message: `批改失败：${message}` });
    } finally {
      ctx.panel.webview.postMessage({ type: 'loading', active: false });
    }
  }

  private async handleSubmitTextAnswers(ctx: PanelContext, msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || ctx.sessionId);
    const variantSetId = msg.variantSetId ? String(msg.variantSetId) : undefined;
    const answers = Array.isArray(msg.answers) ? msg.answers : [];
    if (!answers.length) {
      ctx.panel.webview.postMessage({ type: 'error', message: '请至少填写一题答案。' });
      return;
    }

    ctx.panel.webview.postMessage({ type: 'loading', active: true, task: 'AI 批改（文字模式）中…' });
    try {
      const submissionId = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const submission: ExamSubmission = {
        id: submissionId,
        sessionId,
        variantSetId,
        uploadedAt: new Date().toISOString(),
        imagePaths: [],
        textAnswers: answers,
      };
      await this.deps.examPrepStore.addSubmission(sessionId, submission);
      ctx.panel.webview.postMessage({ type: 'examSubmissionUploaded', sessionId, submission });

      const grader = this.deps.examGrader;
      if (grader && typeof grader.gradeSubmission === 'function') {
        const result = await grader.gradeSubmission({ sessionId, submissionId, mode: 'text-fallback' });
        if (result?.submission) {
          ctx.panel.webview.postMessage({
            type: 'examSubmissionGraded',
            sessionId,
            submission: result.submission,
          });
          await this.handleRecomputeReadiness(ctx, { sessionId });
        }
      }
      await this.pushSessionToPanel(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.panel.webview.postMessage({ type: 'error', message: `提交失败：${message}` });
    } finally {
      ctx.panel.webview.postMessage({ type: 'loading', active: false });
    }
  }

  private async handleRecomputeReadiness(ctx: PanelContext, msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || ctx.sessionId);
    try {
      const calculator = this.deps.examReadinessCalculator;
      if (!calculator || typeof calculator.compute !== 'function') {
        ctx.panel.webview.postMessage({
          type: 'log',
          level: 'warn',
          message: '就绪度计算后端尚未接入。',
        });
        return;
      }
      // ExamReadinessCalculator.compute 签名是 (session, promptCtx)
      const session = await this.deps.examPrepStore.getSession(sessionId);
      if (!session) {
        ctx.panel.webview.postMessage({
          type: 'log',
          level: 'warn',
          message: `备考会话 ${sessionId} 不存在。`,
        });
        return;
      }
      // promptCtx 用最小可用版（学生画像 + 偏好；学科 tag 已通过其他路径走）
      let promptCtx: any = { scope: 'diagnosis' };
      try {
        if (this.deps.preferencesStore) {
          promptCtx.preferences = await this.deps.preferencesStore.get();
        }
        if (this.deps.progressStore) {
          promptCtx.profile = await this.deps.progressStore.getProfile();
        }
        if (this.deps.courseProfileStore) {
          const cpc = await this.deps.courseProfileStore.buildPromptContext(session.subject);
          promptCtx = { ...promptCtx, ...cpc };
        }
      } catch (err) {
        console.warn('[ExamWebview] buildPromptContext for readiness failed:', err);
      }
      const snapshot: ExamReadinessSnapshot | null = await calculator.compute(session, promptCtx);
      if (!snapshot) return;
      await this.deps.examPrepStore.updateReadiness(sessionId, snapshot);
      ctx.panel.webview.postMessage({ type: 'examReadinessUpdated', sessionId, snapshot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.panel.webview.postMessage({ type: 'error', message: `就绪度计算失败：${message}` });
    }
  }

  // =====================================================================
  // HTML / CSP
  // =====================================================================

  private buildWorkbenchHtml(webview: vscode.Webview): string {
    return this.renderHtmlTemplate(webview, 'exam-webview');
  }

  private buildVariantsPdfHtml(webview: vscode.Webview): string {
    return this.renderHtmlTemplate(webview, 'exam-pdf-webview');
  }

  private renderHtmlTemplate(webview: vscode.Webview, folder: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', folder, 'style.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', folder, 'main.js'),
    );
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js'),
    );
    const katexStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css'),
    );
    const katexScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.js'),
    );
    const katexAutoRenderUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'contrib', 'auto-render.min.js'),
    );
    const hljsScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js'),
    );
    const hljsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join('; ');

    const htmlPath = path.join(
      this.extensionUri.fsPath,
      'src',
      'sidebar',
      folder,
      'index.html',
    );

    let html: string;
    try {
      const fsSync = require('fs') as typeof import('fs');
      html = fsSync.readFileSync(htmlPath, 'utf8');
    } catch (err) {
      console.error(`[ExamWebview] failed to read ${folder}/index.html:`, err);
      return `<!DOCTYPE html><html><body><pre>备考 webview 加载失败：缺少 ${folder}/index.html</pre></body></html>`;
    }

    return html
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString())
      .replace(/{{markdownItUri}}/g, markdownItUri.toString())
      .replace(/{{katexStyleUri}}/g, katexStyleUri.toString())
      .replace(/{{katexScriptUri}}/g, katexScriptUri.toString())
      .replace(/{{katexAutoRenderUri}}/g, katexAutoRenderUri.toString())
      .replace(/{{hljsScriptUri}}/g, hljsScriptUri.toString())
      .replace(/{{hljsStyleUri}}/g, hljsStyleUri.toString());
  }
}

function guessExtension(mimeType?: string, fileName?: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (typeof fileName === 'string') {
    const ext = path.extname(fileName).toLowerCase();
    if (ext) return ext;
  }
  return '.png';
}

// 让 fs 引用不被 tree-shake 警告（部分场景需要）
void fs;
