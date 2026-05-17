import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { AIClient } from '../ai/client';
import {
  inlineInsertPrompt,
  inlineRewritePrompt,
  reviseMarkdownPrompt,
} from '../ai/prompts';
import {
  applyInlineWriteback,
  isLecturePath,
  type WritebackInput,
  type WritebackResult,
} from './inlineWriteback';

import { PreferencesStore } from '../progress/preferencesStore';
import { ProgressStore } from '../progress/progressStore';
import { AdaptiveEngine } from '../progress/adaptiveEngine';
import { CourseProfileStore } from '../progress/courseProfileStore';

import type {
  Subject,
  InlineSuggestRequest,
  InlineSuggestResult,
  InlineApplyRequest,
  LectureApplyMode,
} from '../types';

interface LectureViewerArgs {
  filePath: string;
  subject: Subject;
  topicId: string;
  topicTitle: string;
  lessonId: string;
  lessonTitle: string;
}

interface PanelContext {
  panel: vscode.WebviewPanel;
  args: LectureViewerArgs;
  watcherDisposable: vscode.Disposable;
  reloadTimer?: NodeJS.Timeout;
  /** 防止 webview 自身写回触发的 `onDidChangeTextDocument` 形成循环刷新。 */
  ignoreNextChangeUntil: number;
}

export interface LectureWebviewDeps {
  ai: AIClient;
  preferencesStore: PreferencesStore;
  progressStore: ProgressStore;
  adaptiveEngine: AdaptiveEngine;
  courseProfileStore: CourseProfileStore;
}

const VIEW_TYPE = 'claudeCoach.lectureViewer';

