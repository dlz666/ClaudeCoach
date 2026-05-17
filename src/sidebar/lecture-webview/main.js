// main.js — Lecture Webview Controller
// 监听选区，浮出 chip，展开评论框，发送 inlineSuggest 给宿主，
// 接收 inlineSuggestResult / inlineApplied / lectureFileChanged 并相应渲染。

(function () {
  'use strict';

  const helpers = window.LectureRenderHelpers || {};
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

  /** @typedef {{filePath:string;content:string;lessonTitle:string;topicTitle:string;subject:string;applyMode:string;highlightChangesMs:number}} InitMsg */

  const state = {
    filePath: '',
    content: '',
    applyMode: 'preview-confirm',
    highlightChangesMs: 5000,
    /** 当前活跃的 turn（preview 等待用户决定） */
    activeTurns: new Map(),
  };

  // ===== markdown-it =====

  let md = null;
  if (typeof window.markdownit === 'function') {
    md = window.markdownit({
      // html:true 是为了让 AI 生成的 <details>/<summary> 折叠块、<sub>/<sup>、
      // <table> 等内联 HTML 正常渲染。XSS 风险被 CSP 兜住：webview 的 CSP 把
      // script-src 限到 nonce 白名单，AI 输出里的 <script> 跑不了。
      html: true,
      linkify: true,
      typographer: false,
      breaks: false,
      highlight: (str, lang) => {
        // Mermaid 代码块特殊处理：占位 div，由 renderMermaid 阶段渲染为 SVG
        if (lang === 'mermaid') {
          const escaped = (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<pre class="mermaid-source"><code class="language-mermaid">${escaped}</code></pre>`;
        }
        // DOT/GraphViz 代码块：占位 pre，由 renderGraphviz 阶段编译成 SVG
        if (lang === 'dot' || lang === 'graphviz') {
          const escaped = (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<pre class="dot-source"><code class="language-dot">${escaped}</code></pre>`;
        }
        // 用 highlight.js 渲染代码块
        if (typeof window.hljs !== 'undefined' && window.hljs) {
          try {
            if (lang && window.hljs.getLanguage(lang)) {
              const out = window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
              return `<pre class="hljs"><code class="hljs language-${lang}">${out}</code></pre>`;
            }
            const auto = window.hljs.highlightAuto(str);
            return `<pre class="hljs"><code class="hljs language-${auto.language || 'text'}">${auto.value}</code></pre>`;
          } catch (err) { /* fallback */ }
        }
        return '';
      },
    });
    if (typeof helpers.attachSourceLines === 'function') {
      helpers.attachSourceLines(md);
    }
    // 让 fence 也带 source-line
    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      if (token.map && token.level === 0) {
        token.attrSet('data-source-line', String(token.map[0]));
        token.attrSet('data-source-line-end', String(token.map[1]));
      }
      return (defaultFence || ((t, i, o, e, s) => s.renderToken(t, i, o)))(tokens, idx, options, env, self);
    };
    // 链接安全
    const defaultLinkOpen = md.renderer.rules.link_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultLinkOpen(tokens, idx, options, env, self);
    };
  }

  const mathRenderOptions = {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
    strict: 'ignore',
  };

  function renderMarkdown(text) {
    if (!md) {
      return '<pre>' + (helpers.escapeHtml ? helpers.escapeHtml(text) : '') + '</pre>';
    }
    try {
      return md.render(String(text || ''));
    } catch (err) {
      console.warn('markdown render failed', err);
      return '<pre>' + (helpers.escapeHtml ? helpers.escapeHtml(text) : '') + '</pre>';
    }
  }

  function renderMath(root) {
    if (root && typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(root, mathRenderOptions);
      } catch (err) {
        console.warn('katex render failed', err);
      }
    }
  }

  // 初始化 mermaid（一次性）
  let mermaidInited = false;
  function ensureMermaidInit() {
    if (mermaidInited) return;
    if (typeof window.mermaid === 'undefined') return;
    try {
      // 跟随 VS Code 主题。检测 body 背景色判断 dark/light
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const isDark = /rgb\((\d+),\s*(\d+),\s*(\d+)/.test(bg) && (() => {
        const [, r, g, b] = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/) || [];
        const lum = (Number(r) + Number(g) + Number(b)) / 3;
        return lum < 128;
      })();
      window.mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });
      mermaidInited = true;
    } catch (err) {
      console.warn('mermaid init failed', err);
    }
  }

  /**
   * 渲染所有 .language-mermaid 代码块为 SVG。
   * 容错：单个图错了不影响其他；失败时显示原文 + "复制到 mermaid.live" 链接。
   */
  async function renderMermaid(root) {
    if (!root) return;
    if (typeof window.mermaid === 'undefined') return;
    ensureMermaidInit();
    const blocks = root.querySelectorAll('pre.mermaid-source code.language-mermaid');
    let counter = 0;
    for (const codeEl of blocks) {
      const pre = codeEl.parentElement;
      if (!pre) continue;
      // 用 textContent 拿到原始 mermaid 源（已 unescape HTML 实体）
      const source = codeEl.textContent || '';
      const id = `mermaid-${Date.now().toString(36)}-${counter++}`;
      try {
        const { svg } = await window.mermaid.render(id, source);
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.innerHTML = svg;
        pre.replaceWith(wrap);
      } catch (err) {
        console.warn('mermaid render failed for block', id, err);
        // 降级：显示源码 + 给 mermaid.live 链接
        const fallback = document.createElement('div');
        fallback.className = 'mermaid-fallback';
        const escaped = (source || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const liveUrl = 'https://mermaid.live/edit#pako:' + ''; // 简单跳转，用户可复制
        fallback.innerHTML = `
          <div class="mermaid-fallback-banner">⚠ Mermaid 图渲染失败（语法错？）</div>
          <pre><code class="language-mermaid">${escaped}</code></pre>
          <a href="${liveUrl}" target="_blank" rel="noopener">在 mermaid.live 试试</a>
        `;
        pre.replaceWith(fallback);
      }
    }
  }

  // ===== GraphViz / DOT =====
  /**
   * @hpcc-js/wasm 的 Graphviz 实例懒加载 + 全局缓存。
   * wasm 初始化只做一次（~200ms 启动），之后 gv.dot(src) 同步返回 SVG（~5-30ms / 图）。
   */
  let graphvizInstance = null;
  let graphvizLoading = null;
  async function ensureGraphviz() {
    if (graphvizInstance) return graphvizInstance;
    if (graphvizLoading) return graphvizLoading;
    // UMD 暴露在 globalThis['@hpcc-js/wasm/graphviz'].Graphviz（验证过）
    const mod = window['@hpcc-js/wasm/graphviz'];
    if (!mod || !mod.Graphviz || typeof mod.Graphviz.load !== 'function') return null;
    graphvizLoading = mod.Graphviz.load().then((gv) => {
      graphvizInstance = gv;
      graphvizLoading = null;
      return gv;
    }).catch((err) => {
      graphvizLoading = null;
      console.warn('graphviz load failed', err);
      return null;
    });
    return graphvizLoading;
  }

  /**
   * 把根节点下所有 pre.dot-source code.language-dot 编译为内联 SVG。
   * 容错：单个图错了换降级展示，其它正常。
   */
  async function renderGraphviz(root) {
    if (!root) return;
    const blocks = root.querySelectorAll('pre.dot-source code.language-dot');
    if (!blocks.length) return;
    const gv = await ensureGraphviz();
    if (!gv) {
      console.warn('graphviz unavailable');
      return;
    }
    let counter = 0;
    for (const codeEl of blocks) {
      const pre = codeEl.parentElement;
      if (!pre) continue;
      const source = codeEl.textContent || '';
      try {
        const svg = gv.dot(source, 'svg');
        const wrap = document.createElement('div');
        wrap.className = 'graphviz-rendered';
        wrap.innerHTML = svg;
        // 让 SVG 自适应宽度，遵循主题色（stroke/text 用 currentColor 由 CSS 注入）
        const svgEl = wrap.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
        }
        pre.replaceWith(wrap);
      } catch (err) {
        console.warn('graphviz render failed', err);
        const fallback = document.createElement('div');
        fallback.className = 'graphviz-fallback';
        const escaped = (source || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        fallback.innerHTML = `
          <div class="graphviz-fallback-banner">⚠ DOT 图渲染失败：${(err && err.message ? err.message : '语法错').replace(/[<&]/g, (c) => c === '<' ? '&lt;' : '&amp;')}</div>
          <pre><code class="language-dot">${escaped}</code></pre>
        `;
        pre.replaceWith(fallback);
      }
      counter++;
    }
  }

  // ===== DOM refs =====

  const els = {
    body: document.getElementById('lectureBody'),
    title: document.getElementById('lectureTitle'),
    topic: document.getElementById('lectureTopic'),
    status: document.getElementById('lectureStatus'),
    chip: document.getElementById('chip'),
    popover: document.getElementById('popover'),
    toastContainer: document.getElementById('toastContainer'),
    btnReload: document.getElementById('btnReload'),
  };

  let currentSelectionInfo = null;
  /** 已渲染的浮动建议气泡（preview / applied 阶段）。key = turnId */
  const bubbles = new Map();

  // ===== render lecture =====

  function renderLecture(content) {
    state.content = String(content || '');
    if (!els.body) return;
    els.body.innerHTML = renderMarkdown(state.content);
    renderMath(els.body);
    void renderMermaid(els.body); // 异步，不 block
    void renderGraphviz(els.body); // 异步，不 block
  }

  function setHeader(args) {
    if (!args) return;
    if (els.title) els.title.textContent = args.lessonTitle || '讲义';
    if (els.topic) els.topic.textContent = args.topicTitle ? `${args.subject || ''} · ${args.topicTitle}` : '';
  }

  function flashStatus(text, level) {
    if (!els.status) return;
    els.status.textContent = text || '';
    els.status.dataset.level = level || 'info';
    if (text) {
      clearTimeout(flashStatus._t);
      flashStatus._t = setTimeout(() => {
        els.status.textContent = '';
        delete els.status.dataset.level;
      }, 2400);
    }
  }

  // ===== 蓝色按钮 / popover =====
  // 按钮固定在右上角常驻，不再依赖选区显示。点击时：
  //   - 有选区文本 → 走选区相关流程（rewrite/ask/idea），info 用 selection
  //   - 没选区 → 用全文当 context（intent=ask 时把整篇 markdown 喂给 AI）

  /** 收集当前选区；若没有有效选区，返回一个"全文"info 当 fallback。 */
  function pickContextInfo() {
    const info = helpers.getSelectionLineRange ? helpers.getSelectionLineRange(els.body) : null;
    if (info && info.text && info.text.trim()) {
      return info;
    }
    // 无选区 → 全文模式
    const content = state.content || '';
    const lines = content.split('\n');
    return {
      startLine: 0,
      endLine: lines.length, // 半开区间，markdown-it 风格
      text: '',               // 留空，让后端 inlineSuggest 用 cursorContext / documentContext
      rect: null,
      isFullDoc: true,
    };
  }

  function hidePopover() {
    if (els.popover) {
      els.popover.hidden = true;
      els.popover.innerHTML = '';
    }
  }

  function showPopoverFor(info) {
    if (!els.popover || !info) return;
    // 定位：如果 info 自带 rect（来自选区），popover 在选区下方；
    // 否则（全文模式 / 没 rect）popover 锚到蓝色按钮左下方。
    let top, left;
    if (info.rect) {
      top = window.scrollY + info.rect.bottom + 12;
      left = Math.max(16, Math.min(window.scrollX + info.rect.left, window.innerWidth - 420));
    } else {
      const chipRect = els.chip?.getBoundingClientRect();
      if (chipRect) {
        top = window.scrollY + chipRect.bottom + 8;
        // popover 往左展开，对齐 chip 右边
        left = Math.max(16, window.scrollX + chipRect.right - 400);
      } else {
        top = window.scrollY + 60;
        left = 16;
      }
    }
    els.popover.style.top = `${top}px`;
    els.popover.style.left = `${left}px`;
    els.popover.innerHTML = '';

    // 三种 mode：rewrite=改这段/整篇 / ask=提问 / idea=记一下想法（不改文件）
    // 全文模式下 rewrite = 整篇 AI 重写（reviseMarkdownPrompt + replaceWholeDocument 写回）
    let currentMode = 'rewrite';

    const heading = document.createElement('div');
    heading.className = 'popover-heading';
    heading.textContent = info.isFullDoc
      ? '📄 基于全文（未选中具体段落）'
      : `选中第 ${info.startLine + 1}–${info.endLine} 行`;
    els.popover.appendChild(heading);

    const modeBar = document.createElement('div');
    modeBar.className = 'popover-mode-bar';
    const modes = info.isFullDoc
      ? [
          { key: 'rewrite', label: '🛠 重写整篇', hint: 'AI 输出完整新版讲义并整篇覆盖（强制走预览 + 自动 .bak 备份，可撤回）' },
          { key: 'ask', label: '❓ 提问', hint: 'AI 基于整篇讲义回答你的问题' },
          { key: 'idea', label: '💡 记想法', hint: '把你的想法以引用块追加到讲义末尾' },
        ]
      : [
          { key: 'rewrite', label: '🛠 改这段', hint: 'AI 输出会替换/插入到选区' },
          { key: 'ask', label: '❓ 提问', hint: 'AI 会以聊天形式回答，不动讲义' },
          { key: 'idea', label: '💡 记想法', hint: '把你的想法以脚注形式追加到这段下方，不调 AI' },
        ];
    const modeButtons = modes.map((m) => {
      const btn = document.createElement('button');
      btn.className = 'popover-mode-btn' + (m.key === currentMode ? ' active' : '');
      btn.textContent = m.label;
      btn.title = m.hint;
      btn.addEventListener('click', () => {
        currentMode = m.key;
        modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
        // 切换 placeholder + 提交按钮文案
        textarea.placeholder = m.key === 'rewrite'
          ? (info.isFullDoc
              ? '告诉 AI 怎么改整篇：「补更多例题」「改成更严谨的证明风格」「补一个总结表」…'
              : '告诉 AI 怎么改：「补一个例子」「化简这段」「加公式推导」…')
          : m.key === 'ask'
            ? (info.isFullDoc
                ? '关于整篇讲义你想问什么：「主要思想是什么」「跟 X 概念有什么联系」…'
                : '关于这段你想问什么：「这步为什么成立」「能换种方式解释吗」…')
            : (info.isFullDoc
                ? '记下你自己的想法/疑问，会作为引用块追加到讲义末尾。'
                : '记下你自己的想法/疑问，会作为引用块追加到这段下方。');
        btnSubmit.textContent = m.key === 'rewrite'
          ? (info.isFullDoc
              ? '重写整篇讲义'
              : (state.applyMode === 'auto-apply' ? '直接改写' : '发送给 AI'))
          : m.key === 'ask' ? '问 AI'
          : '保存想法';
      });
      modeBar.appendChild(btn);
      return btn;
    });
    els.popover.appendChild(modeBar);

    if (info.text) {
      const quote = document.createElement('div');
      quote.className = 'popover-quote';
      const truncated = info.text.length > 200 ? info.text.slice(0, 200) + '…' : info.text;
      quote.textContent = truncated;
      els.popover.appendChild(quote);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'popover-textarea';
    textarea.placeholder = info.isFullDoc
      ? '告诉 AI 怎么改整篇：「补更多例题」「改成更严谨的证明风格」「补一个总结表」…'
      : '告诉 AI 怎么改：「补一个例子」「化简这段」「加公式推导」…';
    textarea.rows = 3;
    els.popover.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'popover-actions';
    const btnSubmit = document.createElement('button');
    btnSubmit.className = 'btn-primary';
    btnSubmit.textContent = info.isFullDoc
      ? '重写整篇讲义'
      : (state.applyMode === 'auto-apply' ? '直接改写' : '发送给 AI');
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-ghost';
    btnCancel.textContent = '取消';
    actions.appendChild(btnSubmit);
    actions.appendChild(btnCancel);
    els.popover.appendChild(actions);

    els.popover.hidden = false;

    requestAnimationFrame(() => textarea.focus());

    function submit() {
      const instruction = textarea.value.trim();
      if (!instruction) {
        textarea.classList.add('empty-flash');
        setTimeout(() => textarea.classList.remove('empty-flash'), 400);
        return;
      }
      if (currentMode === 'rewrite') {
        submitInlineSuggest(info, instruction);
      } else if (currentMode === 'ask') {
        submitInlineAsk(info, instruction);
      } else {
        submitInlineIdea(info, instruction);
      }
      hidePopover();
    }

    btnSubmit.addEventListener('click', submit);
    btnCancel.addEventListener('click', () => {
      hidePopover();
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePopover();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
  }

  /** ask 模式：让 AI 以聊天形式回答，结果以建议气泡显示但不写回。 */
  function submitInlineAsk(info, instruction) {
    if (!vscode) return;
    const turnId = (helpers.uuid && helpers.uuid()) || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    state.activeTurns.set(turnId, {
      info: { startLine: info.startLine, endLine: info.endLine, text: info.text || '', rect: info.rect },
      instruction,
      mode: 'ask',
    });
    showPendingBubble(turnId, info);
    vscode.postMessage({
      type: 'inlineSuggest',
      request: {
        filePath: state.filePath,
        selectionText: info.text || '',
        sourceLineStart: info.startLine,
        sourceLineEnd: info.endLine,
        instruction: '【模式：提问，仅回答，不修改文件】' + instruction,
        applyMode: 'preview-confirm', // 强制 preview，禁止自动写回
        turnId,
        intent: 'ask',
      },
    });
  }

  /** idea 模式：本地直接把想法作为 callout 块追加到选区下方，不调 AI。 */
  function submitInlineIdea(info, instruction) {
    if (!vscode) return;
    const turnId = (helpers.uuid && helpers.uuid()) || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const ideaBlock = wrapAsCallout('💡 我的想法', instruction, { summary: instruction });
    vscode.postMessage({
      type: 'inlineApply',
      request: {
        turnId,
        filePath: state.filePath,
        selectionText: info.text || '',
        sourceLineStart: info.startLine,
        sourceLineEnd: info.endLine,
        finalContent: ideaBlock,
        intent: 'idea',
      },
    });
  }

  /**
   * 把一段任意 Markdown 内容包成"可折叠的 callout 块"。
   *
   * 用 <details>/<summary> + 顶部 --- 分隔线，summary 行显示问题/想法的
   * 梗概（最多 80 字），body 是完整内容。markdown-it html:true 已开，
   * 配合 lecture-webview CSS 自带 <details> 折叠样式，默认折叠减少视觉噪音。
   *
   * 内部内容仍是 markdown 原文 —— <details> 块体的 markdown 解析在
   * markdown-it 里默认是关闭的，所以需要在 <summary> 后留空行让 md 继续
   * 解析里面的内容（这是 CommonMark 标准 HTML-in-MD 行为）。
   */
  function wrapAsCallout(label, rawContent, opts) {
    var body = normalizeMarkdown(rawContent);
    opts = opts || {};
    var summaryText = (opts.summary != null ? String(opts.summary) : '').trim();
    if (!summaryText) {
      // 默认用 body 第一行作为梗概
      summaryText = body.split(/\n/)[0] || label;
    }
    summaryText = summaryText.replace(/^[#>*\-\s`]+/, '').trim();
    if (summaryText.length > 80) summaryText = summaryText.slice(0, 78) + '…';
    summaryText = escapeAttr(summaryText);

    return '\n\n---\n\n<details class="cc-qa">\n<summary><strong>' + label + '</strong> · ' +
      summaryText + '</summary>\n\n' + body + '\n\n</details>\n';
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 规整 AI / 用户输入：
   *  - 统一换行
   *  - 剥掉 AI 偶尔包出来的 ```markdown ... ``` 围栏（内部代码块不会被误伤）
   *  - 首尾 trim
   *  - 折叠 3+ 连续空行为 2 个（避免 callout 内塌缩出大段空白）
   */
  function normalizeMarkdown(text) {
    var t = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    var fence = t.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
    if (fence) t = fence[1];
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  function submitInlineSuggest(info, instruction) {
    if (!vscode) return;
    const turnId = (helpers.uuid && helpers.uuid()) || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    state.activeTurns.set(turnId, {
      info: { startLine: info.startLine, endLine: info.endLine, text: info.text || '', rect: info.rect },
      instruction,
    });

    showPendingBubble(turnId, info);

    vscode.postMessage({
      type: 'inlineSuggest',
      request: {
        filePath: state.filePath,
        selectionText: info.text || '',
        sourceLineStart: info.startLine,
        sourceLineEnd: info.endLine,
        instruction,
        applyMode: state.applyMode,
        turnId,
      },
    });
  }

  // ===== suggestion bubbles =====

  function bubbleAnchorRect(turnId) {
    // 优先按 data-source-line 找当前文档里对应起点元素
    const turn = state.activeTurns.get(turnId);
    if (!turn) return null;
    const startLine = turn.info.startLine;
    const startEl = els.body.querySelector(`[data-source-line="${startLine}"]`);
    if (startEl) {
      return startEl.getBoundingClientRect();
    }
    return turn.info.rect || null;
  }

  function ensureBubble(turnId) {
    let bubble = bubbles.get(turnId);
    if (bubble && document.body.contains(bubble)) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'lecture-suggestion-bubble';
    bubble.dataset.turnId = turnId;
    document.body.appendChild(bubble);
    bubbles.set(turnId, bubble);
    return bubble;
  }

  function positionBubble(bubble, anchor) {
    if (!anchor) return;
    const top = window.scrollY + anchor.bottom + 10;
    const left = Math.max(16, Math.min(window.scrollX + anchor.left, window.innerWidth - 460));
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
  }

  // ===== streaming 状态：每个 turn 一个 buffer，50ms 节流 re-render markdown =====
  state.streamingTurns = state.streamingTurns || new Map();

  function initStreamingBubble(turnId) {
    const turn = state.activeTurns.get(turnId);
    if (!turn) return;
    const bubble = ensureBubble(turnId);
    bubble.classList.remove('pending', 'preview', 'applied', 'failed');
    bubble.classList.add('streaming');
    const tagLabel = (turn.mode === 'ask') ? 'AI 回答中…' : 'AI 生成中…';
    bubble.innerHTML = `
      <div class="bubble-header">
        <span class="bubble-tag">${tagLabel}</span>
        <span class="bubble-range">行 ${turn.info.startLine + 1}–${turn.info.endLine}</span>
      </div>
      <div class="bubble-body markdown-body" data-streaming-body></div>
    `;
    positionBubble(bubble, bubbleAnchorRect(turnId));
  }

  function updateStreamingBubble(turnId, text) {
    const bubble = bubbles.get(turnId);
    if (!bubble) return;
    const body = bubble.querySelector('[data-streaming-body]');
    if (!body) return;
    body.innerHTML = renderMarkdown(text);
    renderMath(body);
    // mermaid 渲染留到 final（每 50ms 重新 render mermaid 太重）
    positionBubble(bubble, bubbleAnchorRect(turnId));
  }

  function showPendingBubble(turnId, info) {
    const bubble = ensureBubble(turnId);
    bubble.classList.remove('preview', 'applied', 'failed', 'streaming');
    bubble.classList.add('pending');
    bubble.innerHTML = `
      <div class="bubble-header">
        <span class="bubble-tag">AI 思考中</span>
        <span class="bubble-range">行 ${info.startLine + 1}–${info.endLine}</span>
      </div>
      <div class="bubble-body bubble-loading">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    `;
    positionBubble(bubble, info.rect);
  }

  function showPreviewBubble(turnId, suggestion, intent) {
    const turn = state.activeTurns.get(turnId);
    if (!turn) return;
    const bubble = ensureBubble(turnId);
    bubble.classList.remove('pending', 'failed', 'applied');
    bubble.classList.add('preview');

    // intent 优先取后端透传的，其次从 turn 里拿
    const effectiveIntent = intent || turn.mode || 'rewrite';
    bubble.classList.toggle('ask', effectiveIntent === 'ask');

    bubble.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'bubble-header';
    const tagLabel = effectiveIntent === 'ask' ? 'AI 回答' : 'AI 建议';
    header.innerHTML = `
      <span class="bubble-tag">${tagLabel}</span>
      <span class="bubble-range">行 ${turn.info.startLine + 1}–${turn.info.endLine}</span>
    `;
    bubble.appendChild(header);

    const body = document.createElement('div');
    body.className = 'bubble-body markdown-body';
    body.innerHTML = renderMarkdown(suggestion);
    renderMath(body);
    void renderMermaid(body);
    void renderGraphviz(body);
    bubble.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'bubble-actions';

    if (effectiveIntent === 'ask') {
      // 提问模式：不写文件。提供"作为想法保存"和"关闭"两个按钮
      const btnSaveAsIdea = document.createElement('button');
      btnSaveAsIdea.className = 'btn-ghost';
      btnSaveAsIdea.textContent = '把回答存到讲义';
      btnSaveAsIdea.title = '把 AI 回答作为引用块追加到选区下方';
      const btnClose = document.createElement('button');
      btnClose.className = 'btn-primary';
      btnClose.textContent = '收到，关闭';
      actions.appendChild(btnSaveAsIdea);
      actions.appendChild(btnClose);
      btnSaveAsIdea.addEventListener('click', () => {
        if (!vscode) return;
        // 把 AI 回答作为 callout 块**追加到选区所在 block 之后**，
        // 不动选区原文，且保留 AI 输出内部所有 markdown 结构（代码块 / 公式 /
        // 表格 / 列表都不会再被 `>` 前缀破坏）。
        // 去掉 instruction 里的"【模式：...】"前缀，让 summary 显示真正的问题
        const rawQuestion = String((turn && turn.instruction) || '').replace(/^【[^】]*】/, '').trim();
        const note = wrapAsCallout('🤖 AI 回答', suggestion, { summary: rawQuestion });
        vscode.postMessage({
          type: 'inlineApply',
          request: {
            turnId,
            filePath: state.filePath,
            selectionText: turn.info.text || '',
            sourceLineStart: turn.info.startLine,
            sourceLineEnd: turn.info.endLine,
            finalContent: note,
            intent: 'ask',
          },
        });
      });
      btnClose.addEventListener('click', () => dismissSuggestion(turnId));
    } else {
      // rewrite 模式：原有"采纳/丢弃"
      const btnAccept = document.createElement('button');
      btnAccept.className = 'btn-primary';
      btnAccept.textContent = '采纳';
      const btnDiscard = document.createElement('button');
      btnDiscard.className = 'btn-ghost';
      btnDiscard.textContent = '丢弃';
      actions.appendChild(btnAccept);
      actions.appendChild(btnDiscard);
      btnAccept.addEventListener('click', () => acceptSuggestion(turnId, suggestion));
      btnDiscard.addEventListener('click', () => dismissSuggestion(turnId));
    }

    bubble.appendChild(actions);
    positionBubble(bubble, bubbleAnchorRect(turnId));
  }

  function showFailedBubble(turnId, errorMessage) {
    const turn = state.activeTurns.get(turnId);
    const bubble = ensureBubble(turnId);
    bubble.classList.remove('pending', 'preview', 'applied');
    bubble.classList.add('failed');
    bubble.innerHTML = `
      <div class="bubble-header">
        <span class="bubble-tag bubble-tag-error">AI 失败</span>
        ${turn ? `<span class="bubble-range">行 ${turn.info.startLine + 1}–${turn.info.endLine}</span>` : ''}
      </div>
      <div class="bubble-body">${(helpers.escapeHtml || ((s) => s))(errorMessage || '未知错误')}</div>
      <div class="bubble-actions"><button class="btn-ghost" data-act="close">关闭</button></div>
    `;
    bubble.querySelector('[data-act="close"]').addEventListener('click', () => removeBubble(turnId));
    positionBubble(bubble, bubbleAnchorRect(turnId));
  }

  function removeBubble(turnId) {
    const b = bubbles.get(turnId);
    if (b && b.parentNode) b.parentNode.removeChild(b);
    bubbles.delete(turnId);
    state.activeTurns.delete(turnId);
  }

  function acceptSuggestion(turnId, suggestion) {
    const turn = state.activeTurns.get(turnId);
    if (!turn || !vscode) return;
    vscode.postMessage({
      type: 'inlineApply',
      request: {
        turnId,
        filePath: state.filePath,
        selectionText: turn.info.text || '',
        sourceLineStart: turn.info.startLine,
        sourceLineEnd: turn.info.endLine,
        finalContent: normalizeMarkdown(suggestion),
        // rewrite 是 destructive 模式，后端会走严格匹配 replace；
        // 如果选区文本没法精确匹配（公式 / 富文本渲染差异），后端会返回 failed，
        // 不再静默覆盖原文。
        intent: 'rewrite',
      },
    });
    // 标记为正在写回
    const bubble = bubbles.get(turnId);
    if (bubble) {
      bubble.classList.remove('preview');
      bubble.classList.add('applied');
      bubble.querySelectorAll('.bubble-actions button').forEach((b) => (b.disabled = true));
      const tag = bubble.querySelector('.bubble-tag');
      if (tag) tag.textContent = '写回中…';
    }
  }

  function dismissSuggestion(turnId) {
    if (vscode) vscode.postMessage({ type: 'inlineDismiss', turnId });
    removeBubble(turnId);
  }

  // ===== flash highlight =====

  function flashChangedRange(range) {
    if (!range) return;
    const start = Number(range.startLine);
    const end = Number(range.endLine);
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    const candidates = els.body.querySelectorAll('[data-source-line]');
    candidates.forEach((node) => {
      const ln = parseInt(node.getAttribute('data-source-line'), 10);
      if (Number.isNaN(ln)) return;
      if (ln >= start && ln < end + 1) {
        node.classList.add('flash-changed');
        setTimeout(() => node.classList.remove('flash-changed'), state.highlightChangesMs || 5000);
      }
    });
  }

  // ===== toasts =====

  function toast(message, level) {
    if (!els.toastContainer) return;
    const el = document.createElement('div');
    el.className = `lecture-toast ${level || 'info'}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, 3200);
  }

  // ===== undo pill =====
  // 写回成功后，右下角浮出一个"↶ 撤回上次写入"小药丸。点击后让宿主用 .bak
  // 还原。10 秒不点自动隐藏（再次写回时会重新显示）。
  let _undoPillEl = null;
  let _undoPillTimer = null;

  function ensureUndoPill() {
    if (_undoPillEl && document.body.contains(_undoPillEl)) return _undoPillEl;
    const el = document.createElement('button');
    el.className = 'lecture-undo-pill';
    el.type = 'button';
    el.textContent = '↶ 撤回上次写入';
    el.title = '把讲义恢复到上一次写入之前的状态（再点一次可重做）';
    el.addEventListener('click', () => {
      if (!vscode) return;
      vscode.postMessage({ type: 'revertLastWriteback' });
      // 文案切换，提示 redo 语义
      el.textContent = '↷ 重做（再撤回）';
    });
    document.body.appendChild(el);
    _undoPillEl = el;
    return el;
  }

  function showUndoPill() {
    const el = ensureUndoPill();
    el.classList.add('visible');
    el.textContent = '↶ 撤回上次写入';
    if (_undoPillTimer) clearTimeout(_undoPillTimer);
    _undoPillTimer = setTimeout(() => {
      el.classList.remove('visible');
    }, 12000);
  }

  // ===== events =====
  // 旧实现用 mouseup/selectionchange/keyup 监听选区变化来 show/hide chip——
  // 这在代码块 / 跨块选区 / 没选区时全部失败（用户能选中但 chip 召不出来）。
  // 新实现：chip 是右上角常驻按钮，永远在那儿，不依赖任何选区事件。
  // 点击 chip → pickContextInfo() 自己判断当前是不是有选区，渲染对应 popover。

  document.addEventListener('mousedown', (e) => {
    // 点 chip 自身不收 popover
    if (e.target.closest && e.target.closest('#chip')) return;
    // 点评论框 / 气泡内部不收
    if (e.target.closest && (e.target.closest('#popover') || e.target.closest('.lecture-suggestion-bubble'))) return;
    hidePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePopover();
    }
  });

  // Ctrl+滚轮 整体缩放（讲义阅读器独立 panel，本地缩放）
  let _lectureFontScale = 1;
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    _lectureFontScale = Math.max(0.7, Math.min(2.0, _lectureFontScale + delta));
    document.body.style.zoom = String(_lectureFontScale);
  }, { passive: false });

  if (els.chip) {
    els.chip.addEventListener('click', () => {
      // 每次点击都重新取一次 selection：用户可能在打开 popover 前选好了一段，
      // 也可能什么都没选；pickContextInfo 处理两种情况。
      const info = pickContextInfo();
      currentSelectionInfo = info;
      showPopoverFor(info);
    });
  }

  if (els.btnReload && vscode) {
    els.btnReload.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestReload' });
    });
  }

  window.addEventListener('resize', () => {
    bubbles.forEach((bubble, turnId) => {
      positionBubble(bubble, bubbleAnchorRect(turnId));
    });
  });

  // ===== host messages =====

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'init': {
        state.filePath = msg.filePath || '';
        state.applyMode = msg.applyMode || 'preview-confirm';
        state.highlightChangesMs = msg.highlightChangesMs || 5000;
        setHeader(msg);
        renderLecture(msg.content || '');
        flashStatus('已加载', 'info');
        break;
      }
      case 'lectureFileChanged': {
        renderLecture(msg.content || '');
        if (msg.appliedRange) {
          flashChangedRange(msg.appliedRange);
        }
        if (msg.turnId) {
          // 写回完成：移除对应气泡
          removeBubble(msg.turnId);
          toast('已写回讲义', 'success');
          showUndoPill();
        } else {
          flashStatus('已刷新', 'info');
        }
        // 重新定位剩余气泡
        bubbles.forEach((bubble, turnId) => {
          positionBubble(bubble, bubbleAnchorRect(turnId));
        });
        break;
      }
      case 'aiStreamDelta': {
        // 流式 token 到达 → 累加到 turn buffer，50ms 节流 re-render preview bubble
        if (msg.channel !== 'lecture' || !msg.turnId) break;
        if (!state.activeTurns.has(msg.turnId)) break;
        let entry = state.streamingTurns.get(msg.turnId);
        if (!entry) {
          entry = { buf: '', lastRenderAt: 0, trailingTimer: null };
          state.streamingTurns.set(msg.turnId, entry);
          initStreamingBubble(msg.turnId);
        }
        entry.buf += (msg.delta || '');
        const now = Date.now();
        if (now - entry.lastRenderAt > 50) {
          entry.lastRenderAt = now;
          updateStreamingBubble(msg.turnId, entry.buf);
        } else if (!entry.trailingTimer) {
          entry.trailingTimer = setTimeout(() => {
            const e = state.streamingTurns.get(msg.turnId);
            if (!e) return;
            e.lastRenderAt = Date.now();
            e.trailingTimer = null;
            updateStreamingBubble(msg.turnId, e.buf);
          }, 60);
        }
        break;
      }
      case 'aiStreamEnd': {
        if (msg.channel !== 'lecture' || !msg.turnId) break;
        const entry = state.streamingTurns.get(msg.turnId);
        if (entry?.trailingTimer) clearTimeout(entry.trailingTimer);
        // 最后一次渲染用 finalText（已经过 stripFenceWrapper trim 的版本）
        if (typeof msg.finalText === 'string') {
          updateStreamingBubble(msg.turnId, msg.finalText);
        } else if (entry) {
          updateStreamingBubble(msg.turnId, entry.buf);
        }
        state.streamingTurns.delete(msg.turnId);
        // 后续 inlineSuggestResult preview 会重新构建 bubble 加 采纳/丢弃 按钮
        break;
      }
      case 'inlineSuggestResult': {
        const result = msg.result || {};
        const { turnId, status, suggestion, errorMessage, appliedRange, intent } = result;
        if (!turnId) return;
        if (status === 'preview') {
          showPreviewBubble(turnId, suggestion || '', intent);
        } else if (status === 'applied') {
          if (appliedRange) flashChangedRange(appliedRange);
          removeBubble(turnId);
          toast('AI 已直接改写', 'success');
          showUndoPill();
        } else if (status === 'failed') {
          showFailedBubble(turnId, errorMessage || 'AI 处理失败');
          toast(errorMessage || 'AI 处理失败', 'error');
        }
        break;
      }
      case 'inlineApplied': {
        if (msg.appliedRange) flashChangedRange(msg.appliedRange);
        removeBubble(msg.turnId);
        toast('已采纳并写回', 'success');
        showUndoPill();
        break;
      }
      case 'log': {
        if (msg.level === 'error') toast(msg.message, 'error');
        else if (msg.level === 'warn') toast(msg.message, 'warn');
        else if (msg.level === 'info') toast(msg.message, 'info');
        break;
      }
      default:
        break;
    }
  });

  // 通知宿主 webview 已就绪（如果宿主一开始就发了 init，会被忽略——init 在 createWebviewPanel 之后才 post，此时 webview 已开始监听）
  if (vscode) {
    vscode.postMessage({ type: 'ready' });
  }
})();
