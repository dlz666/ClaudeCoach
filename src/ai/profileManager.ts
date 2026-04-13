import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AIImportPreview,
  AIImportSource,
  AIProfile,
  AIProfilesState,
  AIWorkspaceOverride,
  ResolvedAIConfig,
} from '../types';
import { AIClient } from './client';
import { createBudget } from './tokenBudget';
import { ensureDir, fileExists, readJson, writeJson } from '../utils/fileSystem';
import { getLegacyAIConfig } from '../config';
import { getStoragePathResolver } from '../storage/pathResolver';

const AI_PROFILES_VERSION = 1;

interface ClaudeSettings {
  env?: Record<string, string>;
}

interface CodexProviderConfig {
  baseUrl?: string;
  wireApi?: 'chat_completions' | 'responses';
}

interface ExportedAIProfilePackage {
  schemaVersion: number;
  type: 'claudecoach-ai-profile';
  exportedAt: string;
  includeToken: boolean;
  profile: Partial<AIProfile> & Pick<AIProfile, 'name' | 'provider' | 'baseUrl' | 'anthropicBaseUrl' | 'model' | 'contextWindow' | 'source'>;
}

export class AIProfileManager {
  private readonly paths = getStoragePathResolver();

  private get profilesPath(): string {
    return this.paths.appAIProfilesPath;
  }

  async getState(): Promise<AIProfilesState> {
    const raw = await readJson<AIProfilesState>(this.profilesPath);
    if (raw && Array.isArray(raw.profiles) && raw.profiles.length > 0) {
      const normalized: AIProfilesState = {
        version: AI_PROFILES_VERSION,
        activeProfileId: raw.activeProfileId,
        profiles: raw.profiles.map((profile, index) => this.normalizeProfile(profile, index)),
      };

      if (!normalized.profiles.some(profile => profile.id === normalized.activeProfileId)) {
        normalized.activeProfileId = normalized.profiles[0].id;
        await this.saveState(normalized);
      }

      return normalized;
    }

    const legacy = await readJson<AIProfilesState>(this.paths.legacyAIProfilesPath);
    if (legacy && Array.isArray(legacy.profiles) && legacy.profiles.length > 0) {
      const migrated: AIProfilesState = {
        version: AI_PROFILES_VERSION,
        activeProfileId: legacy.activeProfileId,
        profiles: legacy.profiles.map((profile, index) => this.normalizeProfile(profile, index)),
      };
      if (!migrated.profiles.some(profile => profile.id === migrated.activeProfileId)) {
        migrated.activeProfileId = migrated.profiles[0].id;
      }
      await this.saveState(migrated);
      return migrated;
    }

    const initial = this.createInitialState();
    await this.saveState(initial);
    return initial;
  }

  async saveState(state: AIProfilesState): Promise<void> {
    const normalized: AIProfilesState = {
      version: AI_PROFILES_VERSION,
      activeProfileId: state.activeProfileId,
      profiles: state.profiles.map((profile, index) => this.normalizeProfile(profile, index)),
    };

    if (!normalized.profiles.some(profile => profile.id === normalized.activeProfileId)) {
      normalized.activeProfileId = normalized.profiles[0]?.id ?? this.createDefaultProfile().id;
    }

    await ensureDir(path.dirname(this.profilesPath));
    await writeJson(this.profilesPath, normalized);
  }

  async getWorkspaceOverride(): Promise<AIWorkspaceOverride> {
    const fileOverride = await readJson<AIWorkspaceOverride>(this.paths.workspaceAIOverridePath);
    if (fileOverride) {
      return this.normalizeWorkspaceOverride(fileOverride);
    }

    const config = vscode.workspace.getConfiguration('claudeCoach');
    const raw = config.get<AIWorkspaceOverride>('workspaceAI');
    const normalized = this.normalizeWorkspaceOverride(raw);
    if (raw) {
      await writeJson(this.paths.workspaceAIOverridePath, normalized);
    }
    return normalized;
  }

