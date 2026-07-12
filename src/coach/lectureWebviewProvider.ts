/// <reference types="node" />
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
import { runClaudeCode, type ClaudeStreamEvent } from './claudeCodeRunner';

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
  chapterNumber?: number;
}

function _buildChapPrefix(args: LectureViewerArgs): string {
  const idMatch = args.lessonId?.match(/^(\d+)-(\d+)/);
  const chapN = idMatch ? parseInt(idMatch[1]) : (args.chapterNumber || 1);
  const lessonX = idMatch ? parseInt(idMatch[2]) : 1;
  return 'Chap ' + chapN + '.' + lessonX;
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
  /**
   * 正在进行的 inlineSuggest turn 的 AbortController。webview 发 cancelInlineSuggest
   * 时按 turnId 查到对应 controller 调 abort()，让 AIClient.chatCompletion 抛出 abort
   * 错误中断网络请求。handleInlineSuggest 完成（成功或失败）后 delete 自己 entry。
   */
  private readonly inflightTurns = new Map<string, AbortController>();

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
          vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'shared'),  // design-system.css
          vscode.Uri.joinPath(this.extensionUri, 'out', 'sidebar', 'lecture-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules'),
          // 让 webview 能加载讲义同目录下的 assets/（粘贴/拖入的图片本地化在这里）
          vscode.Uri.file(path.dirname(args.filePath)),
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
    // assetBaseUri：讲义所在目录的 webview-safe URI 前缀。
    // 用于 webview 里把 markdown 相对路径 ![](assets/xxx.png) 重写成
    // <img src="<assetBaseUri>/assets/xxx.png">，让 webview 能加载本地图片。
    const assetBaseUri = panel.webview
      .asWebviewUri(vscode.Uri.file(path.dirname(args.filePath)))
      .toString();

    panel.webview.postMessage({
      type: 'init',
      filePath: args.filePath,
      content: initialContent,
      lessonTitle: args.lessonTitle,
      topicTitle: args.topicTitle,
      subject: args.subject,
      chapPrefix: _buildChapPrefix(args),
      applyMode,
      highlightChangesMs,
      assetBaseUri,
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
      case 'openSourceFile': {
        // 在讲义阅读器旁边打开 .md 源文件（不覆盖讲义阅读器自身）
        try {
          const uri = vscode.Uri.file(ctx.args.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.panel.webview.postMessage({
            type: 'log',
            level: 'error',
            message: `打开源文件失败：${message}`,
          });
        }
        return;
      }
      case 'deleteLectureRange': {
        await this.handleDeleteLectureRange(ctx, msg);
        return;
      }
      case 'cancelInlineSuggest': {
        const turnId = typeof msg?.turnId === 'string' ? msg.turnId : '';
        if (!turnId) return;
        const controller = this.inflightTurns.get(turnId);
        if (controller) {
          try { controller.abort(); } catch { /* noop */ }
          // 不在这里 delete —— 留给 handleInlineSuggest 的 finally 统一清理，
          // 避免和 abort 后 catch 里的清理路径冲突
        }
        return;
      }
      case 'pasteMedia': {
        await this.handlePasteMedia(ctx, msg);
        return;
      }
      case 'openExternalUrl': {
        const url = typeof msg?.url === 'string' ? msg.url : '';
        if (!url) return;
        try {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.panel.webview.postMessage({ type: 'log', level: 'error', message: `打开链接失败：${message}` });
        }
        return;
      }
      case 'claudeCodeSearchImage': {
        await this.handleClaudeCodeSearchImage(ctx, msg);
        return;
      }
      default:
        return;
    }
  }

  /**
   * 撤回上一次写回：把 `<file>.bak` 的内容写回 `<file>`，并把当前内容备份到
   * `<file>.bak`（实现一次"乒乓"，再点一下撤回就回到刚被撤掉的版本，等效 redo）。
   * 没有 .bak 时直接报错给前端。
   */
  /**
   * 删除讲义 .md 中 [startLine, endLine) 半开区间的行（markdown-it token.map 风格）。
   * 写之前先把当前内容存到 .bak，让 Ctrl+Z（讲义阅读器内）能撤回。
   * 触发场景：widget ⋯ 菜单的"删除这个 widget"。
   */
  /**
   * 多模态粘贴：图片 blob / 图片 URL / 视频 URL。
   * 图片 → 保存到 <讲义同目录>/assets/<时间戳>-<rand>.<ext> + 插 `![](assets/xxx)`
   * 视频 → 生成 <div class="cc-video" data-...> 卡片 markdown，前端 renderVideoCards 渲染
   * 插入位置：msg.targetLine 数字 → 该行后；'end' → 文件末尾
   * 写之前先 .bak 备份，支持 Ctrl+Z 撤回。
   */
  private async handlePasteMedia(ctx: PanelContext, msg: any): Promise<void> {
    const media = msg?.media;
    if (!media || typeof media !== 'object') return;
    const filePath = ctx.args.filePath;

    let markdown: string;
    try {
      if (media.kind === 'image-blob') {
        const { buffer, ext } = parseDataUrl(String(media.dataUrl || ''));
        const fileName = makeAssetName(guessExtFromName(media.name) || ext || 'png');
        const relPath = await this.saveAsset(filePath, fileName, buffer);
        markdown = `![](${relPath})`;
      } else if (media.kind === 'image-url') {
        const { buffer, contentType } = await downloadToBuffer(String(media.url));
        const ext = guessExtFromContentType(contentType) || guessExtFromUrl(String(media.url)) || 'png';
        const fileName = makeAssetName(ext);
        const relPath = await this.saveAsset(filePath, fileName, buffer);
        markdown = `![](${relPath})`;
      } else if (media.kind === 'video') {
        markdown = makeVideoCardMarkdown(media);
      } else {
        ctx.panel.webview.postMessage({
          type: 'log', level: 'error',
          message: `未知多模态类型: ${media.kind}`,
        });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({
        type: 'log', level: 'error',
        message: `多模态保存失败：${message}`,
      });
      return;
    }

    // 插入到 targetLine 后；'end' 或非数字 → 末尾
    ctx.ignoreNextChangeUntil = Date.now() + 1500;
    try {
      const current = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(filePath + '.bak', current, 'utf8');
      const lines = current.split('\n');
      const targetLine = msg?.targetLine;
      const insertAt = (targetLine === 'end' || !Number.isFinite(Number(targetLine)))
        ? lines.length
        : Math.max(0, Math.min(Math.floor(Number(targetLine)), lines.length));
      // 前后加空行保证 markdown 块语义
      const inserted = ['', markdown, ''];
      const next = [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)].join('\n');
      await fs.writeFile(filePath, next, 'utf8');
      ctx.panel.webview.postMessage({
        type: 'lectureFileChanged',
        filePath,
        content: next,
      });
      ctx.panel.webview.postMessage({
        type: 'inlineApplied',
        turnId: 'paste-media-' + Date.now(),
        appliedRange: { startLine: insertAt, endLine: insertAt + inserted.length },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({
        type: 'log', level: 'error',
        message: `插入多模态资源失败：${message}`,
      });
    }
  }

  /** 把字节写到 <讲义同目录>/assets/<fileName>，返回相对路径（用于 markdown）。 */
  private async saveAsset(lectureFilePath: string, fileName: string, buffer: Buffer): Promise<string> {
    const lectureDir = path.dirname(lectureFilePath);
    const assetsDir = path.join(lectureDir, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, fileName), buffer);
    return `assets/${fileName}`;
  }

  /**
   * 智能搜图：spawn Claude Code CLI 子进程，让 Claude 用 WebSearch/WebFetch
   * 找到相关教学图的真实 URL，然后由 ClaudeCoach 宿主端 HTTP 下载 + 落盘到 assets/。
   *
   * 设计细节（关键根因）：
   *  - Claude Code 的 Write 工具内部强制文本编码，**无法写二进制 PNG/JPG** —— 之前让
   *    Claude 自己下载保存的版本，每次都失败回 fallback "Write工具无法写入二进制PNG"。
   *    所以分工反转：Claude 只搜+给 URL，宿主端用 https.get 下载（pasteMedia 已验证）。
   *  - Claude 只给 WebSearch / WebFetch（不给 Write/Read/Edit/Bash/Task）
   *  - cwd 限定到讲义所在目录
   *  - 流式事件 → 进度文本 → postMessage 给 webview 显示
   *  - Claude 最后一行 stdout 必须是 {"images":[{url,caption}...], "reason"?}（约定）
   *  - 拿到 URL 清单后宿主 downloadToBuffer + saveAsset + 拼 markdown + 插入指定行
   */
  private async handleClaudeCodeSearchImage(ctx: PanelContext, msg: any): Promise<void> {
    const query = String(msg?.query || '').trim();
    const turnId = String(msg?.turnId || '');
    const targetLine = msg?.targetLine;
    const subject = String(msg?.subject || ctx.args.subject || '');
    const topicTitle = String(msg?.topic || ctx.args.topicTitle || '');
    const lessonTitle = String(msg?.lessonTitle || ctx.args.lessonTitle || '');
    if (!query || !turnId) {
      this.postCancel(ctx, turnId, '搜图参数缺失');
      return;
    }

    const lectureDir = path.dirname(ctx.args.filePath);

    // 进度文本流（拼到 streaming bubble）
    const pushDelta = (text: string) => {
      ctx.panel.webview.postMessage({
        type: 'aiStreamDelta',
        turnId,
        channel: 'lecture',
        delta: text,
      });
    };

    pushDelta('🔍 正在让 Claude Code 搜索…\n\n');

    // 注册 abort controller，让 webview 的 ✕ 取消能 kill 子进程
    const controller = new AbortController();
    this.inflightTurns.set(turnId, controller);

    const prompt = this.buildSearchImagePrompt({
      query,
      subject,
      topicTitle,
      lessonTitle,
      lessonFilePath: ctx.args.filePath,
    });

    let result;
    try {
      result = await runClaudeCode({
        prompt,
        cwd: lectureDir,
        // 只给 WebSearch / WebFetch —— Write 工具无法处理二进制 PNG/JPG，给了反而让 Claude 误用
        allowedTools: ['WebSearch', 'WebFetch'],
        // 显式禁掉所有可能让 Claude 分散注意力或误用的工具：
        //  - Write/Read: 跟搜图无关，且 Write 无法处理二进制让 Claude 卡死
        //  - Task: 会让它 spawn 子 agent 反复思考
        //  - TodoWrite: 会让它先 plan
        //  - Edit/Bash/Glob/Grep/NotebookEdit: 跟搜图无关
        disallowedTools: ['Write', 'Read', 'Task', 'TodoWrite', 'Edit', 'Bash', 'Glob', 'Grep',
          'NotebookEdit', 'Skill', 'SlashCommand', 'SendUserMessage'],
        skipPermissions: true,  // 不交互模式，工具调用直接生效
        effort: 'low',           // 关键：Claude 4 默认 Extended Thinking 占 output 配额 →
                                  // Claude 思考完没 token 输出"实际搜图"，直接输出 fallback
                                  // "未找到合适图"。effort=low 把配额留给真实搜+下载+输出 JSON。
        timeoutMs: 180000,       // 3 分钟够长（搜+下载 1-3 张图）
        signal: controller.signal,
        onEvent: (event: ClaudeStreamEvent) => {
          // 把工具调用 / 文本片段映射成进度文本
          if (event.type === 'tool_use' || event.type === 'assistant') {
            const name = event.name || event.tool_name
              || (event.message && event.message.content && event.message.content[0] && event.message.content[0].name);
            const input = event.input || (event.message && event.message.content && event.message.content[0] && event.message.content[0].input);
            if (name === 'WebSearch') {
              const q = input?.query || '';
              pushDelta(`🔎 搜索：${q}\n`);
            } else if (name === 'WebFetch') {
              const url = input?.url || '';
              pushDelta(`📥 抓取：${url}\n`);
            }
          } else if (event.type === 'text' && event.text) {
            // 助手中间的解释性文字
            pushDelta(String(event.text));
          }
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.inflightTurns.delete(turnId);
      this.postCancel(ctx, turnId, `Claude Code 启动失败：${message}（确认已安装并登录，PATH 里能找到 'claude'）`);
      return;
    } finally {
      this.inflightTurns.delete(turnId);
    }

    // 处理被取消的情况
    if (result.aborted) {
      this.postCancel(ctx, turnId, '搜图已取消');
      return;
    }
    if (result.exitCode !== 0) {
      pushDelta(`\n\n❌ Claude Code 退出码 ${result.exitCode}\n${result.stderr.slice(0, 500)}`);
      this.postCancel(ctx, turnId, `Claude Code 异常退出（${result.exitCode}）`);
      return;
    }

    // 拿最后一行 JSON 清单：新格式 {"images":[{url,caption}]} —— Claude 只给 URL，宿主端下载
    // 兼容老格式 {"saved":[{path,caption}]} 万一 Claude 没读到新 prompt 仍按旧格式输出
    const summary = result.finalJson;
    const urlItems: Array<{ url: string; caption?: string }> = Array.isArray(summary?.images)
      ? summary.images.filter((it: any) => it && typeof it.url === 'string' && /^https?:\/\//i.test(it.url))
      : [];
    if (!summary || urlItems.length === 0) {
      const reason = summary?.reason || '未找到合适图';
      pushDelta(`\n\n⚠ ${reason}`);

      // 调试：把 Claude 真实 stdout / stderr / 耗时 / arg 信息 dump 到临时文件，
      // 便于排查 "Claude 真的搜了但没找到" vs "Claude 没搜直接放弃" vs "stream-json 解析丢字段"
      try {
        const os = require('os') as typeof import('os');
        const fsSync = require('fs') as typeof import('fs');
        const dbgPath = path.join(os.tmpdir(), `cc-search-image-debug-${Date.now()}.json`);
        fsSync.writeFileSync(dbgPath, JSON.stringify({
          query,
          duration: result.durationMs,
          exitCode: result.exitCode,
          stdoutLines: result.stdoutLines.length,
          stdoutPreview: result.stdoutLines.slice(0, 10),
          stdoutTail: result.stdoutLines.slice(-15),
          stderrTail: result.stderr.slice(-1000),
          finalJson: result.finalJson,
        }, null, 2), 'utf8');
        ctx.panel.webview.postMessage({
          type: 'log', level: 'warn',
          message: `[claude search-image] 未找到图。调试信息: ${dbgPath}`,
        });
      } catch { /* swallow */ }

      this.postCancel(ctx, turnId, reason);
      return;
    }

    // 把找到的 URL 列表下载到 assets/ 并按顺序插入讲义
    pushDelta(`\n\n✅ 共找到 ${urlItems.length} 个 URL，开始下载…\n`);
    try {
      // 先全部下载到 assets/（失败的跳过），最后再写讲义 —— 避免讲义已改但下载失败
      const imageBlocks: string[] = [];
      const downloadErrors: string[] = [];
      for (const item of urlItems) {
        try {
          pushDelta(`⬇ 下载：${item.url}\n`);
          const { buffer, contentType } = await downloadToBuffer(item.url);
          const ext = guessExtFromContentType(contentType) || guessExtFromUrl(item.url) || 'png';
          const fileName = makeAssetName(ext);
          const relPath = await this.saveAsset(ctx.args.filePath, fileName, buffer);
          const caption = String(item.caption || '').trim();
          imageBlocks.push('');
          imageBlocks.push(caption ? `![${caption}](${relPath})` : `![](${relPath})`);
        } catch (err) {
          const dlMsg = err instanceof Error ? err.message : String(err);
          downloadErrors.push(`${item.url}: ${dlMsg}`);
          pushDelta(`✕ 下载失败：${dlMsg}\n`);
        }
      }
      if (imageBlocks.length === 0) {
        this.postCancel(
          ctx,
          turnId,
          `所有候选 URL 都下载失败：${downloadErrors.join('; ').slice(0, 400)}`,
        );
        return;
      }
      imageBlocks.push('');
      const savedCount = imageBlocks.filter((line) => line.startsWith('![')).length;

      const current = await fs.readFile(ctx.args.filePath, 'utf8');
      await fs.writeFile(ctx.args.filePath + '.bak', current, 'utf8');
      const lines = current.split('\n');
      const insertAt = (targetLine === 'end' || !Number.isFinite(Number(targetLine)))
        ? lines.length
        : Math.max(0, Math.min(Math.floor(Number(targetLine)), lines.length));
      const next = [...lines.slice(0, insertAt), ...imageBlocks, ...lines.slice(insertAt)].join('\n');

      ctx.ignoreNextChangeUntil = Date.now() + 1500;
      await fs.writeFile(ctx.args.filePath, next, 'utf8');

      // 通知 webview 重渲 + 关闭 bubble
      ctx.panel.webview.postMessage({
        type: 'lectureFileChanged',
        filePath: ctx.args.filePath,
        content: next,
      });
      ctx.panel.webview.postMessage({
        type: 'inlineApplied',
        turnId: 'claude-search-' + Date.now(),
        appliedRange: { startLine: insertAt, endLine: insertAt + imageBlocks.length },
      });
      // 关闭 streaming bubble
      ctx.panel.webview.postMessage({ type: 'inlineCancelled', turnId });
      ctx.panel.webview.postMessage({
        type: 'log', level: 'info',
        message: `Claude Code 已嵌入 ${savedCount} 张图（${(result.durationMs / 1000).toFixed(1)}s）`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postCancel(ctx, turnId, `插入失败：${message}`);
    }
  }

  /** 关闭对应的 streaming bubble + log 错误。 */
  private postCancel(ctx: PanelContext, turnId: string, reason: string): void {
    if (turnId) {
      ctx.panel.webview.postMessage({ type: 'inlineCancelled', turnId });
    }
    ctx.panel.webview.postMessage({
      type: 'log', level: 'warn',
      message: `[claudeCodeSearchImage] ${reason}`,
    });
  }

  /** 拼搜图任务的 Claude Code prompt。 */
  private buildSearchImagePrompt(args: {
    query: string;
    subject: string;
    topicTitle: string;
    lessonTitle: string;
    lessonFilePath: string;
  }): string {
    const contextLines = [
      `- 讲义文件: ${args.lessonFilePath}`,
      `- 学科: ${args.subject || '未指定'}`,
      `- 章节: ${args.topicTitle || '未指定'}`,
      `- 当前讲义: ${args.lessonTitle || '未指定'}`,
      `- 用户描述要找的图: ${args.query}`,
    ].join('\n');

    return [
      '你是 ClaudeCoach 的图片搜索助手。任务：为讲义找出 1-3 张高质量教学示意图的**真实 URL**。',
      '**你不负责下载也不负责保存** —— 下载和落盘由 ClaudeCoach 宿主端完成，你只需要给 URL。',
      '',
      '## 上下文',
      contextLines,
      '',
      '## 工作步骤',
      '1. 用 WebSearch 搜 1-3 个不同搜索 query（构造时把"学科 + 章节 + 用户描述"组合，加 diagram/illustration/figure 等关键词）',
      '2. 从结果挑 1-3 张候选图。优先来源：',
      '   - Wikipedia / Wikipedia Commons',
      '   - Distill.pub / Jay Alammar (jalammar.github.io) / 3Blue1Brown',
      '   - 教材作者主页 / 公开课讲义',
      '   - arxiv 论文图（jpg/png 直链）',
      '3. 必要时用 WebFetch 取候选页面 HTML，从中提取真正的 `<img src="...">` 绝对 URL',
      '   （要的是图的直接 URL，不是缩略图、不是 logo、不是 og:image 占位图）',
      '4. 直接输出这 1-3 个 URL 的 JSON 清单，**结束**',
      '',
      '## 严格约束（重要）',
      '- **只用工具 WebSearch 和 WebFetch，绝对不要用其他工具**',
      '- **不要尝试用 Write 工具下载或保存图片** —— Write 只能写文本，无法处理 PNG/JPG 二进制，一定会失败。你只需要给 URL，宿主端自己 HTTP 下载。',
      '- **不要修改讲义 .md 文件** —— 你只负责给 URL，插入由 ClaudeCoach 自己做',
      '- **学术 / 技术示意图**，不要摄影艺术图、营销图、低分辨率图、有大水印的图',
      '- URL 必须是图片直链（以 .png / .jpg / .jpeg / .gif / .webp / .svg 结尾，或来源页明确是图片资源）',
      '- 如果搜不到合适的，直接输出 `{"images":[],"reason":"具体原因"}` 然后停止，不要硬塞错图',
      '',
      '## 输出格式',
      '**最后一行 stdout** 必须输出一个独立的 JSON（不要包在代码块里、不要多余文本），格式如下：',
      '```json',
      '{"images":[{"url":"https://example.com/figure.png","caption":"图说"},{"url":"https://example.com/figure2.jpg","caption":"图说2"}]}',
      '```',
      '`url` 是图片真实直链（http/https）；`caption` 是简短的图片说明（10-30 字，会成为 markdown alt）。',
      '',
      '失败时：',
      '```json',
      '{"images":[],"reason":"具体原因，如：未找到符合学术质量的图"}',
      '```',
      '',
      '开始执行。',
    ].join('\n');
  }

  private async handleDeleteLectureRange(ctx: PanelContext, msg: any): Promise<void> {
    const startLine = Number(msg?.startLine);
    const endLine = Number(msg?.endLine);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine <= startLine) {
      ctx.panel.webview.postMessage({
        type: 'log',
        level: 'error',
        message: `删除范围非法：startLine=${msg?.startLine} endLine=${msg?.endLine}`,
      });
      return;
    }

    const filePath = ctx.args.filePath;
    let current: string;
    try {
      current = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({ type: 'log', level: 'error', message: `读取讲义失败：${message}` });
      return;
    }

    // 让 onDidChangeTextDocument 让路，避免自家写回引发重复刷新
    ctx.ignoreNextChangeUntil = Date.now() + 1500;

    try {
      await fs.writeFile(filePath + '.bak', current, 'utf8');
      const lines = current.split('\n');
      const safeStart = Math.max(0, Math.min(Math.floor(startLine), lines.length));
      const safeEnd = Math.max(safeStart, Math.min(Math.floor(endLine), lines.length));
      const next = [...lines.slice(0, safeStart), ...lines.slice(safeEnd)].join('\n');
      await fs.writeFile(filePath, next, 'utf8');
      ctx.panel.webview.postMessage({
        type: 'lectureFileChanged',
        filePath,
        content: next,
      });
      // 显示 undo pill 让用户能 Ctrl+Z 撤回（appliedRange 走零长度区间表"光删了"）
      ctx.panel.webview.postMessage({
        type: 'inlineApplied',
        turnId: 'delete-range-' + Date.now(),
        appliedRange: { startLine: safeStart, endLine: safeStart },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.panel.webview.postMessage({ type: 'log', level: 'error', message: `删除失败：${message}` });
    }
  }

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
    // 注册 AbortController 让 webview 的 ✕ 取消按钮能中断网络请求。
    const controller = new AbortController();
    this.inflightTurns.set(request.turnId, controller);
    try {
      // 流式：每个 token 立即 post 给 webview，前端在 preview bubble 里逐字累加渲染。
      suggestion = await this.deps.ai.chatCompletion(messages, {
        temperature: 0.4,
        signal: controller.signal,
        onDelta: (chunk) => {
          ctx.panel.webview.postMessage({
            type: 'aiStreamDelta',
            turnId: request.turnId,
            channel: 'lecture',
            delta: chunk,
          });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAbort = controller.signal.aborted
        || (error as any)?.name === 'AbortError'
        || /\baborted?\b/i.test(message);
      // 不论是不是 abort，先发 aiStreamEnd 让 webview 关掉 streaming 节流 timer
      ctx.panel.webview.postMessage({
        type: 'aiStreamEnd',
        turnId: request.turnId,
        channel: 'lecture',
        error: isAbort ? 'cancelled' : message,
      });
      if (isAbort) {
        // 取消是用户主动行为，不走 failed bubble（会显红色"AI 失败"误导用户），
        // 走专用 inlineCancelled：webview 清掉 bubble + 显示"已取消"toast
        ctx.panel.webview.postMessage({
          type: 'inlineCancelled',
          turnId: request.turnId,
        });
      } else {
        ctx.panel.webview.postMessage({
          type: 'inlineSuggestResult',
          result: {
            turnId: request.turnId,
            status: 'failed',
            errorMessage: `AI 调用失败：${message}`,
          } satisfies InlineSuggestResult,
        });
      }
      return;
    } finally {
      this.inflightTurns.delete(request.turnId);
    }

    let cleaned = stripFenceWrapper(suggestion).trim();
    // widget 模式兜底：AI 偶尔不写 ```widget 围栏直接 dump raw HTML（违反 prompt 规则 1）。
    // 这种内容写回讲义后会被 markdown-it 当 raw HTML 透传 → 浏览器执行（污染 webview，
    // 而不是渲染成 widget iframe）。这里检测：widget 模式 + 内容看起来是 HTML 但无围栏 →
    // 自动补上 ```widget...``` 围栏。
    const isWidgetMode = /^【模式：互动演示生成】/.test(request.instruction || '');
    if (isWidgetMode && !/^```widget\b/i.test(cleaned)) {
      const looksLikeHtml = /^<!DOCTYPE\s+html\b|^<html\b|^<style\b|^<script\b|^<div\b|^<svg\b|^<head\b|^<body\b/i
        .test(cleaned);
      if (looksLikeHtml) {
        cleaned = '```widget\n' + cleaned + '\n```';
      }
    }

    // 流式收尾：通知前端"finalText 是这个，可以采纳/丢弃"
    ctx.panel.webview.postMessage({
      type: 'aiStreamEnd',
      turnId: request.turnId,
      channel: 'lecture',
      finalText: cleaned,
    });

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
      // 关键：**只在写回成功时**推 lectureFileChanged（带 turnId）。
      // 失败时不能推 —— 前端 case 'lectureFileChanged' 看到 turnId 会 removeBubble +
      // toast '已写回讲义' success + 清 activeTurns，紧接着的 inlineSuggestResult failed
      // 因为 activeTurns 已被清而被静默吞掉 → 用户看到"假成功 + 没报错 + 讲义没变"。
      if (result.ok) {
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
      }
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
    const designSystemUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'shared', 'design-system.css'),
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
    const graphvizScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@hpcc-js', 'wasm', 'dist', 'graphviz.umd.js'),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // **关键**：必须 'unsafe-inline' 让 widget iframe srcdoc 里的 inline
      // <script> 能跑（srcdoc 继承父 CSP，blob: 也被 VS Code 拦下）。
      // 注意：CSP3 规范规定 nonce 存在时 'unsafe-inline' 被忽略 → 必须移除 nonce
      // 才能让 'unsafe-inline' 生效。我们的 webview 脚本全部是 src=... 外部加载，
      // 由 cspSource 的 'self' 等效授权，不依赖 nonce。
      `script-src ${webview.cspSource} 'unsafe-inline' 'wasm-unsafe-eval'`,
      `frame-src 'self' data: blob:`,
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
      .replace(/{{designSystemUri}}/g, designSystemUri.toString())
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString())
      .replace(/{{renderHelpersUri}}/g, renderHelpersUri.toString())
      .replace(/{{markdownItUri}}/g, markdownItUri.toString())
      .replace(/{{katexStyleUri}}/g, katexStyleUri.toString())
      .replace(/{{katexScriptUri}}/g, katexScriptUri.toString())
      .replace(/{{katexAutoRenderUri}}/g, katexAutoRenderUri.toString())
      .replace(/{{hljsScriptUri}}/g, hljsScriptUri.toString())
      .replace(/{{hljsStyleUri}}/g, hljsStyleUri.toString())
      .replace(/{{mermaidScriptUri}}/g, mermaidScriptUri.toString())
      .replace(/{{graphvizScriptUri}}/g, graphvizScriptUri.toString());
  }
}

// 把 AI 模型偶尔包出来的 ```markdown ... ``` 围栏剥掉
function stripFenceWrapper(text: string): string {
  const trimmed = (text ?? '').trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1];
  return trimmed;
}

// ===== 多模态辅助函数（handlePasteMedia 用）=====

/** dataURL → buffer + mime + ext。失败抛 Error。 */
function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer; ext: string } {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid dataURL');
  const mime = m[1];
  const buffer = Buffer.from(m[2], 'base64');
  const ext = (mime.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
  return { mime, buffer, ext };
}

function guessExtFromName(name?: string): string | null {
  if (!name) return null;
  const m = String(name).match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

function guessExtFromUrl(url: string): string | null {
  const m = String(url).match(/\.([a-z0-9]+)(?:\?|#|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function guessExtFromContentType(ct?: string): string | null {
  if (!ct) return null;
  const m = String(ct).match(/^image\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null;
}

function makeAssetName(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(3).toString('hex');
  return `${ts}-${rand}.${ext}`;
}

/**
 * 用 Node 标准库 https/http 下载远程图片。不用全局 fetch，因为 tsconfig
 * lib=["ES2022"] 不含 DOM → 编译期没有 fetch 类型；require 形式跟本文件
 * fsSync 那段一致 pattern，绕过类型问题。运行时是同一个 Node 进程没区别。
 * 跟随 3 次重定向（Location 头）。
 */
function downloadToBuffer(
  url: string,
  redirectsLeft: number = 3,
): Promise<{ buffer: Buffer; contentType?: string }> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lib: any = url.startsWith('https://') ? require('https') : require('http');
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 ClaudeCoach' } },
      (res: any) => {
        // 3xx 重定向：递归下载新 URL（避免 URL 类型依赖，手工拼绝对路径）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const loc = String(res.headers.location);
          const next = /^https?:\/\//i.test(loc)
            ? loc
            : (() => {
                const m = url.match(/^(https?:\/\/[^/]+)/i);
                const origin = m ? m[1] : '';
                return origin + (loc.startsWith('/') ? loc : '/' + loc);
              })();
          downloadToBuffer(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers['content-type'],
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

function escHtmlAttr(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生成视频卡片的 markdown（嵌入式 div，data-* 属性保留信息，前端 renderVideoCards 渲染卡片）。 */
function makeVideoCardMarkdown(media: { platform?: string; id?: string; t?: number; url?: string }): string {
  const platform = String(media.platform || 'video');
  const id = String(media.id || '');
  const t = Number(media.t || 0);
  const url = String(media.url || '');
  // div 单独成块（前后空行让 markdown-it 当 raw HTML block 处理）
  return `<div class="cc-video" data-platform="${escHtmlAttr(platform)}" data-id="${escHtmlAttr(id)}" data-t="${t}" data-url="${escHtmlAttr(url)}"><a href="${escHtmlAttr(url)}">${escHtmlAttr(url)}</a></div>`;
}

// 防御：避免 isLecturePath 还没实现时整个文件爆掉。
// 真正的检查由 1A subagent 实现；这里只是消费 import，避免 unused 警告。
void isLecturePath;
