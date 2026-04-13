import * as vscode from 'vscode';
import { AIConfig, APIProvider, ResolvedAIConfig } from './types';
import { getStoragePathResolver } from './storage/pathResolver';

export function getLegacyAIConfig(): AIConfig {
  const config = vscode.workspace.getConfiguration('claudeCoach');
  return {
    provider: config.get<APIProvider>('apiProvider', 'openai'),
    baseUrl: config.get<string>('apiBaseUrl', 'https://api.openai.com/v1'),
    anthropicBaseUrl: config.get<string>('anthropicBaseUrl', 'https://api.anthropic.com'),
    apiToken: config.get<string>('apiToken', ''),
    model: config.get<string>('model', 'gpt-4o'),
    wireApi: 'chat_completions',
    maxTokens: config.get<number>('maxTokens', 4096),
    contextWindow: config.get<number>('modelContextWindow', 128000),
  };
}

export async function getAIConfig(): Promise<ResolvedAIConfig> {
  const { AIProfileManager } = await import('./ai/profileManager');
  return new AIProfileManager().resolveConfig();
}

export function getDataDirectory(): string {
  return getStoragePathResolver().storageRoot;
}