  async saveWorkspaceOverride(override: AIWorkspaceOverride): Promise<AIWorkspaceOverride> {
    const normalized = this.normalizeWorkspaceOverride(override);
    await writeJson(this.paths.workspaceAIOverridePath, normalized);
    const config = vscode.workspace.getConfiguration('claudeCoach');
    const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config.update('workspaceAI', normalized, target);
    return normalized;
  }

  async listProfiles(): Promise<AIProfile[]> {
    const state = await this.getState();
    return state.profiles;
  }

  async getProfile(profileId: string): Promise<AIProfile | null> {
    const state = await this.getState();
    return state.profiles.find(profile => profile.id === profileId) ?? null;
  }

  async saveProfile(input: Partial<AIProfile> & Pick<AIProfile, 'name' | 'provider' | 'baseUrl' | 'anthropicBaseUrl' | 'apiToken' | 'model' | 'contextWindow' | 'maxTokens' | 'source'>): Promise<AIProfile> {
    const state = await this.getState();
    const existingIndex = input.id ? state.profiles.findIndex(profile => profile.id === input.id) : -1;
    const now = new Date().toISOString();
    const existing = existingIndex >= 0 ? state.profiles[existingIndex] : undefined;

    const profile = this.normalizeProfile({
      ...existing,
      ...input,
      id: existing?.id ?? this.createProfileId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }, existingIndex >= 0 ? existingIndex : state.profiles.length);

    if (existingIndex >= 0) {
      state.profiles[existingIndex] = profile;
    } else {
      state.profiles.push(profile);
      if (!state.activeProfileId) {
        state.activeProfileId = profile.id;
      }
    }

    await this.saveState(state);
    return profile;
  }

  async duplicateProfile(profileId: string): Promise<AIProfile> {
    const profile = await this.getProfile(profileId);
    if (!profile) {
      throw new Error('未找到要复制的 AI 配置。');
    }

    return this.saveProfile({
      ...profile,
      id: undefined,
      name: `${profile.name} 副本`,
      source: 'manual',
    });
  }

  async deleteProfile(profileId: string): Promise<void> {
    const state = await this.getState();
    if (state.profiles.length <= 1) {
      throw new Error('至少需要保留一个 AI 配置。');
    }

    const nextProfiles = state.profiles.filter(profile => profile.id !== profileId);
    if (nextProfiles.length === state.profiles.length) {
      return;
    }

    state.profiles = nextProfiles;
    if (state.activeProfileId === profileId) {
      state.activeProfileId = nextProfiles[0].id;
    }
    await this.saveState(state);

    const workspaceOverride = await this.getWorkspaceOverride();
    if (workspaceOverride.baseProfileId === profileId) {
      workspaceOverride.baseProfileId = state.activeProfileId;
      workspaceOverride.enabled = false;
      await this.saveWorkspaceOverride(workspaceOverride);
    }
  }

  async activateProfile(profileId: string): Promise<void> {
    const state = await this.getState();
    if (!state.profiles.some(profile => profile.id === profileId)) {
      throw new Error('未找到要激活的 AI 配置。');
    }
    state.activeProfileId = profileId;
    await this.saveState(state);
  }

