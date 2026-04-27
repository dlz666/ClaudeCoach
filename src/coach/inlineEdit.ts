import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AIClient } from '../ai/client';
import { PreferencesStore } from '../progress/preferencesStore';
import { CourseProfileStore } from '../progress/courseProfileStore';
import { ProgressStore } from '../progress/progressStore';
import { AdaptiveEngine } from '../progress/adaptiveEngine';
import { CourseManager } from '../courses/courseManager';
import { inlineInsertPrompt, inlineRewritePrompt } from '../ai/prompts';
import { Subject } from '../types';
import { applyInlineWriteback, isLecturePath } from './inlineWriteback';

const CURSOR_CONTEXT_RADIUS = 20;
const HIGHLIGHT_DURATION_MS = 5000;
const AI_MAX_TOKENS = 800;
const AI_TEMPERATURE = 0.4;

let highlightDecorationType: vscode.TextEditorDecorationType | undefined;

function getHighlightDecoration(): vscode.TextEditorDecorationType {
  if (!highlightDecorationType) {
    highlightDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(50,200,80,0.2)',
      isWholeLine: false,
      borderRadius: '2px',
    });
  }
  return highlightDecorationType;
}

/**
 * Best-effort subject inference from a lecture file path. Path layout:
 *   <root>/workspaces/<wsId>/courses/<subject>/topics/<topicId>/lessons/<lessonId>.md
 */
function inferSubjectFromPath(filePath: string): Subject | undefined {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const coursesIdx = parts.lastIndexOf('courses');
  if (coursesIdx >= 0 && coursesIdx + 1 < parts.length) {
    const subject = parts[coursesIdx + 1];
    if (subject && subject !== 'topics') {
      return subject;
    }
  }
  return undefined;
}

function inferTopicIdFromPath(filePath: string): string | undefined {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const topicsIdx = parts.lastIndexOf('topics');
  if (topicsIdx >= 0 && topicsIdx + 1 < parts.length) {
    return parts[topicsIdx + 1];
  }
  return undefined;
}

/** Take ±N lines around a target line as cursor context. */
function buildCursorContext(documentText: string, line: number, radius = CURSOR_CONTEXT_RADIUS): string {
  const lines = documentText.split(/\r?\n/);
  const start = Math.max(0, line - radius);
  const end = Math.min(lines.length, line + radius + 1);
  return lines.slice(start, end).join('\n');
}

interface InlineCommandArgs {
  /** Optional: when invoked from CodeLens, the heading line (0-indexed). */
  line?: number;
}

