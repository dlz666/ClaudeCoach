import * as vscode from 'vscode';
import { getAIConfig, getDataDirectory } from './config';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ensureDir } from './utils/fileSystem';
import { AIProfileManager } from './ai/profileManager';

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

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const sidebarProvider = new SidebarProvider(context.extensionUri, aiProfiles, () => {
    void refreshStatusBar();
  });

  const refreshStatusBar = async () => {
    const resolved = await aiProfiles.resolveConfig();
    const sourceLabel = resolved.resolvedFrom === 'workspace' ? 'Workspace' : 'Global';
    statusBar.text = `$(hubot) ${resolved.model} / ${sourceLabel}`;
    statusBar.tooltip = [
      `Profile: ${resolved.profileName}`,
      `Provider: ${resolved.provider}`,
      `Model: ${resolved.model}`,
      `Base URL: ${resolved.effectiveBaseUrl}`,
      resolved.warnings.length ? `Warnings: ${resolved.warnings.join(', ')}` : 'Warnings: none',
    ].join('\n');
    statusBar.command = 'claudeCoach.revealAIConfigCard';
    statusBar.show();
  };

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
