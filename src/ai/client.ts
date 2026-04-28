import { AIConfig, ChatMessage, ResolvedAIConfig } from '../types';
import { getAIConfig } from '../config';

const ANTHROPIC_VERSION = '2023-06-01';
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 524]);
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 180000;

type ResponsesInputRole = 'user' | 'assistant';
type ResponsesContentType = 'input_text' | 'output_text';

/** 多模态消息：在普通 ChatMessage 基础上可附带图片。 */
export interface MultimodalContent {
  /** base64 编码的图片二进制（不含 data:image/... 前缀）。 */
  base64: string;
  /** image/png / image/jpeg 等。 */
  mimeType: string;
}

export interface MultimodalChatMessage extends ChatMessage {
  images?: MultimodalContent[];
}

/** 当前使用的 model 是否支持视觉？用于在调多模态前给前端友好报错。 */
export class VisionUnsupportedError extends Error {
  readonly modelName: string;
  readonly suggestedModels: string[];
  constructor(modelName: string, suggestedModels: string[]) {
    super(`当前 AI Profile 的模型 "${modelName}" 不支持图片输入。建议切换到：${suggestedModels.join(' / ')}`);
    this.name = 'VisionUnsupportedError';
    this.modelName = modelName;
    this.suggestedModels = suggestedModels;
  }
}

const VISION_OPENAI_MODELS = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-4.1', 'gpt-4.1-mini', 'o1', 'o3', 'o4-mini',
];
const VISION_ANTHROPIC_MODELS = [
  'claude-3', 'claude-3.5-sonnet', 'claude-3.5-haiku', 'claude-3.7-sonnet', 'claude-4', 'claude-opus', 'claude-sonnet',
];