export function registerInlineEditCommands(
  context: vscode.ExtensionContext,
  ai: AIClient,
  prefs: PreferencesStore,
  courseProfileStore: CourseProfileStore,
  progressStore: ProgressStore,
  adaptiveEngine: AdaptiveEngine,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const courseManager = new CourseManager();

  // ----- helpers ---------------------------------------------------------------

  const buildCtx = async (filePath: string) => {
    const subject = inferSubjectFromPath(filePath);
    const topicId = inferTopicIdFromPath(filePath);

    const [preferences, profile, diagnosis, courseProfileCtx] = await Promise.all([
      prefs.get().catch(() => null),
      progressStore.getProfile().catch(() => null),
      subject ? adaptiveEngine.getLatestDiagnosis(subject).catch(() => null) : Promise.resolve(null),
      courseProfileStore.buildPromptContext(subject, topicId).catch(() => ({
        courseProfile: null,
        chapterProfile: null,
        profileEvidenceSummary: '',
      })),
    ]);

    let currentCourseTitle: string | undefined;
    let courseOutlineSummary: string | undefined;
    if (subject) {
      try {
        const outline = await courseManager.getCourseOutline(subject);
        if (outline) {
          currentCourseTitle = outline.title;
          courseOutlineSummary = outline.topics
            .map((topic) => {
              const lessonNames = topic.lessons.map((l) => `  - ${l.title}`).join('\n');
              return `- ${topic.title}\n${lessonNames}`;
            })
            .join('\n');
        }
      } catch {
        // best-effort; outline is purely contextual
      }
    }

    return {
      profile,
      preferences,
      diagnosis,
      courseProfile: courseProfileCtx.courseProfile,
      chapterProfile: courseProfileCtx.chapterProfile,
      profileEvidenceSummary: courseProfileCtx.profileEvidenceSummary,
      currentCourseTitle,
      courseOutlineSummary,
    };
  };

  const flashHighlight = (editor: vscode.TextEditor, range: vscode.Range) => {
    const deco = getHighlightDecoration();
    editor.setDecorations(deco, [range]);
    setTimeout(() => {
      try {
        editor.setDecorations(deco, []);
      } catch {
        // editor may have been closed; safe to ignore
      }
    }, HIGHLIGHT_DURATION_MS);
  };

  const stripFences = (text: string): string => {
    let result = text.trim();
    // Strip an outer ```...``` wrap only, not internal code blocks.
    const fenceMatch = result.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) {
      result = fenceMatch[1];
    }
    return result;
  };

  const runInlineEdit = async (args?: InlineCommandArgs, forceRewrite = false) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('请先打开一个讲义 markdown 文件再使用内联编辑。');
      return;
    }
    const filePath = editor.document.uri.fsPath;
    if (!isLecturePath(filePath)) {
      vscode.window.showWarningMessage('当前文件不是 ClaudeCoach 讲义（非 lessons 目录），无法使用内联编辑。');
      return;
    }

    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;

    if (forceRewrite && !hasSelection) {
      vscode.window.showWarningMessage('请先选中要重写的段落。');
      return;
    }

    const targetLine = !hasSelection && typeof args?.line === 'number'
      ? Math.max(0, Math.floor(args.line))
      : selection.active.line;

    const documentText = editor.document.getText();
    const selectionText = hasSelection ? editor.document.getText(selection) : '';

    const isRewrite = forceRewrite || hasSelection;
    const placeholder = isRewrite
      ? '说明你想怎么改这段（例如：用更直观的几何例子讲一遍）'
      : '告诉 AI 在这里要写什么（例如：补一个反例）';

    const instruction = await vscode.window.showInputBox({
      title: isRewrite ? 'ClaudeCoach: 重写选中段落' : 'ClaudeCoach: 在此处问 AI',
      prompt: placeholder,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length > 0 ? null : '请填写指令'),
    });

    if (!instruction || !instruction.trim()) {
      return;
    }

    const ctx = await buildCtx(filePath);

    let messages;
    if (isRewrite) {
      messages = inlineRewritePrompt({
        documentContext: documentText,
        selectionText,
        instruction: instruction.trim(),
        ctx,
      });
    } else {
      messages = inlineInsertPrompt({
        documentContext: documentText,
        cursorContext: buildCursorContext(documentText, targetLine),
        selectionText,
        instruction: instruction.trim(),
        ctx,
      });
    }

    const taskLabel = isRewrite ? '重写选中段落' : '生成内联补充';
    let aiOutput: string;
    try {
      const raw = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `ClaudeCoach: ${taskLabel}` },
        async () => ai.chatCompletion(messages, { temperature: AI_TEMPERATURE, maxTokens: AI_MAX_TOKENS }),
      );
      aiOutput = stripFences(raw);
    } catch (error) {
      vscode.window.showErrorMessage(`内联编辑失败：${(error as Error).message}`);
      return;
    }

    if (!aiOutput) {
      vscode.window.showWarningMessage('AI 没有返回任何内容。');
      return;
    }

    // Map to writeback. For insert (no selection), we anchor at the end of the
    // target line; for rewrite, we use the selection range.
    const sourceLineStart = isRewrite ? selection.start.line : targetLine;
    const sourceLineEnd = isRewrite ? selection.end.line : targetLine;
    const writebackSelection = isRewrite
      ? selectionText
      : (editor.document.lineAt(targetLine).text);

    const result = await applyInlineWriteback({
      filePath,
      selectionText: writebackSelection,
      sourceLineStart,
      sourceLineEnd,
      newContent: aiOutput,
      mode: isRewrite ? 'replace' : 'insertAfter',
    });

    if (!result.ok) {
      vscode.window.showErrorMessage(`内联编辑写回失败：${result.errorMessage ?? '未知错误'}`);
      return;
    }

    if (result.warning) {
      vscode.window.showWarningMessage(`内联编辑：${result.warning}`);
    }

    // After the file is rewritten on disk, VS Code will detect the external edit
    // and reload the document. Highlight the affected range once that lands.
    const applied = result.appliedRange;
    if (applied) {
      // Wait one tick for the document to refresh.
      setTimeout(() => {
        const refreshedEditor = vscode.window.visibleTextEditors.find(
          (ed) => ed.document.uri.fsPath === filePath,
        ) ?? editor;
        const lastLine = Math.min(applied.endLine, refreshedEditor.document.lineCount - 1);
        const start = new vscode.Position(applied.startLine, 0);
        const end = new vscode.Position(lastLine, refreshedEditor.document.lineAt(lastLine).text.length);
        flashHighlight(refreshedEditor, new vscode.Range(start, end));
      }, 200);
    }
  };

  // ----- commands --------------------------------------------------------------

  disposables.push(
    vscode.commands.registerCommand('claudeCoach.inlineEdit', (args?: InlineCommandArgs) => {
      void runInlineEdit(args, false);
    }),
  );

  disposables.push(
    vscode.commands.registerCommand('claudeCoach.inlineRewrite', () => {
      void runInlineEdit(undefined, true);
    }),
  );

  // ----- CodeLens provider -----------------------------------------------------

  const codeLensSelector: vscode.DocumentSelector = { language: 'markdown', scheme: 'file' };
  const codeLensProvider: vscode.CodeLensProvider = {
    provideCodeLenses(document) {
      if (!isLecturePath(document.uri.fsPath)) {
        return [];
      }
      const lenses: vscode.CodeLens[] = [];
      const text = document.getText();
      const lines = text.split(/\r?\n/);
      let inFence = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^```/.test(line.trim())) {
          inFence = !inFence;
          continue;
        }
        if (inFence) {
          continue;
        }
        if (/^(#{2,3})\s+\S/.test(line)) {
          const range = new vscode.Range(i, 0, i, Math.max(1, line.length));
          lenses.push(
            new vscode.CodeLens(range, {
              title: '在此处问 AI',
              command: 'claudeCoach.inlineEdit',
              arguments: [{ line: i }],
            }),
          );
        }
      }
      return lenses;
    },
  };

  disposables.push(vscode.languages.registerCodeLensProvider(codeLensSelector, codeLensProvider));

  for (const d of disposables) {
    context.subscriptions.push(d);
  }

  // Surface the helper functions so callers (tests / extension activate) can rely
  // on the same path-resolution logic. Re-export selected utilities here.
  return disposables;
}

// Re-export for callers that want to mount the same path-check rule.
export { isLecturePath } from './inlineWriteback';

// Reading file contents helper (currently unused publicly, kept for tests).
export async function readDocumentText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

// Tiny helper to build the standard storage-relative path label for a lecture file.
export function describeLecturePath(filePath: string): string {
  return path.basename(filePath);
}
