import { AIConfig, ChatMessage, ResolvedAIConfig } from '../types';
import { getAIConfig } from '../config';

const ANTHROPIC_VERSION = '2023-06-01';
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 524]);
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 180000;

export class AIClient {
  private config?: AIConfig;

  constructor(config?: AIConfig) {
    this.config = config;
  }

  async chatCompletion(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const config = await this.getConfig();
    if (!config.apiToken) {
      throw new Error('未配置 API Token，请先在设置中完善 AI 配置。');
    }

    if (config.provider === 'anthropic') {
      return this.anthropicChat(config, messages, options);
    }
    return this.openaiChat(config, messages, options);
  }

  async chatJson<T>(messages: ChatMessage[], options?: { temperature?: number }): Promise<T> {
    const raw = await this.chatCompletion(messages, {
      ...options,
      temperature: options?.temperature ?? 0.3,
    });
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    return JSON.parse(cleaned) as T;
  }

  private async getConfig(): Promise<ResolvedAIConfig | AIConfig> {
    if (this.config) {
      return this.config;
    }
    return getAIConfig();
  }

  private async openaiChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: config.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    };

    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw await this.buildApiError(resp, config.baseUrl);
    }

    const json = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('API 返回了空内容。');
    }
    return content;
  }

  private async anthropicChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;
    const anthropicMessages = messages.map((message) => ({
      role: message.role === 'system' ? 'user' : message.role,
      content: message.content,
    }));

    const body = {
      model: config.model,
      messages: anthropicMessages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    };

    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': config.apiToken,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw await this.buildApiError(resp, config.anthropicBaseUrl);
    }

    const json = await resp.json() as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };

    const textBlock = json.content?.find((block) => block.type === 'text');
    if (textBlock?.text) {
      return textBlock.text;
    }

    const thinkingBlock = json.content?.find((block) => block.type === 'thinking' || block.thinking);
    if (thinkingBlock?.thinking) {
      return `[思考过程]\n${thinkingBlock.thinking}`;
    }

    throw new Error(`API 返回了空内容，实际响应: ${JSON.stringify(json).slice(0, 200)}`);
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const resp = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok && RETRYABLE_STATUS_CODES.has(resp.status) && attempt < MAX_RETRIES) {
          await this.delay(this.retryDelayMs(attempt));
          continue;
        }

        return resp;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (attempt >= MAX_RETRIES || !this.isRetryableFetchError(error)) {
          break;
        }
        await this.delay(this.retryDelayMs(attempt));
      }
    }

    if (lastError instanceof Error && lastError.name === 'AbortError') {
      throw new Error(`API 请求超时（>${REQUEST_TIMEOUT_MS / 1000}s），请稍后重试或检查代理 / Base URL。`);
    }

    if (lastError instanceof Error) {
      throw new Error(`API 请求失败：${lastError.message}`);
    }

    throw new Error('API 请求失败：未知网络错误');
  }

  private async buildApiError(resp: Response, baseUrl: string): Promise<Error> {
    const text = await resp.text().catch(() => '');
    const contentType = resp.headers.get('content-type') || '';
    const summary = this.summarizeErrorBody(text, contentType);

    if (resp.status === 401 || resp.status === 403) {
      return new Error(`API 认证失败 (${resp.status})，请检查 Token 是否正确。`);
    }

    if (resp.status === 429) {
      return new Error('API 请求频率超限，请稍后重试。');
    }

    if (resp.status === 502 || resp.status === 503 || resp.status === 504 || resp.status === 524) {
      return new Error(
        `API 网关超时或上游不可用 (${resp.status})。Base URL: ${baseUrl}。${summary || '请稍后重试，并检查代理 / 网关是否稳定。'}`
      );
    }

    return new Error(`API 请求失败 (${resp.status})。${summary || `Base URL: ${baseUrl}`}`);
  }

  private summarizeErrorBody(text: string, contentType: string): string {
    const raw = text.trim();
    if (!raw) {
      return '';
    }

    const looksHtml = /html/i.test(contentType) || /^<!DOCTYPE html/i.test(raw) || /^<html/i.test(raw);
    if (looksHtml) {
      const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
      const bodyText = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const htmlSummary = [title, bodyText].filter(Boolean).join(' ').trim();
      return htmlSummary
        ? `服务返回了 HTML 错页：${htmlSummary.slice(0, 180)}`
        : '服务返回了 HTML 错页，通常表示代理、网关或 Base URL 配置不正确。';
    }

    return raw.replace(/\s+/g, ' ').slice(0, 180);
  }

  private isRetryableFetchError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    if (error.name === 'AbortError') {
      return true;
    }

    return /fetch failed|network|socket|timeout|econnreset|econnrefused|etimedout/i.test(error.message);
  }

  private retryDelayMs(attempt: number): number {
    return 750 * (attempt + 1);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