export class LectureWebviewProvider {
  private readonly panels = new Map<string, PanelContext>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: LectureWebviewDeps,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    deps: LectureWebviewDeps,
  ): LectureWebviewProvider {
    const provider = new LectureWebviewProvider(extensionUri, deps);
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'claudeCoach.openLectureViewer',
        async (args: LectureViewerArgs) => {
          if (!args || typeof args.filePath !== 'string') {
            vscode.window.showErrorMessage('ClaudeCoach: 缺少讲义路径，无法打开阅读器。');
            return;
          }
          await provider.openLecture(args);
        },
      ),
      provider,
    );
    return provider;
  }

  async openLecture(args: LectureViewerArgs): Promise<void> {
    const key = path.normalize(args.filePath).toLowerCase();
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      // refresh args (lessonTitle 可能改了)
      existing.args = args;
      existing.panel.title = `📖 ${args.lessonTitle || path.basename(args.filePath)}`;
      try {
        const content = await fs.readFile(args.filePath, 'utf8');
        existing.panel.webview.postMessage({
          type: 'lectureFileChanged',
          filePath: args.filePath,
          content,
        });
      } catch {
        // ignore — webview 已经存在，下次可以重试
      }
      return;
    }

    let initialContent = '';
    try {
      initialContent = await fs.readFile(args.filePath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`ClaudeCoach: 读取讲义失败 — ${message}`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `📖 ${args.lessonTitle || path.basename(args.filePath)}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'lecture-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'out', 'sidebar', 'lecture-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules'),
        ],
      },
    );

    panel.webview.html = this.buildHtml(panel.webview);

    const watcher = vscode.workspace.onDidChangeTextDocument((event) => {
      const ctx = this.panels.get(key);
      if (!ctx) return;
      if (path.normalize(event.document.uri.fsPath).toLowerCase() !== key) return;
      // 跳过自家写回触发的事件
      if (Date.now() < ctx.ignoreNextChangeUntil) return;
      if (ctx.reloadTimer) clearTimeout(ctx.reloadTimer);
      ctx.reloadTimer = setTimeout(async () => {
        try {
          const content = await fs.readFile(args.filePath, 'utf8');
          ctx.panel.webview.postMessage({
            type: 'lectureFileChanged',
            filePath: args.filePath,
            content,
          });
        } catch (error) {
          console.warn('[LectureWebview] reload failed:', error);
        }
      }, 300);
    });

    const ctx: PanelContext = {
      panel,
      args,
      watcherDisposable: watcher,
      ignoreNextChangeUntil: 0,
    };
    this.panels.set(key, ctx);

    panel.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(ctx, msg).catch((error) => {
        console.error('[LectureWebview] message handler failed:', error);
        const message = error instanceof Error ? error.message : String(error);
        ctx.panel.webview.postMessage({
          type: 'inlineSuggestResult',
          result: {
            turnId: (msg && msg.request && typeof msg.request.turnId === 'string') ? msg.request.turnId : 'unknown',
            status: 'failed',
            errorMessage: message,
          } satisfies InlineSuggestResult,
        });
      });
    });

    panel.onDidDispose(() => {
      const c = this.panels.get(key);
      if (!c) return;
      if (c.reloadTimer) clearTimeout(c.reloadTimer);
      c.watcherDisposable.dispose();
      this.panels.delete(key);
    });

    // 初始化 init payload
    const prefs = await this.deps.preferencesStore.get();
    const applyMode: LectureApplyMode = prefs.coach?.lecture?.applyMode ?? 'preview-confirm';
    const highlightChangesMs = prefs.coach?.lecture?.highlightChangesMs ?? 5000;

    panel.webview.postMessage({
      type: 'init',
      filePath: args.filePath,
      content: initialContent,
      lessonTitle: args.lessonTitle,
      topicTitle: args.topicTitle,
      subject: args.subject,
      applyMode,
      highlightChangesMs,
    });
  }

  dispose(): void {
    for (const ctx of this.panels.values()) {
      if (ctx.reloadTimer) clearTimeout(ctx.reloadTimer);
      ctx.watcherDisposable.dispose();
      try { ctx.panel.dispose(); } catch { /* noop */ }
    }
    this.panels.clear();
    while (this.disposables.length) {
      try { this.disposables.pop()?.dispose(); } catch { /* noop */ }
    }
  }

  // ===== 消息处理 =====

  private async handleMessage(ctx: PanelContext, msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'inlineSuggest':
        await this.handleInlineSuggest(ctx, msg.request as InlineSuggestRequest);
        return;
      case 'inlineApply':
        await this.handleInlineApply(ctx, msg.request as InlineApplyRequest);
        return;
      case 'inlineDismiss':
        // turn 被 user 丢弃；不需要持久化，前端已自行清掉
        return;
      case 'requestReload':
        try {
          const content = await fs.readFile(ctx.args.filePath, 'utf8');
          ctx.panel.webview.postMessage({
            type: 'lectureFileChanged',
            filePath: ctx.args.filePath,
            content,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.panel.webview.postMessage({ type: 'log', level: 'error', message });
        }
        return;
      case 'revertLastWriteback':
        await this.handleRevertLastWriteback(ctx);
        return;
      default:
        return;
    }
  }

  /**
   * 撤回上一次写回：把 `<file>.bak` 的内容写回 `<file>`，并把当前内容备份到
   * `<file>.bak`（实现一次"乒乓"，再点一下撤回就回到刚被撤掉的版本，等效 redo）。
   * 没有 .bak 时直接报错给前端。
   */
  private async handleRevertLastWriteback(ctx: PanelContext): Promise<void> {
    const filePath = ctx.args.filePath;
    const backupPath = filePath + '.bak';
    let backupContent: string;
    try {
      backupContent = await fs.readFile(backupPath, 'utf8');
    } catch {
      ctx.panel.webview.postMessage({
        type: 'log',
        level: 'error',
        message: '找不到备份文件（可能从未写回过，或备份已被清理）。',
      });
      return;
    }

    let currentContent: string;
    try {
      currentContent = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({
        type: 'log',
        level: 'error',
        message: `读取当前讲义失败：${message}`,
      });
      return;
    }

    // 写之前先让 onDidChangeTextDocument 让路
    ctx.ignoreNextChangeUntil = Date.now() + 1500;

    try {
      // 把当前内容存为新的 .bak（实现乒乓 / redo）
      await fs.writeFile(backupPath, currentContent, 'utf8');
      // 把 .bak 的旧内容写回主文件。注意：这里不走 writeMarkdown / fixLatex，
      // 因为我们就是要把"上一次写入前"的原文一字不动还原。
      await fs.writeFile(filePath, backupContent, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({
        type: 'log',
        level: 'error',
        message: `撤回失败：${message}`,
      });
      return;
    }

    ctx.panel.webview.postMessage({
      type: 'lectureFileChanged',
      filePath,
      content: backupContent,
    });
    ctx.panel.webview.postMessage({
      type: 'log',
      level: 'info',
      message: '已撤回上一次写回（再点一次可重做）。',
    });
  }

  private async handleInlineSuggest(ctx: PanelContext, request: InlineSuggestRequest): Promise<void> {
    if (!request || typeof request.turnId !== 'string') return;

    const fileContent = await fs.readFile(ctx.args.filePath, 'utf8').catch(() => '');

    let promptCtx: any;
    try {
      promptCtx = await this.buildPromptContext(ctx.args.subject, ctx.args.topicId);
    } catch (error) {
      console.warn('[LectureWebview] buildPromptContext failed, using empty ctx', error);
      promptCtx = { scope: 'lecture-edit' };
    }

    const intent = request.intent ?? 'rewrite';
    // ask 模式：强制 preview，且用专门的"问答"system，不让 AI 输出修改片段
    // 强制走 preview-confirm 的两种情况：
    //   - intent='ask'：自然不修改文件，preview 用来展示气泡
    //   - intent='rewrite' + 无选区（全文重写）：风险大，不允许 auto-apply 一键覆盖整篇
    const isFullDocRewrite = intent === 'rewrite'
      && (!request.selectionText || !request.selectionText.trim());
    const effectiveApplyMode: LectureApplyMode = (intent === 'ask' || isFullDocRewrite)
      ? 'preview-confirm'
      : request.applyMode;

    let messages;
    try {
      const isEmptySelection = !request.selectionText || !request.selectionText.trim();
      // 取光标附近 ±20 行作为 cursorContext
      const lines = fileContent.split('\n');
      const ctxStart = Math.max(0, request.sourceLineStart - 20);
      const ctxEnd = Math.min(lines.length - 1, request.sourceLineEnd + 20);
      const cursorContext = lines.slice(ctxStart, ctxEnd + 1).join('\n');

      if (intent === 'ask') {
        // 提问模式：用一个简短 system + 把选区 + 上下文 + 问题给 AI，要求"以聊天形式回答"
        const isFullDoc = !request.selectionText || !request.selectionText.trim();
        const contextDescription = isFullDoc
          ? '学生在阅读整篇讲义后提出了问题。请基于整篇讲义内容回答，不要重写或修改原文。'
          : '学生选中了讲义中的一段内容并提出问题。请直接回答，不要重写或修改原文。';
        const askInstruction = [
          '【任务模式：提问/解释，不修改讲义】',
          contextDescription,
          '回答可以是 Markdown，可以含公式 / 代码示例 / 列表。要简明、聚焦问题本身。',
          '',
          `用户问题：${request.instruction}`,
        ].join('\n');
        messages = inlineRewritePrompt({
          documentContext: fileContent,
          selectionText: request.selectionText || cursorContext,
          instruction: askInstruction,
          ctx: promptCtx,
        });
      } else if (intent === 'rewrite' && isEmptySelection) {
        // 全文 rewrite：用户没选区但要 AI 重写整篇讲义。用 reviseMarkdownPrompt
        // 让 AI 输出完整修订后的 markdown，应用阶段走 replaceWholeDocument 整篇覆盖。
        messages = reviseMarkdownPrompt(
          request.instruction,
          fileContent,
          ctx.args.lessonTitle || '当前讲义',
          promptCtx,
        );
      } else {
        messages = isEmptySelection
          ? inlineInsertPrompt({
              documentContext: fileContent,
              cursorContext,
              selectionText: request.selectionText || '',
              instruction: request.instruction,
              ctx: promptCtx,
            })
          : inlineRewritePrompt({
              documentContext: fileContent,
              selectionText: request.selectionText,
              instruction: request.instruction,
              ctx: promptCtx,
            });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({
        type: 'inlineSuggestResult',
        result: {
          turnId: request.turnId,
          status: 'failed',
          errorMessage: `prompt 构造失败：${message}`,
        } satisfies InlineSuggestResult,
      });
      return;
    }

    let suggestion = '';
    try {
      suggestion = await this.deps.ai.chatCompletion(messages, { temperature: 0.4 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({
        type: 'inlineSuggestResult',
        result: {
          turnId: request.turnId,
          status: 'failed',
          errorMessage: `AI 调用失败：${message}`,
        } satisfies InlineSuggestResult,
      });
      return;
    }

    const cleaned = stripFenceWrapper(suggestion).trim();

    if (effectiveApplyMode === 'auto-apply') {
      // webview 行号是半开区间（与 markdown-it token.map 一致），
      // writeback 契约是闭区间，必须在这里转换。
      const inclusiveEnd = Math.max(request.sourceLineStart, request.sourceLineEnd - 1);
      const hasSelection = !!(request.selectionText && request.selectionText.trim());
      const writeInput: WritebackInput = {
        filePath: ctx.args.filePath,
        sourceLineStart: request.sourceLineStart,
        sourceLineEnd: inclusiveEnd,
        selectionText: request.selectionText,
        newContent: cleaned,
        // intent: 'rewrite' 且有选区 → replace（严格匹配，找不到会 fail，不再静默吞内容）
        // 否则 → appendBelowBlock，永远不动选区原文
        mode: intent === 'rewrite' && hasSelection ? 'replace' : 'appendBelowBlock',
      };
      const writeResult = await this.runWriteback(ctx, writeInput, request.turnId);
      ctx.panel.webview.postMessage({
        type: 'inlineSuggestResult',
        result: writeResult.ok
          ? {
              turnId: request.turnId,
              status: 'applied',
              suggestion: cleaned,
              appliedRange: writeResult.appliedRange,
              intent,
            }
          : {
              turnId: request.turnId,
              status: 'failed',
              errorMessage: writeResult.errorMessage ?? '写回失败。',
              intent,
            },
      } satisfies { type: 'inlineSuggestResult'; result: InlineSuggestResult });
      return;
    }

    // preview-confirm
    ctx.panel.webview.postMessage({
      type: 'inlineSuggestResult',
      result: {
        turnId: request.turnId,
        status: 'preview',
        suggestion: cleaned,
        intent,
      } satisfies InlineSuggestResult,
    });
  }

  private async handleInlineApply(ctx: PanelContext, request: InlineApplyRequest): Promise<void> {
    if (!request || typeof request.turnId !== 'string') return;

    // webview 行号是半开区间（与 markdown-it token.map 一致），
    // writeback 契约是闭区间，必须在这里转换。
    const inclusiveEnd = Math.max(request.sourceLineStart, request.sourceLineEnd - 1);
    const hasSelection = !!(request.selectionText && request.selectionText.trim());

    // 写回模式由意图决定，而不是由"有没有选区"决定：
    //   - rewrite + 无选区 → replaceWholeDocument（整篇覆盖，先 .bak 备份）
    //   - rewrite + 有选区 → replace（严格精确匹配，匹配不上 fail，不再静默覆盖）
    //   - ask / idea → appendBelowBlock（永远不动选区原文，追加到所选 block 之后）
    //   - 没传 intent + 无选区 → appendBelowBlock（兼容旧前端"无选区即插入"的语义）
    //   - 没传 intent + 有选区 → replace（兼容旧前端"有选区即替换"的语义）
    const intent = request.intent;
    const isFullDocRewrite = intent === 'rewrite' && !hasSelection;
    const safeAppend = intent === 'ask' || intent === 'idea';
    const mode: WritebackInput['mode'] =
      isFullDocRewrite ? 'replaceWholeDocument'
      : safeAppend ? 'appendBelowBlock'
      : (!hasSelection ? 'appendBelowBlock' : 'replace');

    const writeInput: WritebackInput = {
      filePath: ctx.args.filePath,
      sourceLineStart: request.sourceLineStart,
      sourceLineEnd: inclusiveEnd,
      selectionText: request.selectionText,
      newContent: request.finalContent,
      mode,
    };

    const writeResult = await this.runWriteback(ctx, writeInput, request.turnId);
    if (writeResult.ok) {
      if (writeResult.warning) {
        ctx.panel.webview.postMessage({
          type: 'log',
          level: 'warn',
          message: writeResult.warning,
        });
      }
      ctx.panel.webview.postMessage({
        type: 'inlineApplied',
        turnId: request.turnId,
        appliedRange: writeResult.appliedRange,
      });
    } else {
      ctx.panel.webview.postMessage({
        type: 'inlineSuggestResult',
        result: {
          turnId: request.turnId,
          status: 'failed',
          errorMessage: writeResult.errorMessage ?? '写回失败。',
        } satisfies InlineSuggestResult,
      });
    }
  }

  private async runWriteback(
    ctx: PanelContext,
    input: WritebackInput,
    turnId: string,
  ): Promise<WritebackResult> {
    // 给 onDidChangeTextDocument 一个豁免窗口，避免自己写回触发自己重渲染
    ctx.ignoreNextChangeUntil = Date.now() + 1500;
    try {
      const result = await applyInlineWriteback(input);
      // 写回后主动 push 一份新内容到 webview（不依赖 onDidChangeTextDocument，因为某些场景下 fs 写不会触发）
      try {
        const content = await fs.readFile(ctx.args.filePath, 'utf8');
        ctx.panel.webview.postMessage({
          type: 'lectureFileChanged',
          filePath: ctx.args.filePath,
          content,
          appliedRange: result.appliedRange,
          turnId,
        });
      } catch { /* ignore */ }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, errorMessage: message };
    }
  }

  private async buildPromptContext(subject: Subject | undefined, topicId: string | undefined): Promise<any> {
    const [profile, prefs, diagnosis, courseCtx] = await Promise.all([
      this.deps.progressStore.getProfile().catch(() => null),
      this.deps.preferencesStore.get().catch(() => null),
      this.deps.adaptiveEngine.getLatestDiagnosis(subject).catch(() => null),
      this.deps.courseProfileStore.buildPromptContext(subject, topicId).catch(() => ({
        courseProfile: null,
        chapterProfile: null,
        profileEvidenceSummary: '',
      })),
    ]);

    return {
      profile,
      preferences: prefs,
      diagnosis,
      courseProfile: courseCtx?.courseProfile ?? null,
      chapterProfile: courseCtx?.chapterProfile ?? null,
      profileEvidenceSummary: courseCtx?.profileEvidenceSummary ?? '',
      scope: 'lecture-edit',
    };
  }

  // ===== HTML / CSP =====

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'lecture-webview', 'style.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'lecture-webview', 'main.js'),
    );
    const renderHelpersUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'lecture-webview', 'render-helpers.js'),
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
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      // Mermaid 在渲染时会动态注入 <style>，需要 unsafe-inline；img-src 也要支持 SVG data URI
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join('; ');

    const htmlPath = path.join(
      this.extensionUri.fsPath,
      'src',
      'sidebar',
      'lecture-webview',
      'index.html',
    );

    let html: string;
    try {
      // 同步读：webview HTML 必须在 createWebviewPanel 之后立即赋值，无法 await
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsSync = require('fs') as typeof import('fs');
      html = fsSync.readFileSync(htmlPath, 'utf8');
    } catch (error) {
      console.error('[LectureWebview] failed to read index.html:', error);
      return `<!DOCTYPE html><html><body><pre>讲义阅读器加载失败：缺少 index.html</pre></body></html>`;
    }

    return html
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString())
      .replace(/{{renderHelpersUri}}/g, renderHelpersUri.toString())
      .replace(/{{markdownItUri}}/g, markdownItUri.toString())
      .replace(/{{katexStyleUri}}/g, katexStyleUri.toString())
      .replace(/{{katexScriptUri}}/g, katexScriptUri.toString())
      .replace(/{{katexAutoRenderUri}}/g, katexAutoRenderUri.toString())
      .replace(/{{hljsScriptUri}}/g, hljsScriptUri.toString())
      .replace(/{{hljsStyleUri}}/g, hljsStyleUri.toString())
      .replace(/{{mermaidScriptUri}}/g, mermaidScriptUri.toString());
  }
}

// 把 AI 模型偶尔包出来的 ```markdown ... ``` 围栏剥掉
function stripFenceWrapper(text: string): string {
  const trimmed = (text ?? '').trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1];
  return trimmed;
}

// 防御：避免 isLecturePath 还没实现时整个文件爆掉。
// 真正的检查由 1A subagent 实现；这里只是消费 import，避免 unused 警告。
void isLecturePath;
