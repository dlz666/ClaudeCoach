import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import type {
  Exercise,
  GradeResult,
  PracticeRoomArgs,
  PracticeRoomGradeRequest,
} from '../types';

interface PracticePanelContext {
  panel: vscode.WebviewPanel;
  args: PracticeRoomArgs;
  exercises: Exercise[];
}

export interface PracticeWebviewDeps {
  loadExercises(args: PracticeRoomArgs): Promise<Exercise[]>;
  loadResults(args: PracticeRoomArgs): Promise<GradeResult[]>;
  gradeAnswer(request: PracticeRoomGradeRequest): Promise<GradeResult>;
  openMarkdown(args: PracticeRoomArgs): Promise<void>;
}

const VIEW_TYPE = 'claudeCoach.practiceRoom';

export class PracticeWebviewProvider implements vscode.Disposable {
  private readonly panels = new Map<string, PracticePanelContext>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: PracticeWebviewDeps,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    deps: PracticeWebviewDeps,
  ): PracticeWebviewProvider {
    const provider = new PracticeWebviewProvider(extensionUri, deps);
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeCoach.openPracticeRoom', async (args: PracticeRoomArgs) => {
        if (!args?.subject || !args?.topicId || !args?.lessonId) {
          vscode.window.showErrorMessage('ClaudeCoach: 缺少课时信息，无法打开练习室。');
          return;
        }
        await provider.open(args);
      }),
      provider,
    );
    return provider;
  }

  async open(args: PracticeRoomArgs): Promise<void> {
    const key = this.keyOf(args);
    const exercises = await this.deps.loadExercises(args);
    if (!exercises.length) {
      vscode.window.showInformationMessage(`“${args.lessonTitle}”还没有练习，请先生成。`);
      return;
    }

    const existing = this.panels.get(key);
    if (existing) {
      existing.args = args;
      existing.exercises = exercises;
      existing.panel.title = `◎ ${args.lessonTitle}`;
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      await this.sendInit(existing);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `◎ ${args.lessonTitle}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'practice-webview'),
          vscode.Uri.joinPath(this.extensionUri, 'src', 'sidebar', 'shared'),
          vscode.Uri.joinPath(this.extensionUri, 'node_modules'),
        ],
      },
    );
    panel.webview.html = this.buildHtml(panel.webview);

    const ctx: PracticePanelContext = { panel, args, exercises };
    this.panels.set(key, ctx);
    panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(ctx, message).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[PracticeWebview] message failed:', error);
        void panel.webview.postMessage({ type: 'error', message: detail });
      });
    });
    panel.onDidDispose(() => this.panels.delete(key));
  }

  dispose(): void {
    for (const ctx of this.panels.values()) {
      try { ctx.panel.dispose(); } catch { /* noop */ }
    }
    this.panels.clear();
  }

  private keyOf(args: PracticeRoomArgs): string {
    return `${args.subject}:${args.topicId}:${args.lessonId}`.toLowerCase();
  }

  private async sendInit(ctx: PracticePanelContext): Promise<void> {
    const safeExercises = ctx.exercises.map(({ referenceAnswer: _answer, ...exercise }) => exercise);
    const results = await this.deps.loadResults(ctx.args);
    await ctx.panel.webview.postMessage({
      type: 'init',
      args: ctx.args,
      exercises: safeExercises,
      results,
      generationId: ctx.exercises[0]?.generationId || 'legacy',
    });
  }

  private async handleMessage(ctx: PracticePanelContext, message: any): Promise<void> {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        await this.sendInit(ctx);
        return;
      case 'reload': {
        ctx.exercises = await this.deps.loadExercises(ctx.args);
        await this.sendInit(ctx);
        return;
      }
      case 'openMarkdown':
        await this.deps.openMarkdown(ctx.args);
        return;
      case 'gradeOne': {
        const exercise = this.findExercise(ctx, message.exerciseId, message.generationId);
        await ctx.panel.webview.postMessage({ type: 'gradeStarted', exerciseId: exercise.id });
        try {
          const result = await this.deps.gradeAnswer({
            ...ctx.args,
            exercise,
            answer: String(message.answer || ''),
            hintsUsed: Math.max(0, Number(message.hintsUsed) || 0),
          });
          await ctx.panel.webview.postMessage({ type: 'gradeResult', result });
        } catch (error) {
          await ctx.panel.webview.postMessage({
            type: 'gradeFailed',
            exerciseId: exercise.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case 'gradeMany': {
        const answers = Array.isArray(message.answers) ? message.answers : [];
        const results: GradeResult[] = [];
        for (let index = 0; index < answers.length; index += 1) {
          const item = answers[index];
          const exercise = this.findExercise(ctx, item.exerciseId, message.generationId);
          await ctx.panel.webview.postMessage({
            type: 'gradeProgress',
            exerciseId: exercise.id,
            current: index + 1,
            total: answers.length,
          });
          try {
            const result = await this.deps.gradeAnswer({
              ...ctx.args,
              exercise,
              answer: String(item.answer || ''),
              hintsUsed: Math.max(0, Number(item.hintsUsed) || 0),
            });
            results.push(result);
            await ctx.panel.webview.postMessage({ type: 'gradeResult', result });
          } catch (error) {
            await ctx.panel.webview.postMessage({
              type: 'gradeFailed',
              exerciseId: exercise.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const averageScore = results.length
          ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length)
          : 0;
        await ctx.panel.webview.postMessage({
          type: 'gradeComplete',
          succeeded: results.length,
          total: answers.length,
          averageScore,
        });
        return;
      }
    }
  }

  private findExercise(ctx: PracticePanelContext, exerciseId: string, generationId?: string): Exercise {
    const exercise = ctx.exercises.find((item) => item.id === exerciseId);
    if (!exercise) throw new Error(`找不到练习 ${exerciseId}`);
    if (generationId && exercise.generationId && exercise.generationId !== generationId) {
      throw new Error('题组已经更新，请刷新练习室后重新作答。');
    }
    return exercise;
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...segments: string[]) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, ...segments),
    ).toString();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `img-src ${webview.cspSource} data:`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join('; ');
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      'src',
      'sidebar',
      'practice-webview',
      'index.html',
    );
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs');
      return fs.readFileSync(htmlPath, 'utf8')
        .replace(/{{csp}}/g, csp)
        .replace(/{{nonce}}/g, nonce)
        .replace(/{{designSystemUri}}/g, uri('src', 'sidebar', 'shared', 'design-system.css'))
        .replace(/{{styleUri}}/g, uri('src', 'sidebar', 'practice-webview', 'style.css'))
        .replace(/{{scriptUri}}/g, uri('src', 'sidebar', 'practice-webview', 'main.js'))
        .replace(/{{markdownItUri}}/g, uri('node_modules', 'markdown-it', 'dist', 'markdown-it.min.js'))
        .replace(/{{katexStyleUri}}/g, uri('node_modules', 'katex', 'dist', 'katex.min.css'))
        .replace(/{{katexScriptUri}}/g, uri('node_modules', 'katex', 'dist', 'katex.min.js'))
        .replace(/{{katexAutoRenderUri}}/g, uri('node_modules', 'katex', 'dist', 'contrib', 'auto-render.min.js'))
        .replace(/{{hljsScriptUri}}/g, uri('node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js'))
        .replace(/{{hljsStyleUri}}/g, uri('node_modules', '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'));
    } catch (error) {
      console.error('[PracticeWebview] failed to load HTML:', error);
      return '<!doctype html><html><body><h2>练习室加载失败</h2></body></html>';
    }
  }
}
