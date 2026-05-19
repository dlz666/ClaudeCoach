/// <reference types="node" />
/**
 * Claude Code CLI runner：spawn 子进程 + 流式 stdout 解析 + 超时管理。
 *
 * 设计目标：用用户已经登录的 Claude 订阅（不烧 token）让 Claude 用 WebSearch/
 * WebFetch/Write 等工具完成"搜图 / 找资料 / 自动产出"类的 agent 任务。
 *
 * 跟 ClaudeCoach 主对话的 AIClient（走 chat completion）是**两套独立链路**：
 * 此模块只负责 spawn 'claude' 子进程、解析它的 stream-json 输出、给上层报进度。
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const child_process = require('child_process');

export interface ClaudeCodeRunOptions {
  /** 给 Claude 的 prompt（-p 参数） */
  prompt: string;
  /** 工作目录（cwd），同时也是 Claude 默认能访问的目录边界 */
  cwd: string;
  /** 允许的工具列表，例如 ["WebSearch", "WebFetch", "Write", "Read"] */
  allowedTools?: string[];
  /** 显式禁用的工具，避免 Claude 用无关工具分散注意力（Task / TodoWrite 等） */
  disallowedTools?: string[];
  /** 额外可访问目录（--add-dir），如有 */
  additionalDirs?: string[];
  /** 是否跳过工具确认（生产用一般要 true，否则 Claude 每次工具调用都卡住等 confirm） */
  skipPermissions?: boolean;
  /** Thinking effort（low/medium/high/max），默认 low 避免吃 output 配额 */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** 超时（毫秒），默认 120000（2 分钟）。超时后 kill 子进程 */
  timeoutMs?: number;
  /** CLI 可执行路径，默认 'claude'（依赖 PATH） */
  cliPath?: string;
  /** 进度回调：解析 stream-json 时的每条事件（工具调用 / 文本片段 / 工具结果等） */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** 外部 AbortSignal，让上层能中断 */
  signal?: AbortSignal;
}

/** Claude Code stream-json 输出的事件类型（按官方文档 + 实际抓包归一）。 */
export interface ClaudeStreamEvent {
  type: string;
  // text / tool_use / tool_result / result / system 等任意字段都可能出现
  [key: string]: any;
}

export interface ClaudeCodeRunResult {
  /** 退出码（0 = 成功；非 0 = 失败或被 kill） */
  exitCode: number;
  /** 是否因外部 abort / 超时被 kill */
  aborted: boolean;
  /** 完整 stdout 行集合（已 trim） */
  stdoutLines: string[];
  /** 完整 stderr（debug 用） */
  stderr: string;
  /**
   * 最后一行的 JSON 解析结果（按约定：Claude 完成任务时最后一行输出结构化
   * 总结 JSON，例如 {"saved":[{...}]} 或 {"result":"..."}）。
   * 解析失败返回 null（上层兜底）。
   */
  finalJson: any | null;
  /** 总耗时（毫秒） */
  durationMs: number;
}

/**
 * 启动 Claude Code CLI 子进程并跑一次性任务。
 *
 * 实施细节：
 * - Windows 下 'claude' 可能是 .cmd / .ps1，spawn 需要 shell:true；其他平台不需要
 * - --output-format stream-json 让每个事件成为 stdout 一行 JSON
 * - --print 等价于 -p，传 prompt
 * - 工具白名单用 --allowedTools "Tool1,Tool2" 形式（实际 Claude Code 用空格分隔）
 * - 超时 kill 用 SIGTERM；如果 1 秒后还在跑，再 SIGKILL
 */