  async resolveConfig(): Promise<ResolvedAIConfig> {
    const state = await this.getState();
    const workspaceOverride = await this.getWorkspaceOverride();
    const activeProfile = state.profiles.find(profile => profile.id === state.activeProfileId) ?? state.profiles[0];
    const hasBaseProfile = workspaceOverride.baseProfileId
      ? state.profiles.some(profile => profile.id === workspaceOverride.baseProfileId)
      : false;
    const normalizedOverride = (workspaceOverride.enabled && workspaceOverride.baseProfileId && !hasBaseProfile)
      ? { ...workspaceOverride, enabled: false, baseProfileId: activeProfile.id }
      : workspaceOverride;
    if (normalizedOverride !== workspaceOverride) {
      await this.saveWorkspaceOverride(normalizedOverride);
    }
    const baseProfile = workspaceOverride.baseProfileId
      ? state.profiles.find(profile => profile.id === normalizedOverride.baseProfileId) ?? activeProfile
      : activeProfile;
    const overrideValues = normalizedOverride.enabled ? (normalizedOverride.overrides ?? {}) : {};

    const resolvedProfile: AIProfile = this.normalizeProfile({
      ...baseProfile,
      ...overrideValues,
      id: baseProfile.id,
      name: baseProfile.name,
      source: baseProfile.source,
      createdAt: baseProfile.createdAt,
      updatedAt: baseProfile.updatedAt,
    }, 0);

    const effectiveBaseUrl = resolvedProfile.provider === 'anthropic'
      ? resolvedProfile.anthropicBaseUrl
      : resolvedProfile.baseUrl;
    const warnings = this.collectWarnings(resolvedProfile, effectiveBaseUrl);
    const budget = createBudget(resolvedProfile.contextWindow, '');

    return {
      provider: resolvedProfile.provider,
      baseUrl: resolvedProfile.baseUrl,
      anthropicBaseUrl: resolvedProfile.anthropicBaseUrl,
      apiToken: resolvedProfile.apiToken,
      model: resolvedProfile.model,
      wireApi: resolvedProfile.wireApi,
      reasoningEffort: resolvedProfile.reasoningEffort,
      maxTokens: resolvedProfile.maxTokens,
      contextWindow: resolvedProfile.contextWindow,
      profileId: baseProfile.id,
      profileName: baseProfile.name,
      profileSource: baseProfile.source,
      resolvedFrom: normalizedOverride.enabled ? 'workspace' : 'global',
      warnings,
      effectiveBaseUrl,
      availableHistoryTokens: budget.availableForHistory,
    };
  }

  async importProfile(source: AIImportSource, options?: { activate?: boolean }): Promise<AIImportPreview> {
    let importedProfile: AIProfile;

    switch (source) {
      case 'claude':
        importedProfile = await this.importFromClaude();
        break;
      case 'codex':
        importedProfile = await this.importFromCodex();
        break;
      case 'package':
        importedProfile = await this.importFromPackage();
        break;
      default:
        throw new Error('暂不支持该导入来源。');
    }

    if (options?.activate) {
      await this.activateProfile(importedProfile.id);
    }

    return {
      profile: importedProfile,
      importedFrom: source,
      activated: !!options?.activate,
    };
  }

