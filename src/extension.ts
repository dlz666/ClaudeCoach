import * as vscode from 'vscode';
import { getAIConfig, getDataDirectory } from './config';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ensureDir } from './utils/fileSystem';
import { AIProfileManager } from './ai/profileManager';
import { AIClient } from './ai/client';
import { PreferencesStore } from './progress/preferencesStore';
import { ProgressStore } from './progress/progressStore';
import { AdaptiveEngine } from './progress/adaptiveEngine';
import { CourseProfileStore } from './progress/courseProfileStore';
import { LectureWebviewProvider } from './coach/lectureWebviewProvider';
import { registerInlineEditCommands } from './coach/inlineEdit';
import { CoachAgent } from './coach/coachAgent';
import { CoachEventBus } from './coach/coachEventBus';
import { CoachStateStore } from './coach/coachState';
import { SuggestionStore } from './coach/suggestionStore';
import { SessionLogger } from './coach/sessionLogger';
import { LearningPlanStore } from './coach/learningPlanStore';
import { CourseManager } from './courses/courseManager';
import { getStoragePathResolver } from './storage/pathResolver';

async function revealAIConfigCard(sidebarProvider: SidebarProvider): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.claude-coach');
  await new Promise((resolve) => setTimeout(resolve, 50));
  sidebarProvider.sendCommand({ type: 'activateTab', tab: 'settings', focus: 'ai' });
}