function isVisionCapable(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === 'anthropic') {
    return VISION_ANTHROPIC_MODELS.some((prefix) => m.startsWith(prefix));
  }
  // OpenAI 兼容：含上面任一前缀视为支持
  return VISION_OPENAI_MODELS.some((prefix) => m.startsWith(prefix));
}

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

    if (config.wireApi === 'responses') {
      return this.openaiResponsesChat(config, messages, options);
    }

    return this.openaiChat(config, messages, options);
  }

  /**
   * 多模态 chat：在 user 消息里夹带图片。
   * 当前 model 不支持 vision 时抛 VisionUnsupportedError，调用方可捕获并提示用户切 profile。
   */
  async chatCompletionMultimodal(
    messages: MultimodalChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const config = await this.getConfig();
    if (!config.apiToken) {
      throw new Error('未配置 API Token，请先在设置中完善 AI 配置。');
    }

    if (!isVisionCapable(config.provider, config.model)) {
      throw new VisionUnsupportedError(
        config.model,
        config.provider === 'anthropic'
          ? ['claude-3.5-sonnet', 'claude-3.7-sonnet']
          : ['gpt-4o', 'gpt-4.1', 'gpt-4o-mini'],
      );
    }

    if (config.provider === 'anthropic') {
      return this.anthropicChatMultimodal(config, messages, options);
    }
    // OpenAI 多模态用标准 chat/completions（responses API 也支持但走 chat 更普适）
    return this.openaiChatMultimodal(config, messages, options);
  }

  private async openaiChatMultimodal(
    config: ResolvedAIConfig | AIConfig,
    messages: MultimodalChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const apiMessages = messages.map((message) => {
      // 没有图片时退化为简单字符串 content（兼容性最好）
      if (!message.images || message.images.length === 0) {
        return { role: message.role, content: message.content };
      }
      // 含图片时用 OpenAI vision 数组格式
      const parts: Array<Record<string, unknown>> = [];
      if (message.content && message.content.trim()) {
        parts.push({ type: 'text', text: message.content });
      }
      for (const img of message.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
        });
      }
      return { role: message.role, content: parts };
    });

    const body = {
      model: config.model,
      messages: apiMessages,
      temperature: options?.temperature ?? 0.3,
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
      throw new Error('多模态 API 返回了空内容。');
    }
    return content;
  }

  private async anthropicChatMultimodal(
    config: ResolvedAIConfig | AIConfig,
    messages: MultimodalChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;

    const systemPrompt = messages
      .filter((m) => m.role === 'system' && m.content?.trim())
      .map((m) => m.content.trim())
      .join('\n\n')
      .trim();
    const conversation = messages.filter((m) => m.role !== 'system');

    const apiMessages = conversation.map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      if (!message.images || message.images.length === 0) {
        return { role, content: message.content };
      }
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content && message.content.trim()) {
        blocks.push({ type: 'text', text: message.content });
      }
      for (const img of message.images) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
        });
      }
      return { role, content: blocks };
    });

    const body: Record<string, unknown> = {
      model: config.model,
      messages: apiMessages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    };
    if (systemPrompt) body.system = systemPrompt;

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
      content?: Array<{ type?: string; text?: string }>;
    };
    const textBlock = json.content?.find((b) => b.type === 'text');
    if (textBlock?.text) return textBlock.text;
    throw new Error(`多模态 API 返回了空内容：${JSON.stringify(json).slice(0, 200)}`);
  }

  /** JSON 形式的多模态调用（vision 直接返回结构化结果）。 */
  async chatJsonMultimodal<T>(
    messages: MultimodalChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<T> {
    const raw = await this.chatCompletionMultimodal(messages, {
      ...options,
      temperature: options?.temperature ?? 0.2,
    });
    const parsed = this.tryParseJsonText<T>(raw);
    if (parsed !== undefined) return parsed;
    throw new Error(`多模态返回内容不是合法 JSON。开头：${raw.slice(0, 120)}`);
  }

  async chatJson<T>(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<T> {
    const raw = await this.chatCompletion(messages, {
      ...options,
      temperature: options?.temperature ?? 0.3,
    });

    const parsed = this.tryParseJsonText<T>(raw);
    if (parsed !== undefined) {
      return parsed;
    }

    const repairedRaw = await this.chatCompletion([
      ...messages,
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: '你上一条回复不是合法 JSON。请严格按照刚才要求的同一 JSON 结构重新输出。只输出 JSON 本身，不要解释，不要 markdown 代码块，不要加任何前言，首字符必须是 { 或 [。',
      },
    ], {
      temperature: 0,
      maxTokens: options?.maxTokens,
    });

    const repaired = this.tryParseJsonText<T>(repairedRaw);
    if (repaired !== undefined) {
      return repaired;
    }

    throw new Error(`模型返回的内容不是合法 JSON。原始开头: ${raw.slice(0, 120)}`);
  }

  private async getConfig(): Promise<ResolvedAIConfig | AIConfig> {
    if (this.config) {
      return this.config;
    }
    return getAIConfig();
  }

  private tryParseJsonText<T>(raw: string): T | undefined {
    const candidates = this.collectJsonCandidates(raw);
    for (const candidate of candidates) {
      const parsed = this.safeJsonParse(candidate);
      if (parsed !== null || candidate.trim() === 'null') {
        return parsed as T;
      }
    }
    return undefined;
  }

  private collectJsonCandidates(raw: string): string[] {
    const candidates: string[] = [];
    const pushCandidate = (value: string | undefined | null) => {
      const text = String(value ?? '').trim();
      if (!text) {
        return;
      }
      if (!candidates.includes(text)) {
        candidates.push(text);
      }
    };

    pushCandidate(this.stripMarkdownFence(raw));

    const fencedBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fencedMatch: RegExpExecArray | null;
    while ((fencedMatch = fencedBlockRegex.exec(raw)) !== null) {
      pushCandidate(fencedMatch[1]);
    }

    pushCandidate(this.extractFirstJsonBlock(raw));
    return candidates;
  }

  private stripMarkdownFence(raw: string): string {
    return raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }

  private extractFirstJsonBlock(raw: string): string | undefined {
    for (let start = 0; start < raw.length; start += 1) {
      const ch = raw[start];
      if (ch !== '{' && ch !== '[') {
        continue;
      }

      const candidate = this.extractBalancedJson(raw, start);
      if (!candidate) {
        continue;
      }

      const parsed = this.safeJsonParse(candidate);
      if (parsed !== null || candidate.trim() === 'null') {
        return candidate;
      }
    }

    return undefined;
  }

  private extractBalancedJson(raw: string, start: number): string | undefined {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const ch = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        stack.push('}');
        continue;
      }

      if (ch === '[') {
        stack.push(']');
        continue;
      }

      if (ch === '}' || ch === ']') {
        if (stack.length === 0 || stack[stack.length - 1] !== ch) {
          return undefined;
        }
        stack.pop();
        if (stack.length === 0) {
          return raw.slice(start, index + 1);
        }
      }
    }

    return undefined;
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

  private async openaiResponsesChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/responses`;
    const systemMessages = messages
      .filter((message) => message.role === 'system' && message.content.trim())
      .map((message) => message.content.trim());
    const systemPromptText = systemMessages.join('\n\n').trim();
    const input = messages
      .filter((message) => message.role !== 'system' && message.content.trim())
      .map((message) => ({
        type: 'message' as const,
        role: message.role as ResponsesInputRole,
        content: [{
          type: this.responsesContentTypeForRole(message.role),
          text: message.content,
        }],
      }));
    const normalizedInput = this.injectResponsesSystemPrompt(input, systemPromptText, config);

    const body: Record<string, unknown> = {
      model: config.model,
      input: normalizedInput.length > 0 ? normalizedInput : [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue.' }],
      }],
      stream: true,
      max_output_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    };

    if (systemPromptText) {
      body.instructions = systemPromptText;
    }

    if (this.shouldIncludeResponsesTemperature(config, options?.temperature)) {
      body.temperature = options?.temperature;
    }

    if (config.reasoningEffort?.trim()) {
      body.reasoning = { effort: config.reasoningEffort.trim() };
    }

    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw await this.buildApiError(resp, config.baseUrl);
    }

    const content = await this.readResponsesOutput(resp);
    if (!content) {
      throw new Error('Responses API 返回了空内容。');
    }
    return content;
  }

  private async anthropicChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;

    const systemPrompt = messages
      .filter((message) => message.role === 'system' && message.content.trim())
      .map((message) => message.content.trim())
      .join('\n\n')
      .trim();
    const conversation = messages.filter((message) => message.role !== 'system');

    const anthropicMessages = (conversation.length > 0 ? conversation : [{ role: 'user' as const, content: 'Continue.' }])
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    const body: Record<string, unknown> = {
      model: config.model,
      messages: anthropicMessages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

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

  private shouldIncludeResponsesTemperature(
    config: ResolvedAIConfig | AIConfig,
    temperature: number | undefined,
  ): boolean {
    if (typeof temperature !== 'number') {
      return false;
    }

    const model = config.model.toLowerCase();
    const effort = config.reasoningEffort?.trim().toLowerCase();
    if (!model.startsWith('gpt-5')) {
      return true;
    }

    return model.startsWith('gpt-5.1') && effort === 'none';
  }

  private responsesContentTypeForRole(role: ChatMessage['role']): ResponsesContentType {
    return role === 'assistant' ? 'output_text' : 'input_text';
  }

  private injectResponsesSystemPrompt(
    input: Array<{ type: 'message'; role: ResponsesInputRole; content: Array<{ type: ResponsesContentType; text: string }> }>,
    systemPromptText: string,
    config: ResolvedAIConfig | AIConfig,
  ): Array<{ type: 'message'; role: ResponsesInputRole; content: Array<{ type: ResponsesContentType; text: string }> }> {
    if (!systemPromptText) {
      return input;
    }

    if (!this.shouldInlineSystemPromptForResponses(config)) {
      return input;
    }

    const injected = {
      type: 'message' as const,
      role: 'user' as const,
      content: [{
        type: 'input_text' as const,
        text: [
          '必须严格遵守以下角色与规则。这些规则优先于后续普通对话内容。',
          systemPromptText,
        ].join('\n\n'),
      }],
    };

    return [injected, ...input];
  }

  private shouldInlineSystemPromptForResponses(config: ResolvedAIConfig | AIConfig): boolean {
    try {
      const host = new URL(config.baseUrl).hostname.toLowerCase();
      return host !== 'api.openai.com';
    } catch {
      return true;
    }
  }

  private async readResponsesOutput(resp: Response): Promise<string> {
    const contentType = resp.headers.get('content-type') || '';
    if (/text\/event-stream/i.test(contentType)) {
      return this.readResponsesEventStream(resp);
    }

    const json = await resp.json().catch(() => null);
    const content = this.extractResponsesText(json);
    if (!content) {
      throw new Error(`Responses API 返回了无法解析的内容: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return content;
  }

  private async readResponsesEventStream(resp: Response): Promise<string> {
    if (!resp.body) {
      throw new Error('Responses API 返回了空响应流。');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';
    let fallbackText = '';

    const processChunk = (chunk: string) => {
      const lines = chunk.split('\n');
      let eventName = '';
      const dataLines: string[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0) {
        return;
      }

      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        return;
      }

      const payload = this.safeJsonParse(data);
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const type = String((payload as { type?: unknown }).type ?? eventName ?? '');
      if (type === 'response.output_text.delta') {
        accumulatedText += String((payload as { delta?: unknown }).delta ?? '');
        return;
      }

      if (!accumulatedText) {
        const extracted = this.extractResponsesText(payload);
        if (extracted) {
          fallbackText = extracted;
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n').replace(/\r/g, '');

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        processChunk(chunk);
        separatorIndex = buffer.indexOf('\n\n');
      }

      if (done) {
        break;
      }
    }

    if (buffer.trim()) {
      processChunk(buffer);
    }

    const content = accumulatedText || fallbackText;
    if (!content) {
      throw new Error('Responses API 流式响应中未找到文本内容。');
    }
    return content;
  }

  private extractResponsesText(payload: unknown): string {
    if (!payload) {
      return '';
    }

    if (Array.isArray(payload)) {
      return payload.map((item) => this.extractResponsesText(item)).filter(Boolean).join('');
    }

    if (typeof payload !== 'object') {
      return '';
    }

    const record = payload as {
      type?: unknown;
      text?: unknown;
      output_text?: unknown;
      content?: unknown;
      output?: unknown;
      response?: unknown;
      item?: unknown;
      part?: unknown;
    };

    if (typeof record.output_text === 'string' && record.output_text) {
      return record.output_text;
    }

    if (Array.isArray(record.output)) {
      const outputText = this.extractResponsesText(record.output);
      if (outputText) {
        return outputText;
      }
    }

    if (Array.isArray(record.content)) {
      const contentText = this.extractResponsesText(record.content);
      if (contentText) {
        return contentText;
      }
    }

    if ((record.type === 'output_text' || record.type === 'text') && typeof record.text === 'string') {
      return record.text;
    }

    if (record.part) {
      const partText = this.extractResponsesText(record.part);
      if (partText) {
        return partText;
      }
    }

    if (record.item) {
      const itemText = this.extractResponsesText(record.item);
      if (itemText) {
        return itemText;
      }
    }

    if (record.response) {
      return this.extractResponsesText(record.response);
    }

    return '';
  }

  private safeJsonParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
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
      throw new Error(`API 请求超时（${REQUEST_TIMEOUT_MS / 1000}s），请稍后重试或检查代理 / Base URL。`);
    }

    if (lastError instanceof Error) {
      throw new Error(`API 请求失败：${lastError.message}`);
    }

    throw new Error('API 请求失败：未知网络错误。');
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