export async function runClaudeCode(opts: ClaudeCodeRunOptions): Promise<ClaudeCodeRunResult> {
  const startedAt = Date.now();
  const cli = opts.cliPath || 'claude';
  const timeoutMs = opts.timeoutMs ?? 120000;

  // 关键：prompt 不通过 -p <prompt> 命令行参数传，改走 stdin。
  // 原因：Windows shell:true 下 spawn 把 args 拼成 cmd.exe 单条命令行字符串，
  // 长 prompt（含中文 / 换行 / 引号）会被错误转义甚至截断 → Claude 收到的 prompt
  // 残缺或为空 → 它当成"无 prompt 默认行为"回个自我介绍。实测 stdin pipe 长中文
  // prompt 完美工作。
  const args: string[] = ['-p', '--output-format', 'stream-json'];
  if (opts.allowedTools && opts.allowedTools.length) {
    // Claude Code 的 --allowedTools 接受空格或逗号分隔
    args.push('--allowedTools', opts.allowedTools.join(' '));
  }
  if (opts.disallowedTools && opts.disallowedTools.length) {
    args.push('--disallowedTools', opts.disallowedTools.join(','));
  }
  if (opts.additionalDirs && opts.additionalDirs.length) {
    for (const dir of opts.additionalDirs) {
      args.push('--add-dir', dir);
    }
  }
  if (opts.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  // Thinking effort：默认 low 避免 Claude 4 系列 Extended Thinking 吃 output token 配额
  // （讲义生成 / 智能搜图都不需要复杂推理，prompt 已经给死格式）
  args.push('--effort', opts.effort || 'low');
  // stream-json 需要 verbose 才能输出每个事件
  args.push('--verbose');

  const isWindows = process.platform === 'win32';

  return new Promise<ClaudeCodeRunResult>((resolve, reject) => {
    let proc: any;
    try {
      proc = child_process.spawn(cli, args, {
        cwd: opts.cwd,
        shell: isWindows,  // Windows 下 .cmd 需要 shell
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],  // stdin pipe 给我们写 prompt
      });
      // 把 prompt 通过 stdin 传，避开 Windows cmd.exe 命令行字符 / 长度问题
      proc.stdin.write(opts.prompt, 'utf-8');
      proc.stdin.end();
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutLines: string[] = [];
    let stdoutBuf = '';
    // stderr 累积原始 buffer：Windows 上 shell=true 时 cmd.exe code page 是 GBK，
    // 中文错误信息按 UTF-8 强解会乱码。close 时智能解码（UTF-8 → 替换符回退 GBK）。
    const stderrChunks: Buffer[] = [];
    let stderr = '';
    let aborted = false;
    let finishedNormally = false;

    // 超时 kill
    const timeoutTimer = setTimeout(() => {
      aborted = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      // 兜底 1 秒后还活就 SIGKILL
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* noop */ }
      }, 1000);
    }, timeoutMs);

    // 外部 abort
    const onExternalAbort = () => {
      aborted = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onExternalAbort();
      else opts.signal.addEventListener('abort', onExternalAbort);
    }

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      // 按换行切分；最后一段可能不完整，留在 buffer 里等下一次
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        stdoutLines.push(line);
        // 尝试解析为事件
        let event: ClaudeStreamEvent | null = null;
        try { event = JSON.parse(line); } catch { /* 不是 JSON，忽略 */ }
        if (event && opts.onEvent) {
          try { opts.onEvent(event); } catch { /* swallow callback error */ }
        }
      }
    });

    // stderr 不 setEncoding，保持 Buffer 模式，close 时智能解码
    proc.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });

    proc.on('error', (err: Error) => {
      clearTimeout(timeoutTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      if (!finishedNormally) reject(err);
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timeoutTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      finishedNormally = true;
      // 智能解码 stderr buffer：UTF-8 → 含替换符回退 GBK（治 Windows cmd.exe 中文乱码）
      const stderrBuf = Buffer.concat(stderrChunks);
      const stderrUtf8 = stderrBuf.toString('utf-8');
      stderr = stderrUtf8.includes('�')
        ? (() => {
            try { return new TextDecoder('gbk', { fatal: false }).decode(stderrBuf); }
            catch { return stderrBuf.toString('latin1'); }
          })()
        : stderrUtf8;
      // 处理 buffer 残留
      if (stdoutBuf.trim()) {
        stdoutLines.push(stdoutBuf.trim());
        try {
          const event = JSON.parse(stdoutBuf.trim());
          if (opts.onEvent) opts.onEvent(event);
        } catch { /* noop */ }
      }
      // 解析最后一行 JSON 作为最终结果（约定：Claude 完成任务必须最后一行输出 JSON 清单）
      let finalJson: any | null = null;
      for (let i = stdoutLines.length - 1; i >= 0; i--) {
        const line = stdoutLines[i];
        try {
          const parsed = JSON.parse(line);
          // 跳过 type=text/tool_use/system 这些中间事件，找真正的最终 result
          // 我们的约定：用户 prompt 要求 Claude 最后输出 {"saved":[...]} 之类，
          // 这一条没有 "type" 字段（或 type 不在标准事件集里）
          if (parsed && (parsed.saved || parsed.result || (!parsed.type && Object.keys(parsed).length))) {
            // 但跳过 stream-json 的 wrapper（type=result 是 Claude Code 自己的总结）
            if (parsed.type === 'result' && parsed.result && typeof parsed.result === 'string') {
              // Claude Code 的 final result 事件，result 字段是文本
              // 尝试从里面找 JSON
              const m = String(parsed.result).match(/\{[\s\S]*\}\s*$/);
              if (m) {
                try { finalJson = JSON.parse(m[0]); break; } catch { /* noop */ }
              }
              continue;
            }
            if (parsed.saved || parsed.reason) {
              finalJson = parsed;
              break;
            }
          }
        } catch { /* not JSON, continue */ }
      }
      resolve({
        exitCode: code ?? -1,
        aborted,
        stdoutLines,
        stderr,
        finalJson,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