export async function activate(context: vscode.ExtensionContext) {
  const dataDir = getDataDirectory();
  await ensureDir(dataDir);

  const aiProfiles = new AIProfileManager();
  await aiProfiles.getState();

  // ===== 共享 store / engine =====
  const ai = new AIClient();
  const preferencesStore = new PreferencesStore();
  const progressStore = new ProgressStore();
  const adaptiveEngine = new AdaptiveEngine();
  const courseProfileStore = new CourseProfileStore();
  const courseManager = new CourseManager();

  // ===== Coach 框架 =====
  const paths = getStoragePathResolver();
  const coachEventBus = new CoachEventBus();
  const coachStateStore = new CoachStateStore(paths);
  const suggestionStore = new SuggestionStore(paths);
  const sessionLogger = new SessionLogger(paths, coachEventBus);
  const learningPlanStore = new LearningPlanStore(paths);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    aiProfiles,
    () => { void refreshStatusBar(); },
    {
      coachEventBus,
      coachStateStore,
      suggestionStore,
      sessionLogger,
      learningPlanStore,
    },
  );

  const refreshStatusBar = async () => {
    const resolved = await aiProfiles.resolveConfig();
    const sourceLabel = resolved.resolvedFrom === 'workspace' ? 'Workspace' : 'Global';
    statusBar.text = `$(hubot) ${resolved.model} / ${sourceLabel}`;
    statusBar.tooltip = [
      `Profile: ${resolved.profileName}`,
      `Provider: ${resolved.provider}`,
      `Wire API: ${resolved.wireApi ?? 'chat_completions'}`,
      `Model: ${resolved.model}`,
      `Base URL: ${resolved.effectiveBaseUrl}`,
      resolved.warnings.length ? `Warnings: ${resolved.warnings.join(', ')}` : 'Warnings: none',
    ].join('\n');
    statusBar.command = 'claudeCoach.revealAIConfigCard';
    statusBar.show();
  };

  // ===== CoachAgent 启动 =====
  const coachAgent = new CoachAgent({
    bus: coachEventBus,
    prefs: preferencesStore,
    state: coachStateStore,
    suggestions: suggestionStore,
    sessions: sessionLogger,
    plans: learningPlanStore,
    courseManager,
    courseProfileStore,
    adaptiveEngine,
    ai,
    postToSidebar: (msg) => sidebarProvider.postMessage(msg),
    showToast: (level, message) => {
      if (level === 'error') vscode.window.showErrorMessage(message);
      else if (level === 'warn') vscode.window.showWarningMessage(message);
      else vscode.window.showInformationMessage(message);
    },
  });
  coachAgent.start();
  sidebarProvider.attachCoachAgent(coachAgent);
  context.subscriptions.push(coachAgent);

  // ===== 讲义自渲染 webview provider =====
  LectureWebviewProvider.register(context, context.extensionUri, {
    ai,
    preferencesStore,
    progressStore,
    adaptiveEngine,
    courseProfileStore,
  });

  // ===== Inline 编辑命令（Alt+I / 右键 / CodeLens） =====
  for (const disposable of registerInlineEditCommands(
    context,
    ai,
    preferencesStore,
    courseProfileStore,
    progressStore,
    adaptiveEngine,
  )) {
    context.subscriptions.push(disposable);
  }

  // ===== 编辑器活动监听（接通 idle 检测） =====
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const fsPath = event.document.uri.fsPath;
      if (!fsPath.toLowerCase().endsWith('.md')) return;
      coachEventBus.emit({
        kind: 'editor-typing',
        at: new Date().toISOString(),
        meta: { filePath: fsPath, changes: event.contentChanges.length },
      });
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeCoach.sidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('claudeCoach.workspaceAI')) {
        void refreshStatusBar();
        void sidebarProvider.refreshAIConfigState();
      }
    }),
    vscode.commands.registerCommand('claudeCoach.revealAIConfigCard', async () => {
      await revealAIConfigCard(sidebarProvider);
    }),
    vscode.commands.registerCommand('claudeCoach.generateCourse', () => {
      sidebarProvider.sendCommand({ type: 'triggerGenerateCourse' });
    }),
    vscode.commands.registerCommand('claudeCoach.generateLesson', () => {
      sidebarProvider.sendCommand({ type: 'triggerGenerateLesson' });
    }),
    vscode.commands.registerCommand('claudeCoach.generateExercises', () => {
      sidebarProvider.sendCommand({ type: 'triggerGenerateExercises' });
    }),
    vscode.commands.registerCommand('claudeCoach.gradeAnswer', () => {
      sidebarProvider.sendCommand({ type: 'triggerGradeAnswer' });
    }),
    vscode.commands.registerCommand('claudeCoach.showDiagnosis', () => {
      sidebarProvider.sendCommand({ type: 'triggerDiagnosis' });
    }),
    vscode.commands.registerCommand('claudeCoach.importMaterial', () => {
      sidebarProvider.sendCommand({ type: 'triggerImportMaterial' });
    }),
    vscode.commands.registerCommand('claudeCoach.coachOpenPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claude-coach');
      sidebarProvider.sendCommand({ type: 'activateTab', tab: 'learn', focus: 'coach' });
    }),
    vscode.commands.registerCommand('claudeCoach.coachDoNotDisturb', async () => {
      await coachStateStore.setDoNotDisturb(new Date(Date.now() + 60 * 60 * 1000).toISOString());
      vscode.window.showInformationMessage('ClaudeCoach: 已勿扰 1 小时。');
    }),
    vscode.commands.registerCommand('claudeCoach.syncFromClaude', async () => {
      try {
        await aiProfiles.importProfile('claude', { activate: true });
        await sidebarProvider.refreshAIConfigState();
        await refreshStatusBar();
        vscode.window.showInformationMessage('已从 .claude 导入并激活 AI 配置。');
      } catch (error: any) {
        vscode.window.showErrorMessage(`同步失败: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand('claudeCoach.syncFromCodex', async () => {
      try {
        await aiProfiles.importProfile('codex', { activate: true });
        await sidebarProvider.refreshAIConfigState();
        await refreshStatusBar();
        vscode.window.showInformationMessage('已从 .codex 导入并激活 AI 配置。');
      } catch (error: any) {
        vscode.window.showErrorMessage(`同步失败: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand('claudeCoach.importAIProfile', async () => {
      try {
        await aiProfiles.importProfile('package', { activate: false });
        await sidebarProvider.refreshAIConfigState();
        await refreshStatusBar();
        vscode.window.showInformationMessage('AI 配置包导入完成。');
      } catch (error: any) {
        if (String(error?.message || '').includes('已取消')) {
          return;
        }
        vscode.window.showErrorMessage(`导入失败: ${error?.message || error}`);
      }
    }),
  );

  await refreshStatusBar();

  const resolved = await getAIConfig();
  if (!resolved.apiToken) {
    const action = await vscode.window.showWarningMessage(
      'ClaudeCoach: 当前 AI 配置缺少 API Token，请在设置页查看当前模型配置。',
      '打开设置页',
    );
    if (action === '打开设置页') {
      await revealAIConfigCard(sidebarProvider);
    }
  }
}

export function deactivate() {}
