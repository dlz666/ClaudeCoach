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

/**
 * chatCompletion 选项。
 * - `onDelta`：传入时启用流式输出，每个 token 到达时回调一次（同步）。
 *   不传时默认非流式行为（积累完整结果后返回）。
 *   注意：仅文本 chatCompletion 暴露此回调；chatJson 不暴露，避免误用——
 *   JSON 必须等完整 schema 才能验证，部分输出无意义。
 * - `signal`：AbortController.signal，让上游能 cancel 长操作。
 *   当前 fetch 已透传，但 UI 还未提供 cancel 按钮（下一期补）。
 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
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

/**
 * 通用 SSE 流读取工具。
 *
 * 读完整个 stream，按 `\n\n` 切 event chunks，每个 chunk 内提取所有 `data:` 行
 * 合并成一个 JSON payload 调用 `onPayload(parsed)`。`event: foo` 行通过
 * `__event` 字段传给 callback 供其判断事件类型。
 *
 * 错误（JSON parse 失败 / [DONE] 标记）silently skip，stream 继续。
 */
async function streamSSE(
  resp: Response,
  onPayload: (payload: unknown, eventName?: string) => void,
): Promise<void> {
  if (!resp.body) {
    throw new Error('响应体为空，无法启动 SSE 流。');
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processChunk = (chunk: string) => {
    const lines = chunk.split('\n');
    let eventName = '';
    const dataLines: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    try {
      const payload = JSON.parse(data);
      onPayload(payload, eventName);
    } catch {
      // 单条 chunk 解析失败不中断流
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder
      .decode(value ?? new Uint8Array(), { stream: !done })
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '');
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      processChunk(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) processChunk(buffer);
}

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

  async chatCompletion(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const config = await this.getConfig();

    if (config.provider === 'claude_code_cli') {
      return this.claudeCodeCliChat(config, messages, options);
    }

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

    if (config.provider === 'claude_code_cli') {
      throw new Error('Claude CLI provider 暂不支持图片输入，请切换到 OpenAI 或 Anthropic profile。');
    }

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
    options?: ChatOptions,
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const useStream = typeof options?.onDelta === 'function';
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
    };
    if (useStream) {
      body.stream = true;
    }

    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: useStream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!resp.ok) {
      throw await this.buildApiError(resp, config.baseUrl);
    }

    if (useStream) {
      const accumulated = await this.readOpenAIChatEventStream(resp, options!.onDelta!);
      if (!accumulated) {
        throw new Error('API 流式返回了空内容。');
      }
      return accumulated;
    }

    const json = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('API 返回了空内容。');
    }
    return content;
  }

  /**
   * 解析 OpenAI chat/completions 流式响应（SSE）。
   * 每条 `data: {json}` 行解析 `choices[0].delta.content`，
   * 逐 token 调 onDelta，最终累加返回完整 text。
   */
  private async readOpenAIChatEventStream(resp: Response, onDelta: (chunk: string) => void): Promise<string> {
    let accumulated = '';
    await streamSSE(resp, (payload) => {
      const delta = (payload as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        accumulated += delta;
        try { onDelta(delta); } catch { /* swallow callback errors */ }
      }
    });
    return accumulated;
  }

  private async openaiResponsesChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: ChatOptions,
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
      signal: options?.signal,
    });

    if (!resp.ok) {
      throw await this.buildApiError(resp, config.baseUrl);
    }

    const content = await this.readResponsesOutput(resp, options?.onDelta);
    if (!content) {
      throw new Error('Responses API 返回了空内容。');
    }
    return content;
  }

  private async anthropicChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;
    const useStream = typeof options?.onDelta === 'function';

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
    if (useStream) {
      body.stream = true;
    }

    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: useStream ? 'text/event-stream' : 'application/json',
        'x-api-key': config.apiToken,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!resp.ok) {
      throw await this.buildApiError(resp, config.anthropicBaseUrl);
    }

    if (useStream) {
      const accumulated = await this.readAnthropicEventStream(resp, options!.onDelta!);
      if (!accumulated) {
        throw new Error('Anthropic 流式返回了空内容。');
      }
      return accumulated;
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

  /**
   * 解析 Anthropic messages 流式响应。Anthropic SSE 事件类型：
   *   - content_block_delta { delta: { type: 'text_delta', text: '...' } } —— 主流 token 流
   *   - 其他事件（message_start / content_block_start / message_delta / message_stop）忽略
   */
  private async readAnthropicEventStream(resp: Response, onDelta: (chunk: string) => void): Promise<string> {
    let accumulated = '';
    await streamSSE(resp, (payload, eventName) => {
      const type = String((payload as { type?: unknown }).type ?? eventName ?? '');
      if (type === 'content_block_delta') {
        const delta = (payload as { delta?: { type?: string; text?: unknown } }).delta;
        if (delta && (delta.type === 'text_delta' || !delta.type) && typeof delta.text === 'string') {
          accumulated += delta.text;
          try { onDelta(delta.text); } catch { /* swallow */ }
        }
      }
    });
    return accumulated;
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

  private async readResponsesOutput(resp: Response, onDelta?: (chunk: string) => void): Promise<string> {
    const contentType = resp.headers.get('content-type') || '';
    if (/text\/event-stream/i.test(contentType)) {
      return this.readResponsesEventStream(resp, onDelta);
    }

    const json = await resp.json().catch(() => null);
    const content = this.extractResponsesText(json);
    if (!content) {
      throw new Error(`Responses API 返回了无法解析的内容: ${JSON.stringify(json).slice(0, 200)}`);
    }
    // 非流式时也调一次 onDelta，让前端逻辑统一
    if (onDelta && content) {
      try { onDelta(content); } catch { /* swallow */ }
    }
    return content;
  }

  private async readResponsesEventStream(resp: Response, onDelta?: (chunk: string) => void): Promise<string> {
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
        const deltaText = String((payload as { delta?: unknown }).delta ?? '');
        if (deltaText) {
          accumulatedText += deltaText;
          if (onDelta) {
            try { onDelta(deltaText); } catch { /* swallow */ }
          }
        }
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
    // 外部传入的 abort signal（来自 chatCompletion options.signal → 让 webview 端
    // 用户点"✕ 取消"能真正中断 fetch）。之前 fetch 调用里 `...init` 展开后立即被
    // 后面的 `signal: controller.signal` 覆盖（对象字面量后写覆盖前写），外部
    // signal 等于完全没接 → controller.abort() 没效果 → AI 继续跑完。这里显式
    // 把外部 signal 转发到每次重试的内部 controller。
    const externalSignal = (init as any).signal as AbortSignal | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      // 内部 controller 同时承担"请求超时"和"外部 abort 转发"两个职责
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const forwardAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', forwardAbort);
      }

      try {
        const resp = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);

        if (!resp.ok && RETRYABLE_STATUS_CODES.has(resp.status) && attempt < MAX_RETRIES) {
          await this.delay(this.retryDelayMs(attempt));
          continue;
        }

        return resp;
      } catch (error) {
        clearTimeout(timeout);
        if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
        lastError = error;
        // 外部 abort：立即放弃重试，不要再让用户等下一轮 attempt
        if (externalSignal?.aborted) break;
        if (attempt >= MAX_RETRIES || !this.isRetryableFetchError(error)) {
          break;
        }
        await this.delay(this.retryDelayMs(attempt));
      }
    }

    // 错误归类：外部 abort 优先于超时（同样抛 AbortError，便于上层识别"用户主动取消"）
    if (externalSignal?.aborted) {
      const abortErr = new Error('已取消');
      (abortErr as any).name = 'AbortError';
      throw abortErr;
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

  /**
   * Claude Code CLI 提供商：spawn `claude --print` 子进程，复用本机 Claude Code 的
   * OAuth/API key 登录态。零额外配置——只要本机能跑 `claude` 命令就能工作。
   *
   * - 多条 messages 会被扁平成 transcript（"User: ..." / "Assistant: ..."），
   *   system 角色拼到 --append-system-prompt
   * - 通过 stdin 传 prompt 避免命令行参数长度和 escape 问题
   * - --output-format json 输出单个 JSON 对象 { result, ... }，比 stream-json 解析简单
   * - onDelta 不真正流式（CLI 子进程也支持 stream-json，但本期先确保正确性），
   *   有 onDelta 时在最终一次性回调一段（兼容上游 streaming UI 协议）
   */
  private async claudeCodeCliChat(
    config: ResolvedAIConfig | AIConfig,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    const { spawn } = await import('child_process');

    const systemPrompt = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const turns = messages.filter((m) => m.role !== 'system');
    let promptText: string;
    if (turns.length === 1 && turns[0].role === 'user') {
      promptText = turns[0].content;
    } else if (turns.length === 0) {
      promptText = '(empty)';
    } else {
      promptText = turns
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
    }

    const args = ['--print', '--output-format', 'json'];
    if (config.model && config.model.trim()) {
      args.push('--model', config.model.trim());
    }
    // 关键：禁用所有内置工具。否则 Claude Code 默认处于 agent 模式，看到"写讲义"
    // 这种任务会想用 Write 工具创建文件 → 在 --print 模式下没法弹 permission 窗
    // → 输出"请授权后即可查看"的状态摘要，而不是真讲义内容。
    // 我们要的就是单轮 chat 输出文本，不需要任何工具能力。
    args.push('--disallowedTools',
      'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit,Skill,SlashCommand,SendUserMessage');

    // Windows cmd.exe 单条命令行最大 8191 字符。讲义生成 system prompt 长 ~9K-12K，
    // 作为 --append-system-prompt 参数传过去就触发 "命令行太长" (exit 1)。
    // 之前尝试过把长 system 拼到 stdin（作为 user message 前缀），但 Claude
    // 误认为前面那段是讲义内容的一部分，只补充输出"五、六、小结"部分讲义残废。
    // 正确方案：用 --append-system-prompt-file <路径> 传文件路径（CLI 提供此 flag）。
    // 命令行参数短，Claude 仍认知为 system instructions，不会跟 user message 混淆。
    const APPEND_FLAG_MAX_LEN = 3500;  // 留充足 buffer 给其他 args + claude.cmd 包装
    let tempSystemPromptFile: string | null = null;
    if (systemPrompt && systemPrompt.length < APPEND_FLAG_MAX_LEN) {
      args.push('--append-system-prompt', systemPrompt);
    } else if (systemPrompt) {
      // 长 system → 写临时文件 → --append-system-prompt-file
      const os = await import('os');
      const path = await import('path');
      const fsp = await import('fs/promises');
      const crypto = await import('crypto');
      tempSystemPromptFile = path.join(
        os.tmpdir(),
        `cc-claude-sysprompt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`,
      );
      await fsp.writeFile(tempSystemPromptFile, systemPrompt, 'utf-8');
      args.push('--append-system-prompt-file', tempSystemPromptFile);
    }

    return new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', args, {
        shell: process.platform === 'win32',
        windowsHide: true,
        env: process.env,
      });

      // Windows 上 shell:true 会走 cmd.exe，默认 code page 是 GBK（936）。
      // 子进程输出的中文错误信息（如"请检查 / 未登录"）是 GBK 字节，强按
      // UTF-8 解码会出 � 替换符（用户看到的 ��������）。
      // 修法：累积原始 Buffer，结束时智能解码 —— 先试 UTF-8，遇到替换符回退 GBK。
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const smartDecode = (buf: Buffer): string => {
        const utf8 = buf.toString('utf-8');
        // UTF-8 解码成功（不含替换符）→ 用它
        if (!utf8.includes('�')) return utf8;
        // 含替换符 → 试 GBK（Node 13+ 内置 ICU 支持 gbk）
        try {
          return new TextDecoder('gbk', { fatal: false }).decode(buf);
        } catch {
          // ICU 编译时没带 gbk（少见）→ 退回 latin1 至少不丢字节
          return buf.toString('latin1');
        }
      };

      proc.stdout.on('data', (data: Buffer) => { stdoutChunks.push(data); });
      proc.stderr.on('data', (data: Buffer) => { stderrChunks.push(data); });

      proc.on('error', (err) => {
        settle(() => reject(new Error(
          `无法启动 claude CLI：${err.message}。请确认已安装 Claude Code 并在 PATH 中（终端能直接运行 "claude --version"）。`,
        )));
      });

      proc.on('close', (code) => {
        settle(() => {
          // 智能解码累积的 buffer（UTF-8 → 失败回退 GBK），治 Windows 中文乱码
          const stdout = smartDecode(Buffer.concat(stdoutChunks));
          const stderr = smartDecode(Buffer.concat(stderrChunks));

          // 先尝试解析 JSON，无论 exit code 是 0 还是 1：
          // claude --output-format json 在 is_error=true 时（如未登录）也返回 1 +
          // 完整 JSON，需要把 result 字段提取出来给友好错误，而不是 dump raw JSON。
          let parsed: { is_error?: boolean; result?: unknown; message?: unknown; content?: unknown; error?: unknown } | null = null;
          try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }

          if (parsed && parsed.is_error) {
            const errMsg = String(parsed.result ?? parsed.error ?? '未知错误').trim();
            if (/not logged in|please run \/login/i.test(errMsg)) {
              reject(new Error(
                `Claude CLI 未登录（子进程视角）。\n\n` +
                `如果你的 Claude Code 在 VS Code/IDE 里能用，那是 IDE 插件模式 — ` +
                `认证态在宿主进程内存里（CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1），` +
                `不会持久化到磁盘，也无法共享给我们 spawn 的子进程。\n\n` +
                `解决方法（任选一）：\n` +
                `① 在 独立终端（PowerShell / Windows Terminal，非 VS Code 集成终端）里运行：\n` +
                `     claude /login\n` +
                `   走 OAuth 后凭据落盘，子进程就能复用。\n` +
                `② 用 long-lived token：终端运行 "claude setup-token" 设一个长期 token。\n` +
                `③ 或者切换到 Anthropic / OpenAI provider，填一个 API Key。`,
              ));
              return;
            }
            reject(new Error(`Claude CLI 返回错误：${errMsg}`));
            return;
          }

          if (code !== 0) {
            const tail = (stderr.trim() || stdout.trim()).slice(0, 300);
            reject(new Error(`claude CLI 退出码 ${code}：${tail || '无错误输出'}`));
            return;
          }

          let result = '';
          if (parsed) {
            const r = parsed.result ?? parsed.message ?? parsed.content ?? '';
            result = typeof r === 'string' ? r : JSON.stringify(r);
          } else {
            result = stdout.trim();
          }
          if (typeof options?.onDelta === 'function' && result) {
            try { options.onDelta(result); } catch { /* swallow */ }
          }
          resolve(result);
        });
      });

      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          try { proc.kill('SIGTERM'); } catch { /* swallow */ }
          settle(() => reject(new Error('已取消')));
        });
      }

      try {
        // user message 走 stdin（system prompt 已通过 flag 或 file 传给 CLI，不再拼到 stdin）
        proc.stdin.write(promptText, 'utf-8');
        proc.stdin.end();
      } catch (e: any) {
        settle(() => reject(new Error(`向 claude CLI 写入 prompt 失败：${e?.message || e}`)));
      }
    }).finally(async () => {
      // 清理临时 system prompt 文件（成功失败都清）
      if (tempSystemPromptFile) {
        try {
          const fsp = await import('fs/promises');
          await fsp.unlink(tempSystemPromptFile);
        } catch { /* 忽略：临时目录会自动清理 */ }
      }
    });
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
