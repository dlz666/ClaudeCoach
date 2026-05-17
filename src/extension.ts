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
import { CourseManager } from './courses/courseManager';
import { MaterialManager } from './materials/materialManager';
import { VectorIndex } from './materials/vectorIndex';
import { HybridRetriever } from './materials/hybridRetriever';
import { EmbeddingClient } from './ai/embeddingClient';

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
  const materialManager = new MaterialManager();

  // ===== Hybrid RAG（向量检索）依赖注入 =====
  // EmbeddingClient 每次拿 profile 都从 prefs 读最新值，所以用户改设置不需要重启
  const embeddingClient = new EmbeddingClient(async () => {
    const prefs = await preferencesStore.get();
    const cfg = prefs.retrieval?.embedding;
    if (!cfg || !cfg.enabled || !cfg.baseUrl || !cfg.apiToken || !cfg.model) {
      return null;
    }
    return {
      enabled: true,
      baseUrl: cfg.baseUrl,
      apiToken: cfg.apiToken,
      model: cfg.model,
      dimension: cfg.dimension,
    };
  });
  const vectorIndex = new VectorIndex();
  const hybridRetriever = new HybridRetriever(embeddingClient, vectorIndex);
  materialManager.setHybridDeps({
    embeddingClient,
    vectorIndex,
    hybridRetriever,
    getConfig: async () => {
      const prefs = await preferencesStore.get();
      const cfg = prefs.retrieval?.embedding;
      if (!cfg || !cfg.enabled) return null;
      return {
        enabled: true,
        hybridWeight: typeof cfg.hybridWeight === 'number' ? cfg.hybridWeight : 0.5,
        model: cfg.model || 'BAAI/bge-m3',
        dimension: cfg.dimension || 1024,
      };
    },
    // Vision 配置：每次读最新（用户改设置不需重启）
    getVisionConfig: async () => {
      const prefs = await preferencesStore.get();
      const cfg = prefs.retrieval?.vision;
      if (!cfg || !cfg.enabled || !cfg.baseUrl || !cfg.apiToken || !cfg.model) {
        return null;
      }
      return {
        enabled: true,
        baseUrl: cfg.baseUrl,
        apiToken: cfg.apiToken,
        model: cfg.model,
        concurrency: cfg.concurrency,
        dpi: cfg.dpi,
        maxTokens: cfg.maxTokens,
      };
    },
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    aiProfiles,
    () => { void refreshStatusBar(); },
    // 重要：复用 extension.ts 创建（已 setHybridDeps）的 materialManager 实例。
    // 否则 SidebarProvider 会自己 new 一个 MaterialManager，没有 hybrid 依赖，
    // 所有资料的向量化状态读出来都是 false（即便磁盘上 vector-index.json 已存在）。
    materialManager,
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
  if (!resolved.apiToken && resolved.provider !== 'claude_code_cli') {
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
