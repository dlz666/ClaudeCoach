import * as vscode from 'vscode';
import { getAIConfig, getDataDirectory } from './config';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ensureDir } from './utils/fileSystem';
import { AIProfileManager } from './ai/profileManager';

async function showProfileSwitcher(aiProfiles: AIProfileManager, sidebarProvider: SidebarProvider, refreshStatusBar: () => Promise<void>) {
  const [state, resolved, workspaceOverride] = await Promise.all([
    aiProfiles.getState(),
    aiProfiles.resolveConfig(),
    aiProfiles.getWorkspaceOverride(),
  ]);

  const items: Array<vscode.QuickPickItem & { action?: string; profileId?: string }> = [
    {
      label: '$(settings-gear) 打开 AI 配置中心',
      description: '在侧边栏设置页查看和编辑配置',
      action: 'open-settings',
    },
    {
      label: workspaceOverride.enabled ? '$(layers-dot) 关闭项目级覆盖' : '$(layers-active) 启用项目级覆盖',
      description: workspaceOverride.enabled
        ? `当前使用项目覆盖，基于 ${resolved.profileName}`
        : `当前直接使用全局配置 ${resolved.profileName}`,
      action: 'toggle-workspace',
    },
    ...state.profiles.map(profile => ({
      label: profile.id === state.activeProfileId ? `$(check) ${profile.name}` : profile.name,
      description: `${profile.provider} · ${profile.model}`,
      detail: profile.id === state.activeProfileId ? '当前全局激活配置' : '切换为该全局配置',
      profileId: profile.id,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '切换 ClaudeCoach AI 配置',
  });

  if (!picked) {
    return;
  }

  if (picked.action === 'open-settings') {
    sidebarProvider.sendCommand({ type: 'activateTab', tab: 'settings', focus: 'ai' });
    return;
  }

  if (picked.action === 'toggle-workspace') {
    await aiProfiles.saveWorkspaceOverride({
      ...workspaceOverride,
      enabled: !workspaceOverride.enabled,
      baseProfileId: workspaceOverride.baseProfileId || state.activeProfileId,
    });
    await sidebarProvider.refreshAIConfigState();
    await refreshStatusBar();
    return;
  }

  if (picked.profileId) {
    await aiProfiles.activateProfile(picked.profileId);
    await sidebarProvider.refreshAIConfigState();
    await refreshStatusBar();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const dataDir = getDataDirectory();
  await ensureDir(dataDir);

  const aiProfiles = new AIProfileManager();
  await aiProfiles.getState();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'claudeCoach.switchAIProfile';
  context.subscriptions.push(statusBar);

  let sidebarProvider: SidebarProvider;
  const refreshStatusBar = async () => {
    const resolved = await aiProfiles.resolveConfig();
    const sourceLabel = resolved.resolvedFrom === 'workspace' ? 'Workspace' : 'Global';
    statusBar.text = `$(hubot) ${resolved.profileName} / ${sourceLabel}`;
    statusBar.tooltip = [
      `Provider: ${resolved.provider}`,
      `Model: ${resolved.model}`,
      `Base URL: ${resolved.effectiveBaseUrl}`,
      resolved.warnings.length ? `Warnings: ${resolved.warnings.join('，')}` : 'Warnings: none',
    ].join('\n');
    statusBar.show();
  };

  sidebarProvider = new SidebarProvider(context.extensionUri, aiProfiles, () => {
    void refreshStatusBar();
  });

  const resolved = await getAIConfig();
  if (!resolved.apiToken) {
    const action = await vscode.window.showWarningMessage(
      'ClaudeCoach: 当前 AI 配置缺少 API Token，请在设置页的 AI 配置中心完善。',
      '打开设置页'
    );
    if (action === '打开设置页') {
      sidebarProvider.sendCommand({ type: 'activateTab', tab: 'settings', focus: 'ai' });
    }
  }

  await refreshStatusBar();

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
    vscode.commands.registerCommand('claudeCoach.switchAIProfile', async () => {
      await showProfileSwitcher(aiProfiles, sidebarProvider, refreshStatusBar);
    }),
    vscode.commands.registerCommand('claudeCoach.openAIConfigCenter', () => {
      sidebarProvider.sendCommand({ type: 'activateTab', tab: 'settings', focus: 'ai' });
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
    vscode.commands.registerCommand('claudeCoach.exportAIProfile', async () => {
      try {
        const state = await aiProfiles.getState();
        await aiProfiles.exportProfile(state.activeProfileId, false);
        vscode.window.showInformationMessage('当前 AI 配置已导出。');
      } catch (error: any) {
        vscode.window.showErrorMessage(`导出失败: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand('claudeCoach.testAIProfile', async () => {
      try {
        const message = await aiProfiles.testResolvedConfig();
        vscode.window.showInformationMessage(message);
      } catch (error: any) {
        vscode.window.showErrorMessage(`测试失败: ${error?.message || error}`);
      }
    }),
  );
}

export function deactivate() {}