  async exportProfile(profileId: string, includeToken = false): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) {
      throw new Error('未找到要导出的 AI 配置。');
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${this.slugify(profile.name)}.json`)),
      filters: {
        'ClaudeCoach AI Profile': ['json'],
      },
      saveLabel: '导出 AI 配置',
    });

    if (!uri) {
      return;
    }

    const payload: ExportedAIProfilePackage = {
      schemaVersion: 1,
      type: 'claudecoach-ai-profile',
      exportedAt: new Date().toISOString(),
      includeToken,
      profile: {
        name: profile.name,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        anthropicBaseUrl: profile.anthropicBaseUrl,
        apiToken: includeToken ? profile.apiToken : '',
        model: profile.model,
        wireApi: profile.wireApi,
        reasoningEffort: profile.reasoningEffort,
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxTokens,
        notes: profile.notes,
        source: 'package',
      },
    };

    await fs.promises.writeFile(uri.fsPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  async testResolvedConfig(profile?: Partial<AIProfile>): Promise<string> {
    const resolved = profile
      ? this.resolveCandidateProfile(profile)
      : await this.resolveConfig();

    const effectiveBaseUrl = resolved.provider === 'anthropic' ? resolved.anthropicBaseUrl : resolved.baseUrl;
    if (!resolved.apiToken) {
      throw new Error('当前配置缺少 API Token。');
    }
    if (!/^https?:\/\//.test(effectiveBaseUrl)) {
      throw new Error('当前配置的 Base URL 无效。');
    }

    const client = new AIClient({
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      anthropicBaseUrl: resolved.anthropicBaseUrl,
      apiToken: resolved.apiToken,
      model: resolved.model,
      wireApi: resolved.wireApi,
      reasoningEffort: resolved.reasoningEffort,
      maxTokens: Math.min(resolved.maxTokens ?? 32, 32),
      contextWindow: resolved.contextWindow,
    });

    const reply = await client.chatCompletion([
      { role: 'user', content: 'Reply with OK only.' },
    ], { temperature: 0, maxTokens: 16 });

    return `连接测试成功：${resolved.profileName ?? resolved.model} -> ${reply.trim()}`;
  }

  private createInitialState(): AIProfilesState {
    const profile = this.createDefaultProfile();
    return {
      version: AI_PROFILES_VERSION,
      activeProfileId: profile.id,
      profiles: [profile],
    };
  }

  private createDefaultProfile(): AIProfile {
    const legacy = getLegacyAIConfig();
    const now = new Date().toISOString();
    return {
      id: this.createProfileId(),
      name: legacy.model ? `${legacy.model} 默认配置` : '默认配置',
      provider: legacy.provider,
      baseUrl: legacy.baseUrl,
      anthropicBaseUrl: legacy.anthropicBaseUrl,
      apiToken: legacy.apiToken,
      model: legacy.model,
      wireApi: legacy.wireApi ?? 'chat_completions',
      reasoningEffort: legacy.reasoningEffort,
      contextWindow: legacy.contextWindow,
      maxTokens: legacy.maxTokens ?? 4096,
      notes: '从旧版单套 ClaudeCoach AI 配置自动迁移。',
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    };
  }

  private normalizeProfile(input: Partial<AIProfile>, index: number): AIProfile {
    const fallback = this.createDefaultProfile();
    const now = new Date().toISOString();
    return {
      id: input.id || `profile-${Date.now()}-${index}`,
      name: input.name?.trim() || `AI 配置 ${index + 1}`,
      provider: input.provider === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: input.baseUrl?.trim() || fallback.baseUrl,
      anthropicBaseUrl: input.anthropicBaseUrl?.trim() || fallback.anthropicBaseUrl,
      apiToken: input.apiToken ?? '',
      model: input.model?.trim() || fallback.model,
      wireApi: this.normalizeWireApi(input.wireApi, fallback.wireApi),
      reasoningEffort: input.reasoningEffort?.trim() || fallback.reasoningEffort,
      contextWindow: Number.isFinite(input.contextWindow) ? Number(input.contextWindow) : fallback.contextWindow,
      maxTokens: Number.isFinite(input.maxTokens) ? Number(input.maxTokens) : (fallback.maxTokens ?? 4096),
      notes: input.notes?.trim() || '',
      source: input.source ?? 'manual',
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };
  }

  private normalizeWorkspaceOverride(input: AIWorkspaceOverride | undefined): AIWorkspaceOverride {
    return {
      enabled: !!input?.enabled,
      baseProfileId: input?.baseProfileId || undefined,
      overrides: {
        provider: input?.overrides?.provider === 'anthropic' ? 'anthropic' : input?.overrides?.provider,
        baseUrl: input?.overrides?.baseUrl?.trim() || undefined,
        anthropicBaseUrl: input?.overrides?.anthropicBaseUrl?.trim() || undefined,
        apiToken: input?.overrides?.apiToken ?? undefined,
        model: input?.overrides?.model?.trim() || undefined,
        wireApi: this.normalizeWireApi(input?.overrides?.wireApi, undefined),
        reasoningEffort: input?.overrides?.reasoningEffort?.trim() || undefined,
        contextWindow: Number.isFinite(input?.overrides?.contextWindow) ? Number(input?.overrides?.contextWindow) : undefined,
        maxTokens: Number.isFinite(input?.overrides?.maxTokens) ? Number(input?.overrides?.maxTokens) : undefined,
        notes: input?.overrides?.notes?.trim() || undefined,
      },
    };
  }

  private collectWarnings(profile: AIProfile, effectiveBaseUrl: string): string[] {
    const warnings: string[] = [];
    if (!profile.apiToken) {
      warnings.push('缺少 API Token');
    }
    if (!/^https?:\/\//.test(effectiveBaseUrl)) {
      warnings.push('Base URL 看起来无效');
    }
    const budget = createBudget(profile.contextWindow, '');
    if (budget.availableForHistory <= 0) {
      warnings.push('历史上下文预算过低');
    } else if (budget.availableForHistory < 4000) {
      warnings.push('历史上下文预算受限');
    }
    return warnings;
  }

  private resolveCandidateProfile(profile: Partial<AIProfile>): ResolvedAIConfig {
    const normalized = this.normalizeProfile({
      ...this.createDefaultProfile(),
      ...profile,
    }, 0);
    const effectiveBaseUrl = normalized.provider === 'anthropic' ? normalized.anthropicBaseUrl : normalized.baseUrl;
    const budget = createBudget(normalized.contextWindow, '');
    return {
      provider: normalized.provider,
      baseUrl: normalized.baseUrl,
      anthropicBaseUrl: normalized.anthropicBaseUrl,
      apiToken: normalized.apiToken,
      model: normalized.model,
      wireApi: normalized.wireApi,
      reasoningEffort: normalized.reasoningEffort,
      maxTokens: normalized.maxTokens,
      contextWindow: normalized.contextWindow,
      profileId: normalized.id,
      profileName: normalized.name,
      profileSource: normalized.source,
      resolvedFrom: 'global',
      warnings: this.collectWarnings(normalized, effectiveBaseUrl),
      effectiveBaseUrl,
      availableHistoryTokens: budget.availableForHistory,
    };
  }

  private async importFromClaude(): Promise<AIProfile> {
    const configPath = this.expandTilde('~/.claude/settings.json');
    if (!fs.existsSync(configPath)) {
      throw new Error('未找到 ~/.claude/settings.json');
    }

    const settings: ClaudeSettings = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const env = settings.env ?? {};
    const baseUrl = env.ANTHROPIC_BASE_URL
      ? env.ANTHROPIC_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1'
      : 'https://api.openai.com/v1';

    return this.saveProfile({
      name: env.ANTHROPIC_MODEL ? `${env.ANTHROPIC_MODEL} (.claude)` : 'Claude 导入配置',
      provider: 'openai',
      baseUrl,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiToken: env.ANTHROPIC_AUTH_TOKEN || '',
      model: env.ANTHROPIC_MODEL || 'gpt-4o',
      wireApi: 'chat_completions',
      contextWindow: 128000,
      maxTokens: 4096,
      notes: '从 ~/.claude/settings.json 导入。',
      source: 'claude',
    });
  }

  private async importFromCodex(): Promise<AIProfile> {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(configPath)) {
      throw new Error('未找到 ~/.codex/config.toml');
    }

    const toml = fs.readFileSync(configPath, 'utf-8');
    const modelProvider = this.parseTomlString(toml, 'model_provider');
    const providerConfig = this.parseCodexProviderConfig(toml, modelProvider);
    const model = this.parseTomlString(toml, 'model') || 'gpt-4o';
    const reasoningEffort = this.parseTomlString(toml, 'model_reasoning_effort');
    let apiKey = '';

    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      apiKey = auth.OPENAI_API_KEY ?? auth.openai_api_key ?? '';
    }

    return this.saveProfile({
      name: model ? `${model} (.codex)` : 'Codex 导入配置',
      provider: 'openai',
      baseUrl: providerConfig.baseUrl || 'https://api.openai.com/v1',
      anthropicBaseUrl: 'https://api.anthropic.com',
      apiToken: apiKey,
      model,
      wireApi: providerConfig.wireApi ?? 'chat_completions',
      reasoningEffort,
      contextWindow: 128000,
      maxTokens: 4096,
      notes: '从 ~/.codex/config.toml 与 auth.json 导入。',
      source: 'codex',
    });
  }

  private async importFromPackage(): Promise<AIProfile> {
    const [uri] = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'ClaudeCoach AI Profile': ['json'],
      },
      openLabel: '导入 JSON 配置',
      title: '选择要导入的 JSON AI 配置文件',
    }) ?? [];

    if (!uri) {
      throw new Error('已取消导入 AI 配置。');
    }

    const rawText = await fs.promises.readFile(uri.fsPath, 'utf-8');
    const parsed = JSON.parse(rawText) as ExportedAIProfilePackage | Partial<AIProfile>;
    const profileData = (parsed as ExportedAIProfilePackage).profile ?? parsed;

    if (!profileData.name || !profileData.provider || !profileData.model) {
      throw new Error('AI 配置包格式无效。');
    }

    return this.saveProfile({
      name: `${profileData.name} (导入)`,
      provider: profileData.provider,
      baseUrl: profileData.baseUrl || 'https://api.openai.com/v1',
      anthropicBaseUrl: profileData.anthropicBaseUrl || 'https://api.anthropic.com',
      apiToken: profileData.apiToken || '',
      model: profileData.model,
      wireApi: this.normalizeWireApi(profileData.wireApi, 'chat_completions'),
      reasoningEffort: profileData.reasoningEffort,
      contextWindow: profileData.contextWindow ?? 128000,
      maxTokens: profileData.maxTokens ?? 4096,
      notes: profileData.notes || '从 ClaudeCoach 配置包导入。',
      source: 'package',
    });
  }

  private createProfileId(): string {
    return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private normalizeWireApi(
    wireApi: AIProfile['wireApi'] | string | undefined,
    fallback: AIProfile['wireApi'] | undefined,
  ): AIProfile['wireApi'] {
    if (wireApi === 'responses') {
      return 'responses';
    }
    if (wireApi === 'chat_completions') {
      return 'chat_completions';
    }
    return fallback ?? 'chat_completions';
  }

  private parseCodexProviderConfig(toml: string, providerId: string | undefined): CodexProviderConfig {
    const genericBaseUrl = this.parseTomlString(toml, 'base_url')?.replace(/\/+$/, '');
    if (!providerId) {
      return {
        baseUrl: genericBaseUrl,
        wireApi: 'chat_completions',
      };
    }

    const sectionBody = this.readTomlSectionBody(toml, `[model_providers.${providerId}]`);
    if (!sectionBody) {
      return {
        baseUrl: genericBaseUrl,
        wireApi: 'chat_completions',
      };
    }

    return {
      baseUrl: this.parseTomlString(sectionBody, 'base_url')?.replace(/\/+$/, '') || genericBaseUrl,
      wireApi: this.normalizeWireApi(this.parseTomlString(sectionBody, 'wire_api'), 'chat_completions'),
    };
  }

  private readTomlSectionBody(toml: string, header: string): string | undefined {
    const startIndex = toml.indexOf(header);
    if (startIndex < 0) {
      return undefined;
    }

    const afterHeader = toml.slice(startIndex + header.length);
    const nextSectionIndex = afterHeader.search(/\n\[[^\n]+\]/);
    return nextSectionIndex >= 0 ? afterHeader.slice(0, nextSectionIndex) : afterHeader;
  }

  private parseTomlString(source: string, key: string): string | undefined {
    const match = source.match(new RegExp(`^\\s*${this.escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, 'm'));
    return match?.[1]?.trim() || undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '') || 'ai-profile';
  }

  private expandTilde(inputPath: string): string {
    return inputPath.replace(/^~/, os.homedir());
  }
}
