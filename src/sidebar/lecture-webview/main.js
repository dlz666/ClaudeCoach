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
      // 注意：widget/mermaid/dot 的特殊处理**不放在 highlight 函数里**！
      // 原因：当 highlight 返回的字符串包含完整 <pre> 时，markdown-it 直接用
      // 这个字符串作为 fence 输出，绕过 md.renderer.rules.fence（那里负责
      // 注入 data-source-line）。结果：pre.widget-source 没有行号属性，
      // inheritSourceLines 继承不到东西 → 删除/呼叫菜单都拿不到行号。
      // 解决：把这些自定义渲染**整段搬到 fence renderer 里**（见下方），
      // 在那里手动把 data-source-line 拼进返回的 HTML 字符串。
      // highlight 只剩 hljs 这一种通用代码高亮路径。
      highlight: (str, lang) => {
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
    // 自定义 html_block renderer：让 raw HTML 块（<div class="cc-suggest">、<details>
    // 等）也拿到 data-source-line。默认 html_block renderer 直接 return token.content
    // 字符串，完全跳过 token.attrs —— 跟 fence 的同根问题。这里把 data-source-line
    // 注入到第一个开标签里。
    const defaultHtmlBlock = md.renderer.rules.html_block;
    md.renderer.rules.html_block = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      if (token.map && token.level === 0) {
        const startLine = String(token.map[0]);
        const endLine = String(token.map[1]);
        const html = String(token.content || '');
        // 找内容里第一个开标签，注入 data-source-line / data-source-line-end
        const injected = html.replace(
          /<([a-z][a-z0-9]*)\b([^>]*)>/i,
          `<$1$2 data-source-line="${startLine}" data-source-line-end="${endLine}">`,
        );
        return injected;
      }
      return (defaultHtmlBlock || ((t, i, o, e, s) => s.renderToken(t, i, o)))(tokens, idx, options, env, self);
    };

    // 自定义 fence renderer：widget/mermaid/dot 在这里直接生成 HTML，并手动
    // 注入 data-source-line（这样 inheritSourceLines → widget container 才有
    // 行号 → ⋯ 菜单的"删除"/"呼叫"才能拿到）。其他语言走默认 fence renderer，
    // 默认 renderer 又会调 highlight 函数（hljs 通用高亮）。
    const escapeFenceHtml = (s) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      const info = (token.info || '').trim();
      const lang = info.split(/\s+/g)[0];
      const sourceLineAttrs = (token.map && token.level === 0)
        ? ` data-source-line="${token.map[0]}" data-source-line-end="${token.map[1]}"`
        : '';
      const escaped = escapeFenceHtml(token.content);
      if (lang === 'widget' || lang === 'interactive' || lang === 'demo') {
        return `<pre class="widget-source"${sourceLineAttrs}><code class="language-widget">${escaped}</code></pre>`;
      }
      if (lang === 'mermaid') {
        return `<pre class="mermaid-source"${sourceLineAttrs}><code class="language-mermaid">${escaped}</code></pre>`;
      }
      if (lang === 'dot' || lang === 'graphviz') {
        return `<pre class="dot-source"${sourceLineAttrs}><code class="language-dot">${escaped}</code></pre>`;
      }
      // 通用 fence：也补一下 source-line（attachSourceLines 设的 attrs 会被
      // highlight 字符串路径吞掉，所以这里保险再 attrSet 一次）
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
    // 不要扫 pre/code/script —— 否则 widget 代码里的 `${var}` 会被 KaTeX 当成
    // `$...$` 内联公式去渲染，搞坏模板字符串
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    ignoredClasses: ['widget-source', 'dot-source', 'mermaid-source', 'cc-widget-source-panel'],
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
      // 跟随 VS Code 主题。优先看 body 上的 vscode-* class（最可靠），
      // 否则回退到背景色亮度判断。
      let isDark = false;
      const cls = document.body.className || '';
      if (/vscode-(dark|high-contrast(?!-light))/.test(cls)) {
        isDark = true;
      } else if (/vscode-(light|high-contrast-light)/.test(cls)) {
        isDark = false;
      } else {
        const bg = getComputedStyle(document.body).backgroundColor || '';
        const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
          isDark = lum < 128;
        }
      }
      window.mermaid.initialize({
        startOnLoad: false,
        // 重要：只有 theme: 'base' 会完整应用 themeVariables 覆盖；
        // 'neutral' / 'default' / 'dark' 都自带预设主题，只接受部分变量。
        theme: 'base',
        themeVariables: isDark
          ? {
              // 节点填充色：偏蓝灰，跟 VS Code 深色面板呼应
              primaryColor: '#1f3654',
              primaryTextColor: '#ffffff',
              primaryBorderColor: '#5b9bd5',
              // 边线 / 箭头颜色
              lineColor: '#cbd5e0',
              // 第二/第三层节点（subgraph / cluster）
              secondaryColor: '#2d4a6b',
              secondaryTextColor: '#ffffff',
              secondaryBorderColor: '#7da4d1',
              tertiaryColor: '#1a2b3f',
              tertiaryTextColor: '#ffffff',
              tertiaryBorderColor: '#5b9bd5',
              // 通用文字
              textColor: '#ffffff',
              labelTextColor: '#ffffff',
              nodeTextColor: '#ffffff',
              // sequence diagram 专用
              actorBkg: '#1f3654',
              actorBorder: '#5b9bd5',
              actorTextColor: '#ffffff',
              actorLineColor: '#cbd5e0',
              signalColor: '#cbd5e0',
              signalTextColor: '#ffffff',
              labelBoxBkgColor: '#1f3654',
              labelBoxBorderColor: '#5b9bd5',
              loopTextColor: '#ffffff',
              activationBkgColor: '#2d4a6b',
              activationBorderColor: '#7da4d1',
              noteBkgColor: '#fef3c7',
              noteBorderColor: '#f59e0b',
              noteTextColor: '#1f2937',
              // 状态图 / 类图
              stateLabelColor: '#ffffff',
              transitionColor: '#cbd5e0',
              transitionLabelColor: '#ffffff',
              // cluster 子图背景
              clusterBkg: '#283f5e',
              clusterBorder: '#5b9bd5',
              // edge label 背景小盒子（图边上 weight 数字底色）
              edgeLabelBackground: '#1e1e1e',
              // 浅灰二级文字（不易看到的元数据）改成中亮度
              titleColor: '#ffffff',
            }
          : {
              primaryColor: '#dbeafe',
              primaryTextColor: '#0f1419',
              primaryBorderColor: '#2563eb',
              lineColor: '#1f2937',
              secondaryColor: '#fde68a',
              secondaryTextColor: '#0f1419',
              secondaryBorderColor: '#f59e0b',
              tertiaryColor: '#ecfccb',
              tertiaryTextColor: '#0f1419',
              tertiaryBorderColor: '#65a30d',
              textColor: '#0f1419',
              labelTextColor: '#0f1419',
              nodeTextColor: '#0f1419',
              actorBkg: '#dbeafe',
              actorBorder: '#2563eb',
              actorTextColor: '#0f1419',
              actorLineColor: '#1f2937',
              signalColor: '#1f2937',
              signalTextColor: '#0f1419',
              labelBoxBkgColor: '#dbeafe',
              labelBoxBorderColor: '#2563eb',
              loopTextColor: '#0f1419',
              activationBkgColor: '#fde68a',
              activationBorderColor: '#f59e0b',
              noteBkgColor: '#fef3c7',
              noteBorderColor: '#f59e0b',
              noteTextColor: '#0f1419',
              stateLabelColor: '#0f1419',
              transitionColor: '#1f2937',
              transitionLabelColor: '#0f1419',
              clusterBkg: '#f3f4f6',
              clusterBorder: '#9ca3af',
              edgeLabelBackground: '#ffffff',
              titleColor: '#0f1419',
            },
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });
      mermaidInited = true;
    } catch (err) {
      console.warn('mermaid init failed', err);
    }
  }

  /**
   * 替换占位 <pre> 为渲染容器时，把 data-source-line / data-source-line-end
   * 从 pre 继承到新容器上 —— 否则 getSelectionLineRange 找不到行号，用户在
   * mermaid SVG / DOT SVG / widget iframe 内选区，点蓝色按钮拿不到上下文。
   */
  function inheritSourceLines(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    const s = fromEl.getAttribute('data-source-line');
    const e = fromEl.getAttribute('data-source-line-end');
    if (s) toEl.setAttribute('data-source-line', s);
    if (e) toEl.setAttribute('data-source-line-end', e);
  }

  /**
   * 给 mermaid / dot 渲染产物外面包一个 .cc-chart-wrap：顶部 toolbar (复制源码 /
   * { } 显示源码) + 渲染输出 + 隐藏的源码面板（默认折叠，点 { } 展开）。
   *
   * 关键：源码面板是普通 <pre> 在 lecture-body 文档里 —— 用户在里面选文字，
   * window.getSelection() 直接可读，配合容器继承的 data-source-line，
   * pickContextInfo 拿得到原始位置 + 文本，点蓝色按钮就能基于选区提问。
   */
  function wrapChartWithToolbar(rendered, rawSource, sourceLang, kind /* 'mermaid' | 'dot' */) {
    const wrap = document.createElement('div');
    wrap.className = 'cc-chart-wrap';

    const toolbar = document.createElement('div');
    toolbar.className = 'cc-chart-toolbar';
    toolbar.innerHTML = `
      <span class="cc-chart-label">${kind === 'mermaid' ? 'Mermaid' : 'DOT'}</span>
      <span class="cc-chart-spacer"></span>
      <button class="cc-chart-btn" data-action="copy-source" title="复制源码到剪贴板">📋 复制源码</button>
      <button class="cc-chart-btn" data-action="toggle-source" title="显示/隐藏源码，可选中里面文字后点蓝色按钮提问">{ }</button>
    `;
    wrap.appendChild(toolbar);

    wrap.appendChild(rendered);

    const srcPanel = document.createElement('pre');
    srcPanel.className = 'cc-chart-source-panel hidden';
    const srcCode = document.createElement('code');
    srcCode.className = 'language-' + sourceLang;
    srcCode.textContent = rawSource;
    srcPanel.appendChild(srcCode);
    wrap.appendChild(srcPanel);

    toolbar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      if (act === 'toggle-source') {
        srcPanel.classList.toggle('hidden');
      } else if (act === 'copy-source') {
        try {
          navigator.clipboard.writeText(rawSource).then(() => {
            const orig = btn.textContent;
            btn.textContent = '✓ 已复制';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          });
        } catch (_e) { /* ignore */ }
      }
    });

    return wrap;
  }

  // widget iframe 跨源，父页 getSelection 看不到。bridge 通过 postMessage 把选区
  // 文本上报到这里，pickContextInfo 没拿到 lecture 选区时回退用它。
  let _lastWidgetSelection = null;
  const WIDGET_SELECTION_STALE_MS = 30000;

  // widget 高度上报历史。key = widget id，value = 最近 N 次 { t, h }。
  // 用于侦测 vh 循环增长：AI 写 widget 里用了 100vh / vmin 等 viewport 单位时，
  // iframe 增高 → vh 元素跟着增 → bridge 又上报更大值 → 死循环。
  // 检测：连续 4 次都是小幅单调增长（每次 5-80px）→ 锁定到循环开始前的高度。
  const _widgetHeightHistory = new Map();
  const _WIDGET_HEIGHT_HISTORY_MAX = 6;
  const _WIDGET_LOOP_MIN_RUN = 4;        // 连续多少次小幅增长才判定循环
  const _WIDGET_LOOP_INC_MIN = 5;        // 单次增量下限（更小当抖动忽略）
  const _WIDGET_LOOP_INC_MAX = 80;       // 单次增量上限（更大是真实变化）
  const _WIDGET_UNLOCK_DELTA = 200;      // 锁定后差距 > 这个值视为真实变化，自动解锁

  // Ctrl+滚轮缩放期间挂起 widget 高度自适应（zoom 会传到 iframe 内部 viewport，
  // 让 vh 元素跟着变，bridge 上报的 reportedH 会跳一大段触发误解锁 + 疯狂增长）。
  // wheel handler 设置此标记，缩放停止 400ms 后清除并触发 relockWidgetHeight。
  let _isZooming = false;

  // 当前讲义整体缩放倍数（Ctrl+滚轮触发的 document.body.style.zoom 同步值）。
  // 提到 IIFE 顶部是因为 makeWidgetContainer 创建新 widget 时需要立即应用反向 zoom：
  //   body.zoom = scale  ×  widget.zoom = 1/scale  =  1（widget 视觉不被 zoom 拉伸）
  // 这是治根的解 —— 不让父 zoom 传到 iframe 内部 viewport，vh 元素就不会循环。
  let _lectureFontScale = 1;

  // 每个 widget container 关联的原始源码。⋯ 菜单的"呼叫"动作要把这段源码作为
  // chip 选区的 text 注入 popover，让用户跟 AI 谈这个 widget 时上下文完整。
  // 用 WeakMap 是避免 container 移除后内存泄漏。
  const _widgetUserSrc = new WeakMap();

  /**
   * 在送给 mermaid 之前自动给节点标签加引号 —— AI 经常生成 `A[dist[s]=0]` 这种
   * 嵌套括号写法，mermaid 解析器没办法处理。state machine 逐字符扫：遇到
   * `<id>[`/`(`/`{` 节点定义就用 depth 跟踪匹配的闭合括号，如果中间出现需要
   * 转义的字符（[ ] ( ) { } < > " | / \）就给整个 label 包 "..."。
   *
   * 安全：已经包了 "..." 的不再重复；mermaid 配置行（%%{init...}%%、classDef）
   * 跳过。
   */
  function preprocessMermaidSrc(src) {
    if (!src || typeof src !== 'string') return src;
    return src.split('\n').map(rewriteMermaidLine).join('\n');
  }

  const _MERMAID_NEEDS_QUOTE = /[\[\](){}<>"|/\\]/;

  function rewriteMermaidLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return line;
    // mermaid directives / styles 都不动
    if (/^(%%|classDef\b|class\b|style\b|linkStyle\b|click\b)/.test(trimmed)) return line;

    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (/[A-Za-z_]/.test(c)) {
        // 读 identifier
        let j = i;
        while (j < n && /\w/.test(line[j])) j++;
        const opener = line[j];
        if (opener === '[' || opener === '(' || opener === '{') {
          // 计连续开括号数（[[ / (( 等）
          let openerLen = 0;
          while (line[j + openerLen] === opener) openerLen++;
          const close = opener === '[' ? ']' : opener === '(' ? ')' : '}';
          const contentStart = j + openerLen;
          // depth 跟踪，找到对应等级的闭括号
          let depth = openerLen;
          let k = contentStart;
          let inStr = false;
          while (k < n) {
            const ch = line[k];
            if (inStr) {
              if (ch === '"') inStr = false;
              k++;
              continue;
            }
            if (ch === '"') { inStr = true; k++; continue; }
            if (ch === opener) depth++;
            else if (ch === close) {
              depth--;
              if (depth === 0) break;
            }
            k++;
          }
          if (k >= n) {
            // 没找到匹配 close，整段原样输出
            out += line.slice(i, contentStart);
            i = contentStart;
            continue;
          }
          // closer 是从 (k - openerLen + 1) 到 k 的连续 close 字符
          const closerStart = k - openerLen + 1;
          const content = line.slice(contentStart, closerStart);
          const closer = line.slice(closerStart, k + 1);
          const c_trimmed = content.trim();
          const alreadyQuoted = c_trimmed.startsWith('"') && c_trimmed.endsWith('"');
          if (!alreadyQuoted && _MERMAID_NEEDS_QUOTE.test(content)) {
            const escaped = content.replace(/"/g, '#quot;');
            out += line.slice(i, contentStart) + '"' + escaped + '"' + closer;
          } else {
            out += line.slice(i, k + 1);
          }
          i = k + 1;
          continue;
        }
        // 不是节点定义，identifier 原样输出
        out += line.slice(i, j);
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
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
      // 用 textContent 拿到原始 mermaid 源（已 unescape HTML 实体），
      // 然后自动给嵌套括号的 label 包引号
      const rawSource = codeEl.textContent || '';
      const source = preprocessMermaidSrc(rawSource);
      const id = `mermaid-${Date.now().toString(36)}-${counter++}`;
      try {
        const { svg } = await window.mermaid.render(id, source);
        const inner = document.createElement('div');
        inner.className = 'mermaid-rendered';
        inner.innerHTML = svg;
        const wrap = wrapChartWithToolbar(inner, rawSource, 'mermaid', 'mermaid');
        inheritSourceLines(pre, wrap);
        pre.replaceWith(wrap);
      } catch (err) {
        console.warn('mermaid render failed for block', id, err);
        // 降级：显示源码 + 给 mermaid.live 链接（用 base64 编码 state JSON）
        const fallback = document.createElement('div');
        fallback.className = 'mermaid-fallback';
        const escaped = (rawSource || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let liveUrl = 'https://mermaid.live/';
        try {
          const state = { code: rawSource, mermaid: { theme: 'neutral' }, autoSync: true, updateDiagram: true };
          const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
          liveUrl = 'https://mermaid.live/edit#base64:' + b64;
        } catch { /* keep default URL */ }
        const errMsg = (err && err.message ? String(err.message) : '语法错').slice(0, 200);
        fallback.innerHTML = `
          <div class="mermaid-fallback-banner">⚠ Mermaid 图渲染失败：${errMsg.replace(/[<&]/g, (c) => c === '<' ? '&lt;' : '&amp;')}</div>
          <pre><code class="language-mermaid">${escaped}</code></pre>
          <a href="${liveUrl}" target="_blank" rel="noopener">在 mermaid.live 调试</a>
        `;
        inheritSourceLines(pre, fallback);
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
        const inner = document.createElement('div');
        inner.className = 'graphviz-rendered';
        inner.innerHTML = svg;
        // SVG 尺寸：保留 GraphViz 输出的自然 pt 尺寸（例如 width="200pt" ≈ 266px），
        // **不要删 width/height** —— 一旦删了浏览器会按 viewBox 把 svg 撑满父容器宽度，
        // 简单 2-3 节点图会被放大成跟讲义同宽，节点跟文字比例严重失调（用户实测反馈）。
        // CSS 的 max-width: 100%（见 .graphviz-rendered svg）兜底超大图溢出。
        const svgEl = inner.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
          // GraphViz 默认给 text / 节点 / 边输出 inline fill="black" stroke="black"，
          // inline 属性特异度最高 → CSS 里 .graphviz-rendered svg text { fill: ... } 干不过。
          // 这里逐个把 black 的 inline 属性删掉，让 CSS（白底深字风格）能 cover。
          svgEl.querySelectorAll('[fill="black"], [fill="#000000"], [fill="#000"]').forEach((el) => {
            el.removeAttribute('fill');
          });
          svgEl.querySelectorAll('[stroke="black"], [stroke="#000000"], [stroke="#000"]').forEach((el) => {
            el.removeAttribute('stroke');
          });
          // GraphViz 给 cluster 输出 fill="none"，保留（让 CSS 给 cluster polygon 单独填浅灰）。
          // 但有些版本给 node polygon 也输出 fill="none"，会让节点透明 → 删掉 fill="none" 让 CSS 接管
          svgEl.querySelectorAll('.node [fill="none"]').forEach((el) => {
            el.removeAttribute('fill');
          });
        }
        const wrap = wrapChartWithToolbar(inner, source, 'dot', 'dot');
        inheritSourceLines(pre, wrap);
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
        inheritSourceLines(pre, fallback);
        pre.replaceWith(fallback);
      }
      counter++;
    }
  }

  // ===== Interactive Widget (iframe sandbox) =====
  /**
   * ```widget 代码块渲染：AI 输出完整 HTML+JS+CSS，我们包到 iframe srcdoc 里
   * 用 sandbox="allow-scripts"（无 allow-same-origin → unique 不可信源），加严
   * 格 CSP 阻止网络 / 父页访问。bridge 脚本负责高度自适应 + 错误回传。
   *
   * 安全模型：
   *   - sandbox=allow-scripts 但 NO allow-same-origin → 子页访问不到父 window
   *   - meta CSP connect-src 'none' → fetch/XHR/WebSocket 全部 die
   *   - meta CSP frame-src 'none' → 防嵌套 iframe 越狱
   *   - meta CSP form-action 'none' → form submit 不能外发
   *   - 任何 script 死循环只死自己这个 iframe，不影响主 webview
   */
  function renderWidgets(root) {
    if (!root) return;
    const blocks = root.querySelectorAll('pre.widget-source code.language-widget');
    let counter = 0;
    for (const codeEl of blocks) {
      const pre = codeEl.parentElement;
      if (!pre) continue;
      const userSrc = codeEl.textContent || '';
      const id = 'cc-widget-' + Date.now().toString(36) + '-' + (counter++);
      const container = makeWidgetContainer(userSrc, id);
      inheritSourceLines(pre, container);
      pre.replaceWith(container);
    }
  }

  function makeWidgetContainer(userSrc, id) {
    const container = document.createElement('div');
    container.className = 'cc-widget-container';
    container.dataset.widgetId = id;
    // 把 userSrc 关联到 container：⋯ 菜单的"呼叫"动作要把这段源码注入 popover。
    _widgetUserSrc.set(container, userSrc);
    // 反向 zoom 抵消 body.zoom：CSS zoom 在父子之间是相乘关系，
    // body × widget = scale × (1/scale) = 1 → widget 视觉保持原大小。
    // 治根目的：让 widget iframe 内部 viewport 不被父 zoom 拉伸，
    // 否则 widget 内任何 vh / 100% 元素会跟着 zoom 涨 → 无限循环。
    if (_lectureFontScale !== 1) {
      container.style.zoom = String(1 / _lectureFontScale);
    }

    // 顶部 toolbar：⋯ 菜单（删除 / 呼叫） / 复制源码 / 重载 / 查看源码
    const toolbar = document.createElement('div');
    toolbar.className = 'cc-widget-toolbar';
    toolbar.innerHTML = `
      <button class="cc-widget-btn cc-widget-btn-more" data-action="more" title="更多操作（删除 / 呼叫 AI）" aria-haspopup="true">⋯</button>
      <span class="cc-widget-label">互动演示</span>
      <span class="cc-widget-spacer"></span>
      <button class="cc-widget-btn" data-action="copy-source" title="复制源码到剪贴板（方便发给开发者排查）">📋 复制源码</button>
      <button class="cc-widget-btn" data-action="reload" title="重新加载 + 重测高度（高度卡死/疯狂增长时按这个）">↻</button>
      <button class="cc-widget-btn" data-action="toggle-source" title="查看 / 隐藏源码">{ }</button>
    `;
    container.appendChild(toolbar);

    // 主题色从父 webview 抽出来注入 iframe
    const themeVars = getThemeVarsForWidget();
    const srcdoc = buildWidgetSrcdoc(userSrc, id, themeVars);

    const iframe = document.createElement('iframe');
    iframe.className = 'cc-widget-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('srcdoc', srcdoc);
    iframe.dataset.widgetId = id;
    iframe.style.width = '100%';
    iframe.style.height = '500px';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.setAttribute('title', '互动演示');
    container.appendChild(iframe);

    // 错误提示横条（默认隐藏）
    const errBanner = document.createElement('div');
    errBanner.className = 'cc-widget-error hidden';
    container.appendChild(errBanner);

    // console 日志面板（widget 内 console.log/warn/error 转发到这里，
    // 帮助排查"看起来渲染了但内容是空的"这种逻辑 bug）
    const consolePanel = document.createElement('div');
    consolePanel.className = 'cc-widget-console hidden';
    consolePanel.dataset.widgetId = id;
    container.appendChild(consolePanel);

    // 源码面板（默认隐藏，按 toolbar 切换）
    const srcPanel = document.createElement('pre');
    srcPanel.className = 'cc-widget-source-panel hidden';
    const srcCode = document.createElement('code');
    srcCode.textContent = userSrc;
    srcPanel.appendChild(srcCode);
    container.appendChild(srcPanel);

    // toolbar 按钮事件
    toolbar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      if (act === 'toggle-source') {
        srcPanel.classList.toggle('hidden');
      } else if (act === 'more') {
        // 弹 ⋯ 菜单（删除 / 呼叫）。锚在按钮下方左对齐。
        showWidgetMoreMenu(container, btn);
      } else if (act === 'reload') {
        // 重新加载 iframe 同时重测高度：自动循环检测不够鲁棒（某些非 vh 类型的
        // 持续增长会绕过 5-80px 区间检测），所以让 ↻ 始终兜底——清掉锁定 + history
        // + iframe 压到 100px，再重新 setAttribute srcdoc 让 bridge 从头跑一遍。
        relockWidgetHeight(container);
        iframe.setAttribute('srcdoc', srcdoc);
      } else if (act === 'copy-source') {
        try {
          navigator.clipboard.writeText(userSrc).then(
            () => {
              const orig = btn.textContent;
              btn.textContent = '✓ 已复制';
              setTimeout(() => { btn.textContent = orig; }, 1500);
            },
            () => { btn.textContent = '✗ 失败'; },
          );
        } catch (err) {
          // navigator.clipboard 不可用时降级到 execCommand
          const ta = document.createElement('textarea');
          ta.value = userSrc;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); btn.textContent = '✓ 已复制'; }
          catch (_e) { btn.textContent = '✗ 失败'; }
          document.body.removeChild(ta);
          setTimeout(() => { btn.textContent = '📋 复制源码'; }, 1500);
        }
      }
    });

    // bridge 上报真实高度后，iframe 完全跟随；不再强制最低 300。
    // 之前有 onload 兜底强行设 500，但 widget 小的话会显得空荡荡。

    return container;
  }

  function getThemeVarsForWidget() {
    const cs = getComputedStyle(document.body);
    const get = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    return {
      bg: get('--vscode-editor-background', '#1e1e1e'),
      fg: get('--vscode-foreground', '#e6e6e6'),
      muted: get('--vscode-descriptionForeground', '#9aa0a6'),
      accent: get('--vscode-button-background', '#0e7490'),
      accentFg: get('--vscode-button-foreground', '#ffffff'),
      border: get('--vscode-panel-border', '#3c3c3c'),
      inputBg: get('--vscode-input-background', '#252526'),
      inputFg: get('--vscode-input-foreground', '#cccccc'),
      panelBg: get('--vscode-sideBar-background', '#252526'),
    };
  }

  /**
   * 防御性补丁：扫 <script>...</script> 块内的字符串字面量，
   * 把里面的 `</script>` 改成 `<\/script>`。AI 经常在 JS 里写
   * `const html = "<script>...</script>"`，导致 HTML 解析器提前
   * 关 script 标签，后面所有 JS 都失效（widget 白屏）。
   *
   * 用 **贪婪匹配** 抓 LAST `</script>`：用户实际写了一对 script tag，
   * 中间嵌字符串里有 `</script>` → 贪婪能正确判断真正的关闭点。
   * 副作用：多个独立 script 块会被合并 —— widget 场景下基本只有 1-2 个
   * 块，可接受。`<\/script` 在 JS 里完全合法等价于 `</script`。
   */
  function patchScriptStrings(html) {
    const normalized = String(html || '').replace(/<\\\/script\s*>/gi, '</script>');
    return normalized.replace(/<script\b[^>]*>([\s\S]*)<\/script\s*>/gi, (match, body) => {
      const fixed = body.replace(/<\/(script\b)/gi, '<\\/$1');
      return match.replace(body, fixed);
    });
  }

  /**
   * 修 AI 经常写错的模板字符串：`$ {var}`（有空格）→ `${var}`（紧贴）。
   * 这个 bug 在 AI 生成代码里非常常见：插值失效后 querySelector 找不到匹配，
   * try/catch 一吞表面看着"渲染成功但内容空"。
   * 只在 <script> 体内修，HTML 属性外的"$ {" 不动。
   */
  function patchTemplateLiterals(html) {
    return html.replace(/<script\b[^>]*>([\s\S]*)<\/script\s*>/gi, (match, body) => {
      // 注意：只修复 backtick 内部的 `$ {`。简单做法：全局 replace `$ {` → `${`
      // 因为 `$ {` 在合法 JS 代码里几乎没意义（不是模板字符串就是字面美元加空格大括号），
      // 误伤代价极低。
      const fixed = body.replace(/\$\s+\{/g, '${');
      return match.replace(body, fixed);
    });
  }

  function buildWidgetSrcdoc(userSrc, id, t) {
    const trimmed = patchTemplateLiterals(patchScriptStrings(String(userSrc || '').trim()));
    const isFullDoc = /^<!doctype\s+html|^<html\b/i.test(trimmed);
    // CSP 是 widget iframe 自己的；和外面 webview CSP 是两套不同的策略层
    const cspMeta =
      `<meta http-equiv="Content-Security-Policy" content="` +
      `default-src 'none';` +
      `script-src 'unsafe-inline' 'unsafe-eval';` +
      `style-src 'unsafe-inline';` +
      `img-src data: blob:;` +
      `font-src data:;` +
      `media-src data:;` +
      `connect-src 'none';` +
      `frame-src 'none';` +
      `form-action 'none';` +
      `base-uri 'none';` +
      `">`;

    const themeStyle = `<style>
:root {
  color-scheme: dark light;
  --bg: ${cssSafe(t.bg)};
  --fg: ${cssSafe(t.fg)};
  --muted: ${cssSafe(t.muted)};
  --accent: ${cssSafe(t.accent)};
  --accent-fg: ${cssSafe(t.accentFg)};
  --border: ${cssSafe(t.border)};
  --input-bg: ${cssSafe(t.inputBg)};
  --input-fg: ${cssSafe(t.inputFg)};
  --panel-bg: ${cssSafe(t.panelBg)};
}
* { box-sizing: border-box; }
/* !important 锁死高度自适应：AI 的 widget CSS 可能写 body{height:100%} 之类，
   会让 scrollHeight 等于 iframe 当前高度（永远不增长），导致高度永远是初始 500 */
html, body {
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  margin: 0 !important;
  background: transparent;
  color: var(--fg);
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  font-size: 13px;
  line-height: 1.55;
}
body { padding: 14px; }
button {
  background: var(--accent);
  color: var(--accent-fg);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12.5px;
  font-family: inherit;
  transition: filter 120ms ease;
}
button:hover { filter: brightness(1.1); }
button:active { transform: scale(0.98); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.ghost {
  background: transparent;
  color: var(--fg);
  border-color: var(--border);
}
input, select, textarea {
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font: inherit;
}
table { border-collapse: collapse; width: 100%; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
th { font-weight: 600; opacity: 0.8; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
/* SVG 默认尺寸：很多 AI 写 <svg viewBox="..."> 不带 width/height，
   有些浏览器会渲染成 0×0。强制 display: block + min-height + 用 viewBox 推算。 */
svg {
  display: block;
  max-width: 100%;
  height: auto;
}
svg:not([width]):not([height]) {
  width: 100%;
  min-height: 50px;
}
canvas { display: block; max-width: 100%; }
.cc-widget-error-overlay {
  position: fixed;
  inset: 0;
  background: rgba(239, 68, 68, 0.95);
  color: white;
  padding: 14px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow: auto;
  z-index: 99999;
}
</style>`;

    const bridge =
      '<script>' +
      '(function(){' +
      'var __id=' + JSON.stringify(id) + ';' +
      'var __lastH=0;' +
      'function post(t,d){try{parent.postMessage(Object.assign({type:t,id:__id},d||{}),"*");}catch(e){}}' +
      // 测高度三路取最大：scrollHeight × 2 + 子元素 bottom 真值。
      // 子元素 bottom 是兜底：用户 CSS 写 body{height:100%} 时 scrollHeight 会失效，
      // 但 getBoundingClientRect().bottom 永远是真实 layout 位置。
      'function reportH(){' +
      '  var sH=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);' +
      '  var maxB=0;' +
      '  var kids=document.body?document.body.children:[];' +
      '  for(var ki=0;ki<kids.length;ki++){try{var r=kids[ki].getBoundingClientRect();if(r.bottom>maxB)maxB=r.bottom;}catch(e){}}' +
      '  var h=Math.max(sH,maxB)+(document.body?parseFloat(getComputedStyle(document.body).paddingBottom)||0:0);' +
      '  if(h!==__lastH){__lastH=h;post("cc-widget-resize",{height:h});}' +
      '}' +
      'if(window.ResizeObserver){try{new ResizeObserver(reportH).observe(document.body);}catch(e){}}' +
      // 节流轮询兜底：每 300ms 一次，最多 30 次（9 秒），防止 ResizeObserver
      // 因为某些边缘情况漏发；__lastH dedup 避免刷屏
      'var __pollCount=0;var __pollT=setInterval(function(){reportH();if(++__pollCount>=30)clearInterval(__pollT);},300);' +
      'window.addEventListener("load",reportH);' +
      'document.addEventListener("DOMContentLoaded",reportH);' +
      'setTimeout(reportH,30);setTimeout(reportH,150);setTimeout(reportH,500);setTimeout(reportH,1500);' +
      'window.addEventListener("error",function(e){post("cc-widget-error",{message:String(e.message||"unknown")+" @ "+(e.filename||"inline")+":"+(e.lineno||0)});var o=document.createElement("div");o.className="cc-widget-error-overlay";o.textContent="⚠ Widget 运行错误:\\n"+e.message+"\\n@ line "+e.lineno;document.body.appendChild(o);reportH();});' +
      'window.addEventListener("unhandledrejection",function(e){post("cc-widget-error",{message:"Unhandled Promise: "+String(e.reason)});});' +
      // 选区转发：iframe sandbox 跨源，父页 window.getSelection 看不到 iframe 内的
      // selection。这里监听 iframe 自己的 selectionchange，把选中文本 postMessage
      // 给父页，父页缓存供 pickContextInfo 用 → 用户在 widget 里选文字也能用蓝色按钮。
      'var __lastSel="";' +
      'document.addEventListener("selectionchange",function(){' +
      '  var s=window.getSelection?String(window.getSelection().toString()||""):"";' +
      '  if(s!==__lastSel){__lastSel=s;post("cc-widget-selection",{text:s});}' +
      '});' +
      // 拦截 console.error / warn / log，转发到父页面便于排查"无错误但内容空"的情况
      'var __consoleMethods=["error","warn","log"];' +
      'for (var i=0;i<__consoleMethods.length;i++){(function(m){' +
      '  var orig=console[m];' +
      '  console[m]=function(){' +
      '    try{var parts=[];for(var k=0;k<arguments.length;k++){var a=arguments[k];parts.push(typeof a==="string"?a:(a&&a.message)||(function(){try{return JSON.stringify(a);}catch(e){return String(a);}})());}post("cc-widget-console",{level:m,text:parts.join(" ")});}catch(e){}' +
      '    if(orig)return orig.apply(console,arguments);' +
      '  };' +
      '})(__consoleMethods[i]);}' +
      '})();' +
      '</script>';

    // 错误前置监听器：在 body 第一行就装上 window.error / unhandledrejection 监听，
    // 这样即使用户 <script> 里有 parse error（脚本根本没执行 → 不会触发用户自己的
    // try/catch），浏览器报错时这个早期监听器也能抓到，post 给父页面显示醒目错误条。
    // 必须早于用户 <script> 注册 → 放在 body 最前。
    const earlyErrorListener =
      '<script>' +
      '(function(){' +
      'var __id=' + JSON.stringify(id) + ';' +
      'function post(t,d){try{parent.postMessage(Object.assign({type:t,id:__id},d||{}),"*");}catch(e){}}' +
      'window.addEventListener("error",function(e){' +
      '  var msg=String(e.message||"unknown error");' +
      '  var loc=" @ line "+(e.lineno||"?")+(e.colno?":"+e.colno:"");' +
      '  post("cc-widget-error",{message:msg+loc});' +
      '  try{var o=document.createElement("div");o.className="cc-widget-error-overlay";o.style.cssText="position:fixed;inset:0;background:rgba(239,68,68,0.95);color:white;padding:14px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;overflow:auto;z-index:99999;";o.textContent="⚠ Widget JS 错误:\\n"+msg+loc;(document.body||document.documentElement).appendChild(o);}catch(_e){}' +
      '});' +
      '})();' +
      '</script>';

    if (isFullDoc) {
      // 用户给了完整 HTML doc，把 CSP / theme / 早期错误监听器 / bridge 注入
      let doc = trimmed;
      const headEnd = doc.search(/<\/head>/i);
      if (headEnd >= 0) {
        doc = doc.slice(0, headEnd) + cspMeta + themeStyle + doc.slice(headEnd);
      } else {
        doc = doc.replace(/<html[^>]*>/i, (m) => m + '<head>' + cspMeta + themeStyle + '</head>');
      }
      // 早期错误监听器：注入到 <body> 之后
      const bodyOpen = doc.search(/<body[^>]*>/i);
      if (bodyOpen >= 0) {
        const bodyTagEnd = doc.indexOf('>', bodyOpen) + 1;
        doc = doc.slice(0, bodyTagEnd) + earlyErrorListener + doc.slice(bodyTagEnd);
      }
      // bridge 放到 </body> 前
      const bodyEnd = doc.search(/<\/body>/i);
      if (bodyEnd >= 0) {
        doc = doc.slice(0, bodyEnd) + bridge + doc.slice(bodyEnd);
      } else {
        doc += bridge;
      }
      return doc;
    }

    // 用户给了片段，包到模板里。早期错误监听器必须在用户脚本之前。
    return '<!DOCTYPE html><html><head>' +
      '<meta charset="UTF-8">' +
      cspMeta + themeStyle +
      '</head><body>' + earlyErrorListener + trimmed + bridge + '</body></html>';
  }

  /** 把可能包含 </style> 或注入字符的颜色值过掉。VS Code 颜色变量一般是 hex/rgb，但兜底 */
  function cssSafe(v) {
    return String(v || '').replace(/[<>"\\]/g, '');
  }

  // 父页监听 iframe postMessage：高度自适应 + 错误展示
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || typeof d !== 'object' || !d.type || !d.id) return;
    const wrap = document.querySelector('[data-widget-id="' + cssAttrSafe(d.id) + '"]');
    if (!wrap) return;
    if (d.type === 'cc-widget-resize') {
      const iframe = wrap.querySelector('iframe.cc-widget-iframe');
      if (iframe && typeof d.height === 'number' && d.height > 0) {
        applyWidgetHeight(wrap, iframe, d.id, d.height);
      }
    } else if (d.type === 'cc-widget-selection') {
      // 缓存 widget 内的选区文本 + 时间戳。pickContextInfo 在没有 lecture 选区
      // 时回退使用这个 → 用户在 widget 里选文字也能用蓝色按钮。
      _lastWidgetSelection = {
        text: String(d.text || ''),
        widgetId: d.id,
        timestamp: Date.now(),
        wrap,
      };
    } else if (d.type === 'cc-widget-console') {
      // widget 里 console.log/warn/error 转发，显示在 console 面板（默认折叠的话先展开）
      const cp = wrap.querySelector('.cc-widget-console');
      if (cp) {
        cp.classList.remove('hidden');
        const line = document.createElement('div');
        line.className = 'cc-widget-console-line level-' + (String(d.level || 'log').replace(/[^a-z]/g, ''));
        line.textContent = '[' + (d.level || 'log') + '] ' + String(d.text || '');
        cp.appendChild(line);
        // 最多保留 50 行
        while (cp.children.length > 50) cp.removeChild(cp.firstChild);
      }
    } else if (d.type === 'cc-widget-error') {
      const err = wrap.querySelector('.cc-widget-error');
      if (err) {
        err.classList.remove('hidden');
        err.textContent = '⚠ ' + String(d.message || '运行错误');
      }
    }
  });

  function cssAttrSafe(v) {
    return String(v || '').replace(/["\\]/g, '');
  }

  /**
   * 把 bridge 上报的高度应用到 iframe，附带"vh 循环侦测 + 锁定"机制。
   *
   * 背景：AI 写 widget 时若用了 100vh / 100vmin / vh 等 viewport 单位，
   * 会和 iframe 自适应高度形成循环——iframe 一变高，vh 元素跟着大，
   * bridge 又上报更大值。0473861 删掉了单调增高约束（让大 widget 不出
   * 内滚动条），就把这个隐患暴露出来。
   *
   * 策略：维护每个 widget 的高度历史，检测"连续 N 次小幅单调增长"。
   * 一旦判定为循环，锁定到循环开始前的高度（≈ 第一次稳定的真实自然高度），
   * 并给容器加 data-height-locked 让 CSS 显示"手动重测"按钮。
   * 之后若上报值跟锁定差 > 200px，视为真实变化（折叠展开、数据切换），
   * 自动解锁继续跟随。
   */
  function applyWidgetHeight(wrap, iframe, id, reportedH) {
    // 缩放期挂起：zoom 影响 iframe viewport，reportedH 不可信。
    // 既不进 history（避免污染循环检测），也不动 iframe（避免疯狂增长）。
    // wheel handler 缩放停止后会清 _isZooming 并触发 relockWidgetHeight 重测。
    if (_isZooming) return;

    const list = _widgetHeightHistory.get(id) || [];
    list.push({ t: Date.now(), h: reportedH });
    while (list.length > _WIDGET_HEIGHT_HISTORY_MAX) list.shift();
    _widgetHeightHistory.set(id, list);

    const lockedH = wrap._heightLockedAt;

    // 已锁定：检查是否该解锁
    if (typeof lockedH === 'number') {
      if (Math.abs(reportedH - lockedH) > _WIDGET_UNLOCK_DELTA) {
        // 真实变化，解锁
        wrap._heightLockedAt = undefined;
        wrap.removeAttribute('data-height-locked');
        iframe.style.height = (reportedH + 16) + 'px';
      }
      // 还在锁定且变化小：不动 iframe，保持锁定高度
      return;
    }

    // 未锁定：检测最近 _WIDGET_LOOP_MIN_RUN 次是否都是小幅单调增长
    if (list.length >= _WIDGET_LOOP_MIN_RUN) {
      const tail = list.slice(-_WIDGET_LOOP_MIN_RUN);
      let isLoop = true;
      for (let i = 1; i < tail.length; i++) {
        const delta = tail[i].h - tail[i - 1].h;
        if (delta < _WIDGET_LOOP_INC_MIN || delta > _WIDGET_LOOP_INC_MAX) {
          isLoop = false;
          break;
        }
      }
      if (isLoop) {
        // 锁定到循环开始前的那次稳定高度（tail 第一项的 h）
        const lockTarget = tail[0].h;
        wrap._heightLockedAt = lockTarget;
        wrap.setAttribute('data-height-locked', '1');
        iframe.style.height = (lockTarget + 16) + 'px';
        try {
          console.warn(
            '[ClaudeCoach widget] 检测到 vh / viewport 单位导致的高度循环增长，已锁定 iframe 高度 ≈',
            lockTarget,
            'px。如果显示不全，点 widget toolbar 的 "↕ 重测高度" 按钮。',
          );
        } catch (_e) { /* noop */ }
        return;
      }
    }

    // 正常路径：直接跟随
    iframe.style.height = (reportedH + 16) + 'px';
  }

  /**
   * 手动解锁并重新测高度：清掉锁定标记 + 历史，先把 iframe 设为 0，强制 vh 元素
   * 缩到 0，再让 bridge 在 polling 中报出真实自然高度。
   */
  function relockWidgetHeight(wrap) {
    const iframe = wrap.querySelector('iframe.cc-widget-iframe');
    if (!iframe) return;
    const id = wrap.dataset.widgetId;
    wrap._heightLockedAt = undefined;
    wrap.removeAttribute('data-height-locked');
    if (id) _widgetHeightHistory.delete(id);
    // 把 iframe 暂时压回小高度，强迫 vh 元素缩小，下次 reportH 会拿到内容自然高度
    iframe.style.height = '100px';
  }

  // ===== widget ⋯ 菜单（删除 / 呼叫 AI）=====

  let _widgetMoreMenuEl = null;

  function ensureWidgetMoreMenu() {
    if (_widgetMoreMenuEl) return _widgetMoreMenuEl;
    const el = document.createElement('div');
    // 复用 .lecture-context-menu 的浮层样式；cc-widget-more-menu 留给将来差异化用
    el.className = 'lecture-context-menu cc-widget-more-menu';
    el.hidden = true;
    el.innerHTML =
      '<button type="button" data-action="callout">💬 呼叫 AI（把这个 widget 当作上下文）</button>' +
      '<button type="button" data-action="delete">🗑 删除这个 widget</button>';
    document.body.appendChild(el);
    // 阻止 menu 内 button mousedown 偷 focus / 折叠 document selection
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      const wrap = el._currentWidget;
      hideWidgetMoreMenu();
      if (!wrap) return;
      if (act === 'callout') callOutWidget(wrap);
      else if (act === 'delete') deleteWidget(wrap);
    });
    _widgetMoreMenuEl = el;
    return el;
  }

  function showWidgetMoreMenu(container, anchorBtn) {
    const el = ensureWidgetMoreMenu();
    el._currentWidget = container;
    el.hidden = false;
    // 锚在 ⋯ 按钮下方左对齐；做边界裁剪
    const anchorRect = anchorBtn.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - elRect.width - 8));
    const top = Math.max(8, Math.min(anchorRect.bottom + 4, window.innerHeight - elRect.height - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function hideWidgetMoreMenu() {
    if (_widgetMoreMenuEl) {
      _widgetMoreMenuEl.hidden = true;
      _widgetMoreMenuEl._currentWidget = null;
    }
  }

  /**
   * "呼叫"：把整个 widget 当成一次 chip 选区，弹 popover。
   * info.text = widget 完整源码 → AI 拿到完整上下文。
   * startLine/endLine 从 container 继承的 data-source-line 拿（指向 .md 中
   * ```widget 块的位置），便于"改这段"模式精确替换。
   */
  function callOutWidget(container) {
    const startLineRaw = parseInt(container.getAttribute('data-source-line') || '', 10);
    const endLineRaw = parseInt(container.getAttribute('data-source-line-end') || '', 10);
    const startLine = Number.isFinite(startLineRaw) ? startLineRaw : 0;
    const endLine = Number.isFinite(endLineRaw) ? endLineRaw : startLine + 1;
    const text = _widgetUserSrc.get(container) || '';
    const rect = container.getBoundingClientRect();
    const info = {
      startLine,
      endLine,
      text,
      rect,
      fromWidget: true,
    };
    currentSelectionInfo = info;
    showPopoverFor(info);
  }

  /**
   * "删除"：删除讲义 .md 中此 widget 块对应的行范围。
   * 走宿主端 deleteLectureRange 消息，宿主负责 .bak 备份 + 写回，
   * 之后 Ctrl+Z（讲义阅读器内）能撤回。
   *
   * 特别处理：如果 widget 被包在 <details class="cc-qa"> 外壳里（用户当时点
   * "保存到讲义"通过 wrapAsCallout 生成的折叠卡片），单删 widget fence 会留下
   * 空 details 壳。这里检测后扩大删除范围到含外壳 + 前置 \n\n---\n\n 分隔线。
   */
  function deleteWidget(container) {
    if (!vscode) return;
    let startLineRaw = parseInt(container.getAttribute('data-source-line') || '', 10);
    let endLineRaw = parseInt(container.getAttribute('data-source-line-end') || '', 10);
    if (!Number.isFinite(startLineRaw) || !Number.isFinite(endLineRaw)) {
      flashStatus && flashStatus('该 widget 没有行号信息，无法删除', 'error');
      return;
    }

    // widget 在 callout 内？扩大范围
    if (container.closest && container.closest('details.cc-qa')) {
      const lines = (state.content || '').split('\n');
      // 往前最多看 8 行，找 <details 起始
      let detailsStart = -1;
      for (let i = startLineRaw - 1; i >= Math.max(0, startLineRaw - 8); i--) {
        if (/^<details\b/i.test((lines[i] || '').trim())) { detailsStart = i; break; }
      }
      // 往后最多看 6 行（widget body 之后是 \n\n</details>\n），找 </details> 结束
      let detailsEnd = -1;
      for (let i = endLineRaw; i < Math.min(lines.length, endLineRaw + 6); i++) {
        if (/^<\/details\b/i.test((lines[i] || '').trim())) { detailsEnd = i + 1; break; }
      }
      if (detailsStart >= 0 && detailsEnd >= 0) {
        // 顺便清掉 wrapAsCallout 注入的前置 "\n\n---\n\n"：
        // 跳过 <details 前的空行 → 如果遇到 --- 行也跳过 → 再跳 --- 前的空行
        let cleanStart = detailsStart;
        while (cleanStart > 0 && !(lines[cleanStart - 1] || '').trim()) cleanStart--;
        if (cleanStart > 0 && (lines[cleanStart - 1] || '').trim() === '---') {
          cleanStart--;
          while (cleanStart > 0 && !(lines[cleanStart - 1] || '').trim()) cleanStart--;
        }
        startLineRaw = cleanStart;
        endLineRaw = detailsEnd;
      }
    }

    vscode.postMessage({
      type: 'deleteLectureRange',
      startLine: startLineRaw,
      endLine: endLineRaw,
    });
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
    btnRevert: document.getElementById('btnRevert'),
  };

  let currentSelectionInfo = null;
  /** 已渲染的浮动建议气泡（preview / applied 阶段）。key = turnId */
  const bubbles = new Map();

  // ===== render lecture =====

  function renderLecture(content) {
    state.content = String(content || '');
    if (!els.body) return;
    els.body.innerHTML = renderMarkdown(state.content);
    rewriteRelativeImageSrc(els.body);  // 把 ![](assets/xxx) 相对路径变成 webview URI
    renderMath(els.body);
    void renderMermaid(els.body); // 异步，不 block
    void renderGraphviz(els.body); // 异步，不 block
    renderWidgets(els.body);       // 同步，但 iframe 内部脚本异步加载
    renderVideoCards(els.body);    // 视频卡片（粘贴 YouTube/B 站 URL 后嵌入的）
    renderSuggestPlaceholders(els.body);  // 讲义生成时 AI 输出的可视化建议块
    attachImageDeleteButtons(els.body);   // 每张图片右上角加 hover 浮现的 ✕ 删除按钮
  }

  /**
   * 给讲义里每张图片右上角包一个 hover 时浮现的 ✕ 删除按钮。
   *
   * 实现：用 <span class="lecture-img-wrap"> 把 <img> 包起来 → relative 容器；
   * X 按钮 absolute 浮在右上角；hover 时 opacity 0→1。
   * 点 ✕ → 找最近 [data-source-line] 祖先（markdown-it 给 <p> 打的）→
   * postMessage deleteLectureRange → 宿主端写 .bak + 写回（用户可 Ctrl+Z 撤回）。
   *
   * 跳过：iframe widget / mermaid SVG / graphviz SVG 内部的图（那些不是讲义直接图）。
   */
  function attachImageDeleteButtons(root) {
    if (!root) return;
    const imgs = root.querySelectorAll('img');
    imgs.forEach((img) => {
      if (img.dataset.deleteBound === '1') return;
      // 跳过 widget / 图表内部的图（这些被 widget/iframe/mermaid 自己管，不该被讲义删除按钮影响）
      if (img.closest('.cc-widget') || img.closest('.mermaid-rendered')
          || img.closest('.graphviz-rendered') || img.closest('iframe')
          || img.closest('.lecture-img-wrap')) return;
      img.dataset.deleteBound = '1';

      const wrap = document.createElement('span');
      wrap.className = 'lecture-img-wrap';
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lecture-img-delete-btn';
      btn.title = '删除图片（可 Ctrl+Z 撤回）';
      btn.setAttribute('aria-label', '删除图片');
      btn.textContent = '×';
      wrap.appendChild(btn);

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 找最近 [data-source-line] 祖先 —— markdown-it 给 block-level token（通常是 <p>）打的
        const ancestor = wrap.closest('[data-source-line]');
        if (!ancestor) {
          if (vscode) vscode.postMessage({ type: 'log', level: 'warn',
            message: '图片删除失败：找不到 data-source-line 祖先' });
          return;
        }
        const startLine = parseInt(ancestor.getAttribute('data-source-line'), 10);
        const endRaw = ancestor.getAttribute('data-source-line-end');
        const endLine = endRaw ? parseInt(endRaw, 10) : startLine + 1;
        if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine <= startLine) {
          if (vscode) vscode.postMessage({ type: 'log', level: 'warn',
            message: `图片删除失败：行号非法 start=${startLine} end=${endLine}` });
          return;
        }
        if (vscode) {
          vscode.postMessage({ type: 'deleteLectureRange', startLine, endLine });
        }
      });
    });
  }

  /**
   * 把 <div class="cc-suggest" data-kind="image|widget" data-query="..."> 渲染成
   * 一个带按钮的卡片：让 Claude 搜图 / 生成 widget / 手动粘贴 / 删除建议。
   *
   * 每个 cc-suggest 块带 data-source-line（来自 markdown-it html_block token），
   * 按钮点击时拿这个行号作为 targetLine 插入对应内容。
   */
  function renderSuggestPlaceholders(root) {
    if (!root) return;
    const blocks = root.querySelectorAll('div.cc-suggest[data-kind]');
    blocks.forEach((wrap) => {
      if (wrap.dataset.rendered === '1') return;
      const kind = wrap.dataset.kind || 'image';
      const query = wrap.dataset.query || '';
      // 原文里的"💡 建议：..." 文字（保留作为卡片描述）
      const hint = (wrap.textContent || '').trim();
      const iconLabel = kind === 'image' ? '🖼' : '🎮';
      const kindLabel = kind === 'image' ? '建议加图' : '建议加互动演示';
      const primaryBtn = kind === 'image'
        ? '<button class="cc-suggest-btn primary" data-action="suggest-search">🔍 让 Claude 搜图</button>'
        : '<button class="cc-suggest-btn primary" data-action="suggest-widget">🎮 生成互动演示</button>';
      wrap.innerHTML = `
        <div class="cc-suggest-card">
          <div class="cc-suggest-header">
            <span class="cc-suggest-icon">${iconLabel}</span>
            <span class="cc-suggest-label">${kindLabel}</span>
          </div>
          <div class="cc-suggest-body">${helpers.escapeHtml(hint || query)}</div>
          <div class="cc-suggest-actions">
            ${primaryBtn}
            <button class="cc-suggest-btn" data-action="suggest-paste">📎 我自己粘</button>
            <button class="cc-suggest-btn ghost" data-action="suggest-dismiss">✕ 不要</button>
          </div>
        </div>
      `;
      wrap.dataset.rendered = '1';
    });
  }

  // 委托 suggest 卡片按钮点击 → 路由到对应模式
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.cc-suggest-btn[data-action]');
    if (!btn) return;
    const wrap = btn.closest('div.cc-suggest');
    if (!wrap) return;
    const act = btn.getAttribute('data-action');
    const kind = wrap.dataset.kind || 'image';
    const query = wrap.dataset.query || '';
    const startLine = parseInt(wrap.getAttribute('data-source-line') || '0', 10);
    const endLine = parseInt(wrap.getAttribute('data-source-line-end') || String(startLine + 1), 10);
    const rect = wrap.getBoundingClientRect();
    // 构造 info 让 submit 函数当成"选区在 suggest 块上"处理
    const info = {
      startLine: Number.isFinite(startLine) ? startLine : 0,
      endLine: Number.isFinite(endLine) ? endLine : (Number.isFinite(startLine) ? startLine + 1 : 1),
      text: '',
      rect,
      fromSuggest: true,
    };

    if (act === 'suggest-search') {
      // 直接调 Claude Code 搜图，query 用 prompt 里 AI 写的
      const turnId = submitInlineSearchImage(info, query || '相关教学示意图');
      // 把 suggest 块标记为"处理中"，dataset 记 turnId 用于失败时反查解锁
      if (turnId) wrap.dataset.busyTurnId = turnId;
      wrap.classList.add('cc-suggest-busy');
    } else if (act === 'suggest-widget') {
      // 触发 widget 生成
      const turnId = submitInlineWidget(info, query || '相关概念的互动演示');
      if (turnId) wrap.dataset.busyTurnId = turnId;
      wrap.classList.add('cc-suggest-busy');
    } else if (act === 'suggest-paste') {
      // 提示用户粘贴：什么都不做，让用户 Ctrl+V 粘剪贴板里的图
      // 但要把 currentSelectionInfo 设到这里，让 pasteMedia 知道插哪
      currentSelectionInfo = info;
      toast('提示：粘贴剪贴板里的图片（Ctrl+V），会插入到此建议处', 'info');
    } else if (act === 'suggest-dismiss') {
      // 删除这个建议块（连同 source line 范围一起删）
      if (!vscode) return;
      vscode.postMessage({
        type: 'deleteLectureRange',
        startLine: info.startLine,
        endLine: info.endLine,
      });
    }
  });

  /**
   * 把 markdown 渲染产物里 <img src="assets/foo.png"> 之类的相对路径，
   * 重写成 webview 可加载的绝对 URI（assetBaseUri + '/' + 相对路径）。
   * 绝对 URL（http/https/data/blob/vscode-*）原样保留。
   */
  function rewriteRelativeImageSrc(root) {
    if (!root || !state.assetBaseUri) return;
    const imgs = root.querySelectorAll('img[src]');
    imgs.forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src) return;
      if (/^(https?:|data:|blob:|file:|vscode-|\/\/)/i.test(src)) return;  // 绝对路径不动
      // 拼接：assetBaseUri/<src>，去重斜杠
      const base = state.assetBaseUri.replace(/\/+$/, '');
      const rel = src.replace(/^\/+/, '');
      img.setAttribute('src', base + '/' + rel);
    });
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
    // 优先 1：lecture body 内的原生选区（普通 markdown / mermaid SVG / dot SVG）
    const info = helpers.getSelectionLineRange ? helpers.getSelectionLineRange(els.body) : null;
    if (info && info.text && info.text.trim()) {
      return info;
    }
    // 优先 2：widget iframe 选区（跨源，通过 postMessage 缓存）
    if (
      _lastWidgetSelection &&
      _lastWidgetSelection.text &&
      _lastWidgetSelection.text.trim() &&
      Date.now() - _lastWidgetSelection.timestamp < WIDGET_SELECTION_STALE_MS &&
      _lastWidgetSelection.wrap &&
      document.body.contains(_lastWidgetSelection.wrap)
    ) {
      const wrap = _lastWidgetSelection.wrap;
      const s = parseInt(wrap.getAttribute('data-source-line') || '', 10);
      const e = parseInt(wrap.getAttribute('data-source-line-end') || '', 10);
      const rect = wrap.getBoundingClientRect();
      return {
        startLine: Number.isFinite(s) ? s : 0,
        endLine: Number.isFinite(e) ? e : (Number.isFinite(s) ? s + 1 : 1),
        text: _lastWidgetSelection.text,
        rect,
        fromWidget: true,
      };
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
    // popover 现在是 position: fixed（与 chip 一致），直接用 viewport 坐标。
    // 不再 + window.scrollY/scrollX —— 之前那么写，用户滚动后位置会漂。
    let top, left;
    const chipRect = els.chip?.getBoundingClientRect();
    if (chipRect) {
      top = chipRect.bottom + 8;                          // 视口顶 + chip 下方 8px
      left = Math.max(16, chipRect.right - 380);          // 380 = popover 宽度
    } else {
      top = 60;
      left = Math.max(16, window.innerWidth - 396);
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
          { key: 'widget', label: '🎮 互动演示', hint: '强制让 AI 输出一个 ```widget 代码块（可点按钮 / 拖滑块的交互式演示），追加到讲义末尾' },
          { key: 'searchImage', label: '🔍 智能搜图', hint: '让 Claude Code（用你的 Claude 订阅，零额外费用）联网搜 1-3 张教学图，下载到 assets/ 并嵌入讲义' },
          { key: 'idea', label: '💡 记想法', hint: '把你的想法以引用块追加到讲义末尾' },
        ]
      : [
          { key: 'rewrite', label: '🛠 改这段', hint: 'AI 输出会替换/插入到选区' },
          { key: 'ask', label: '❓ 提问', hint: 'AI 会以聊天形式回答，不动讲义' },
          { key: 'widget', label: '🎮 互动演示', hint: '强制让 AI 基于这段输出一个 ```widget 互动演示块' },
          { key: 'searchImage', label: '🔍 智能搜图', hint: '让 Claude Code 联网搜跟这段相关的教学图，下载到 assets/ 并嵌入选区下方' },
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
            : m.key === 'widget'
              ? (info.isFullDoc
                  ? '描述要做什么互动演示：「Dijkstra 单步演示，6 个节点」「ReLU 函数图带温度滑块」「快排可视化」…'
                  : '描述基于这段做什么互动演示：「这个算法的单步演示」「这个概念的可调参数可视化」…')
              : m.key === 'searchImage'
                ? '描述要搜什么图：「Transformer 完整架构图」「TCP 三次握手示意图」「CPU 五级流水图」…'
                : (info.isFullDoc
                    ? '记下你自己的想法/疑问，会作为引用块追加到讲义末尾。'
                    : '记下你自己的想法/疑问，会作为引用块追加到这段下方。');
        btnSubmit.textContent = m.key === 'rewrite'
          ? (info.isFullDoc
              ? '重写整篇讲义'
              : (state.applyMode === 'auto-apply' ? '直接改写' : '发送给 AI'))
          : m.key === 'ask' ? '问 AI'
          : m.key === 'widget' ? '🎮 生成互动演示'
          : m.key === 'searchImage' ? '🔍 让 Claude 搜图'
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
      } else if (currentMode === 'widget') {
        submitInlineWidget(info, instruction);
      } else if (currentMode === 'searchImage') {
        submitInlineSearchImage(info, instruction);
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

  /**
   * widget 模式：强制 AI 输出一个 ```widget 代码块（互动演示）。
   * 走 ask 通道（preview-confirm，结果以气泡显示，用户点采纳后追加到讲义末尾），
   * 但 instruction 前缀注入极强的格式约束 —— 因为 inline ask 的 system prompt
   * 不带 widget 规则，要靠这里硬塞。
   */
  function submitInlineWidget(info, instruction) {
    if (!vscode) return;
    const turnId = (helpers.uuid && helpers.uuid()) || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    state.activeTurns.set(turnId, {
      info: { startLine: info.startLine, endLine: info.endLine, text: info.text || '', rect: info.rect },
      instruction,
      mode: 'widget',
    });
    showPendingBubble(turnId, info);

    // 这是关键 prompt —— 不让 AI 含糊"我来描述一下"，而是必须输出代码块
    const widgetDirective = [
      '【模式：互动演示生成】',
      '你必须输出**一个且仅一个 ```widget 代码块**作为回答。不要写其它解释、标题、段落 — 直接给代码块。',
      '',
      '## widget 代码块**严格规则**（违反任一条会渲染失败）：',
      '',
      '1. 用 ```widget 开始，``` 结束，里面是**完整可运行的 vanilla HTML+CSS+JS**',
      '2. **不要 import / require / <script src=> 任何外部库** — iframe CSP 禁了网络，外链全部失败',
      '3. **不要 fetch / XMLHttpRequest / WebSocket** — 同上',
      '4. SVG 必须 `<svg width="600" height="300" viewBox="0 0 600 300">` 三件套都给齐，否则可能渲染成 0×0',
      '5. **模板字符串插值必须紧贴**：写 `${var}` 不是 `$ {var}` —— 中间空格会让插值失效，整个变字面量字符串，querySelector 全找不到节点',
      '6. JS 字符串里如果有 `</script>`，**必须**写成 `<\\/script>`；但真正关闭脚本标签时必须写 `</script>`，不要把结束标签写成 `<\\/script>`；CSS 字符串里的 `</style>` 同理写 `<\\/style>`',
      '7. **颜色 CSS 变量 + 必须保证对比**：可用 `var(--bg)` `var(--fg)` `var(--accent)` `var(--accent-fg)` `var(--border)` `var(--input-bg)` `var(--input-fg)` `var(--muted)` `var(--panel-bg)`，**但绝对不能 SVG 节点 fill 用容器同色变量**：',
      '   - ❌ `.graph-shell { background: var(--input-bg) }` + `.node circle { fill: var(--input-bg) }` → 节点融进背景看起来空',
      '   - ✅ SVG 节点 fill 用 `var(--accent)` / `var(--fg)`（前景色）；stroke 用 `var(--border)` / `var(--accent-fg)`',
      '   - ✅ SVG 边 stroke 用 `var(--fg)` / `var(--accent)` 这种前景色；不要用 `var(--border)` 因为 border 颜色对暗背景对比度低',
      '8. **不要写死 1000px 这种像素宽度**，要响应式',
      '   8a. **绝对不要用 viewport 单位** `vh` `vw` `vmin` `vmax` `svh` `dvh` `lvh` `dvw` —— iframe 高度跟随内容自适应，vh 元素会让 iframe 增高 → vh 跟着增 → 死循环。需要"较大块"用具体 `px`（例如 `min-height: 400px`）；需要相对宽度用 `%`',
      '9. **绝对不要内联 `// 注释`**：因为 AI 经常把多个语句压一行，`// xxx` 注释会**吃掉同一行后面的所有代码**，导致 syntax error。要写注释**用 `/* xxx */` 块注释**，或者把注释独占一行。',
      '10. **每个语句独占一行**，不要 `a;b;c;d;` 压一行。代码再啰嗦也比单行难调试强。',
      '11. **不要把整段 JS 包在 try/catch** —— 会吞掉真实逻辑 bug。让错误抛出，iframe bridge 的 error 监听会显示醒目红色覆盖层方便排查',
      '12. **写完代码自己脑中跑一遍**：数据数组（nodes/edges/items）有真元素？init()/reset() 真填了状态？render() 调用时数据 ready 了吗？',
      '13. **保持简单 < 100 行 JS**。多功能 ≠ 好 widget。别上 playback / 调速滑块 / 多状态那一套，单纯"下一步 / 重置 + 高亮当前节点"就够好。复杂 = bug = 白屏',
      '14. **默认上下分区布局，不要左右两列**。widget iframe 宽度有限（讲义阅读器一栏 ≈ 1300px），左右各占 50% 后每列只剩 ≈ 550px，SVG 图被压扁、表格行被挤、节点标签和边权挤一起，整体局促。',
      '    - ✅ 推荐：`display: flex; flex-direction: column; gap: 16px;` —— 上面放图/可视化（占满宽度），下面放控制按钮 + 数据表',
      '    - ✅ 下半区如果有多个小卡片（queue / result / table），可以横向 `display: grid; grid-template-columns: auto auto 1fr;` 并排但权重不同',
      '    - ❌ 避免：把"图区"和"控制+数据区"用 `grid-template-columns: 1fr 1fr` 或 `flex-direction: row` 左右切两半 —— 图被压瘦，右侧多个卡片再纵向堆 → 整体局促',
      '    - 例外：纯"对比 A vs B"这种语义上必须并排的可以左右',
      '',
      '## 演示设计要求',
      '- 有可点的按钮（至少 1-2 个：下一步 / 重置）',
      '- 有视觉反馈（高亮 / 颜色变化 / 数字更新），不能只是静态图',
      '- 当前步骤 / 状态在 UI 上可见',
      '',
      '## 算法演示型 widget 视觉系统（图 / 树 / 排序 / DP 等，必读）',
      '如果演示涉及"节点 / 顶点 / 多状态切换 / 多步推进"（Dijkstra、BFS、拓扑排序、各种 sort、并查集、DP 表格等），必须按下面这套硬规范输出，否则即使能跑也"看不清状态/混乱/丑"。',
      '',
      'A. **节点 5 状态色板（必须可视区分，不要全用 accent 同色！）**：',
      '   - 起点/源点：`fill="var(--accent)" stroke="var(--accent-fg)" stroke-width="3"`',
      '   - **当前正在处理**：`fill="#f59e0b"` 独立 amber 色，**不要复用 accent**，必须是第二种独立色，让用户一眼看到"现在轮到谁"',
      '   - 候选 / 已发现但未确定：`fill="var(--accent)" opacity="1"`',
      '   - 已 settled / 已确定：`fill="var(--muted)" opacity="0.7"` 暗淡表示"已处理完"',
      '   - 未发现 / 未访问：`fill="transparent" stroke="var(--border)" stroke-width="2"` 空心',
      '   - 状态切换：`setAttribute("class", "state-current")` 然后 CSS 控样式，或直接改 fill/stroke',
      '',
      'B. **节点旁贴实时数据**：节点圆下方加 `<text>` 显示当前 `dist=∞` / `in=2` / `cost=5` 等实时值。用户不用回头扫表格才知道现在每个节点的状态。',
      '',
      'C. **边的 stroke 和 marker 必须够粗**：',
      '   - 边普通态：`stroke="var(--border)" stroke-width="2"`（不要 1px，太细看不见）',
      '   - 边高亮态（当前正在 relax / 当前在路径上）：`stroke="#f59e0b" stroke-width="3"`',
      '   - 有方向时 marker：`markerWidth="10" markerHeight="8" refX` 必须算准（让箭头落在节点圆外、不钻进圆里）',
      '',
      'D. **边权 / 边 label 必须加底色描边**：SVG 裸 `<text>` 直接放边中点会跟边线打架。两种做法选一：',
      '   - 加 stroke 描边：`<text paint-order="stroke fill" stroke="var(--bg)" stroke-width="4" fill="var(--fg)">2</text>` —— 文字外有一圈底色',
      '   - 加背景矩形：`<rect fill="var(--panel-bg)" rx="4" />` 垫在 text 后面',
      '',
      'E. **节点布局手工排版避免边交叉**：≤ 7 节点应该分 2-3 层（左中右 或 上中下），同层节点 y 一致。不要随手摆位置让边在中央打结。',
      '',
      'F. **控制台分独立卡片，不要压扁**：',
      '   - 卡片 1：「当前步骤说明」（panel-bg 背景 + padding + border-radius，显示当前在做什么）',
      '   - 卡片 2：「当前数据结构状态」（priority queue / stack / settled 集合 / queue 列表 / 拓扑序结果）—— **必须有**，让用户看到算法内部状态',
      '   - 卡片 3：「主数据表」',
      '   - 每个卡片 `background: var(--panel-bg); border-radius: 8px; padding: 12px;` 视觉分块',
      '',
      'G. **数据表用纵向布局**：每行一个节点/实体，列固定为（节点名 + 各字段 + 状态）。不要"列=节点"横向铺开 —— 加节点列就要拉宽，且行少难扫读。',
      '',
      'H. **边权 text 位置 + 描边**：text 沿边段放在 0.45-0.5 比例处（避开两端节点圆，不要贴节点），描边用 `paint-order="stroke fill" stroke="var(--bg)" stroke-width="5"` —— stroke-width 必须 ≥ 5 才能在暗背景上清晰区分（4 还会跟边线打架）。',
      '',
      'I. **箭头 marker 颜色随边走，不要写死白色**：marker `fill` 用 `context-stroke`（SVG2）或者用 CSS `marker { fill: var(--fg) }` 通过 class 同步切换。当边切到 amber 高亮态时，marker fill 也要变 amber。**不能让边变色但箭头还是白色** —— 视觉断层。简单做法：定义两个 marker（`#arrow-normal` `#arrow-current`），用 JS 切换 `setAttribute("marker-end", "url(#arrow-current)")`。',
      '',
      'J. **节点外环不要硬白边**：暗背景上 `stroke="var(--fg)" stroke-width="3"` 等效"白圈贴纸"。普通态用 `stroke="color-mix(in srgb, var(--fg) 30%, transparent)"` 或者 `stroke="var(--border)"`；只有 "当前处理"高亮态才用强 stroke 突出。',
      '',
      'K. **表格高亮行**（"当前正在处理 / discovered"）**用低饱和底色 + 不变字色**：底色 `background: color-mix(in srgb, #f59e0b 22%, transparent)`，字色仍是 `var(--fg)`。**绝对不要让字色变浅**（字浅 + 底色浅 → 对比度炸）。或者只给"状态"那一列加 chip 标签，整行不染色。',
      '',
      'L. **"当前数据结构状态"用 chip 而非 log 文本**：`priority queue: (3,b), (4,c)` 这种 log 形式可读性差。改成每个项目用圆角 pill：`<span class="chip">(3, b)</span> <span class="chip">(4, c)</span>`，chip CSS：`display: inline-flex; padding: 4px 10px; border-radius: 999px; background: var(--panel-bg); border: 1px solid var(--border); margin-right: 6px; font-size: 13px;`。',
      '',
      'M. **整体字号梯度**：标题 14-15px / 正文 13-13.5px / 标签或辅助说明 11.5-12px。不要全部 12px 一刀切（信息层级看不出）。卡片标题用 `font-weight: 600` 给视觉锚点。',
      '',
      '## 用户需求',
      instruction,
      '',
      '## 输出格式硬约束（最重要，最后强调一次）',
      '你的回复**第一个字符必须是反引号 `**，前 9 个字符必须是 "```widget" 加一个换行。',
      '**禁止**在 "```widget" 之前写任何文字 / 解释 / 引导语（"好的，下面是..." / "我来生成一个..." 之类全部禁止）。',
      '**禁止**直接以 `<!DOCTYPE html>` / `<html` / `<style` / `<div` / `<script` 等 HTML 标签开头 —— 必须先 "```widget" + 换行，然后才是 HTML。',
      '回复**最后 3 个字符必须是 "```"**（关闭围栏）。',
      '',
      '现在开始输出。第一行必须是 ```widget',
    ].join('\n');

    vscode.postMessage({
      type: 'inlineSuggest',
      request: {
        filePath: state.filePath,
        selectionText: info.text || '',
        sourceLineStart: info.startLine,
        sourceLineEnd: info.endLine,
        instruction: widgetDirective,
        applyMode: 'preview-confirm',
        turnId,
        intent: 'ask',
      },
    });
    return turnId;
  }

  /**
   * 智能搜图模式：发 claudeCodeSearchImage 给宿主，宿主 spawn Claude Code CLI
   * 跑搜图任务（用用户 Claude 订阅，零额外 token 费用）。
   * 进度通过 streaming bubble 显示（宿主端 push aiStreamDelta 文本片段），
   * 结束后宿主发 inlineCancelled 关闭 bubble + 弹 toast。
   */
  function submitInlineSearchImage(info, instruction) {
    if (!vscode) return null;
    const turnId = (helpers.uuid && helpers.uuid()) || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    state.activeTurns.set(turnId, {
      info: { startLine: info.startLine, endLine: info.endLine, text: info.text || '', rect: info.rect },
      instruction,
      mode: 'searchImage',
    });
    // 用 pending bubble 占位（aiStreamDelta 到达后会切到 streaming bubble）
    showPendingBubble(turnId, info);

    // 决定插入位置：选区结束行后；全文模式则末尾
    const targetLine = info.isFullDoc ? 'end' : info.endLine;

    vscode.postMessage({
      type: 'claudeCodeSearchImage',
      turnId,
      query: instruction,
      targetLine,
      // 上下文（让 Claude 写更精准的 search query）
      subject: state.subject || '',
      topic: state.topicTitle || '',
      lessonTitle: state.lessonTitle || '',
    });
    return turnId;
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
    // 事件委托：cancel-turn / 其它将来加的 bubble 内按钮统一在这里分发。
    // bubble.innerHTML 多次重写后子元素会重建，但绑在 bubble 上的 listener 不变，
    // 冒泡上来仍然能命中。
    bubble.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      if (act === 'cancel-turn') {
        const tid = btn.getAttribute('data-turn-id') || turnId;
        cancelTurn(tid);
      }
    });
    document.body.appendChild(bubble);
    bubbles.set(turnId, bubble);
    return bubble;
  }

  /**
   * 取消正在进行的 AI 生成 turn：**用户视角立即清理**（关 bubble + 清状态 + toast），
   * 不等宿主端响应。
   *
   * 为什么不等宿主端：之前的实现是"显示'已请求取消…' → 等宿主 abort + 回 inlineCancelled
   * → 才 removeBubble"，但如果 abort 路径任何一环卡住（client.ts 还没 compile、fetch 的
   * signal 没真正接到、SSE 流读到一半才响应 abort 等），bubble 就一直挂在那。
   *
   * 现在：webview 端立刻摆脱这个 turn。宿主端的 abort + inflightTurns 清理在后台异步跑，
   * 跟 UI 解耦。即使宿主端最终送回 inlineSuggestResult preview（abort 来不及），
   * showPreviewBubble 看到 activeTurns 找不到此 turnId 会直接 return（已经验证安全）。
   */
  function cancelTurn(turnId) {
    if (!vscode || !turnId) return;
    // 通知宿主端 abort（不等结果）
    vscode.postMessage({ type: 'cancelInlineSuggest', turnId });
    // 立即清理 webview 端的所有 turn 状态
    const entry = state.streamingTurns.get(turnId);
    if (entry?.trailingTimer) clearTimeout(entry.trailingTimer);
    state.streamingTurns.delete(turnId);
    state.activeTurns.delete(turnId);
    removeBubble(turnId);
    toast('已取消 AI 生成', 'info');
  }

  function positionBubble(bubble /*, anchor 已废弃 */) {
    // 永远锚到右上角 chip 下方，视口固定，跟 popover 一致。
    // 之前根据 selection rect 跑，无选区时 anchor=null 直接早返回，bubble 留在 (0,0)
    // 跑到左下角去。现在完全脱钩。
    const chipRect = els.chip?.getBoundingClientRect();
    let top, left;
    if (chipRect) {
      top = chipRect.bottom + 8;
      left = Math.max(16, chipRect.right - 440); // 440 = bubble 宽度
    } else {
      top = 60;
      left = Math.max(16, window.innerWidth - 456);
    }
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
    // max-height 必须按"气泡实际起始 top"动态算，而不是 CSS 里写死的 calc(100vh - 32px)。
    // 气泡锚在 chip 下方（top ≈ 60px+），若 max-height 仍按"贴顶 16px"算，气泡底边会
    // 超出视口约 (top-16)px → 底部的「关闭/采纳/丢弃」按钮被视口截断、滚到底也够不着
    // （用户反馈：要缩放才点得到）。这里把上限收到「视口底部上方 16px」，配合 CSS 的
    // overflow-y:auto，内容超长时气泡内滚，按钮始终在视口内可达。
    const bottomMargin = 16;
    const maxH = Math.max(180, window.innerHeight - top - bottomMargin);
    bubble.style.maxHeight = `${maxH}px`;
  }

  // ===== streaming 状态：每个 turn 一个 buffer，50ms 节流 re-render markdown =====
  state.streamingTurns = state.streamingTurns || new Map();

  function initStreamingBubble(turnId) {
    const turn = state.activeTurns.get(turnId);
    if (!turn) return;
    const bubble = ensureBubble(turnId);
    bubble.classList.remove('pending', 'preview', 'applied', 'failed');
    bubble.classList.add('streaming');
    const tagLabel = (turn.mode === 'widget') ? '🎮 互动演示生成中…'
      : (turn.mode === 'searchImage') ? '🔍 Claude 正在搜图…'
      : (turn.mode === 'ask') ? 'AI 回答中…'
      : 'AI 生成中…';
    bubble.innerHTML = `
      <div class="bubble-header">
        <span class="bubble-tag">${tagLabel}</span>
        <span class="bubble-range">行 ${turn.info.startLine + 1}–${turn.info.endLine}</span>
        <button type="button" class="bubble-cancel-btn" data-action="cancel-turn" data-turn-id="${turnId}" title="取消这次 AI 生成（中断网络请求）">✕ 取消</button>
      </div>
      <div class="bubble-body markdown-body" data-streaming-body></div>
    `;
    positionBubble(bubble, bubbleAnchorRect(turnId));
  }

  /**
   * markdown-it 配置了 html:true（讲义里 <details> 等需要透传 raw HTML），但
   * streaming 阶段 AI 一字一字往外吐 widget 源码时，AI 输出里的 <style>/<script>
   * 会在 ```widget 围栏闭合前被 markdown-it 当 raw HTML 注入 DOM。webview CSP
   * 包含 style-src 'unsafe-inline'（widget iframe srcdoc 需要它），所以 <style>
   * 真的被浏览器执行 —— widget 内的 `:root { --bg: #ffffff }` 把整个 webview
   * 的 --bg 改成白色，bubble 整片变白。CSP 只拦 <script>（script-src 不含
   * 'unsafe-inline'），但 <style> 兜不住。这里在 markdown 输出后用正则剥掉。
   */
  function sanitizeRawStyleScript(html) {
    let s = String(html || '');
    // 完整闭合的：整段剥
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    // streaming 未闭合的（流式输出到一半）：从 <style 一直切到末尾
    s = s.replace(/<style\b[\s\S]*$/i, '');
    s = s.replace(/<script\b[\s\S]*$/i, '');
    return s;
  }

  function updateStreamingBubble(turnId, text) {
    const bubble = bubbles.get(turnId);
    if (!bubble) return;
    const body = bubble.querySelector('[data-streaming-body]');
    if (!body) return;

    // widget 模式 streaming 期早期兜底：AI 即便经过 prompt 加强仍可能不写 ```widget
    // 围栏（注意力衰减），直接吐 raw HTML 开头。如果不前置围栏，markdown-it 会把
    // <!DOCTYPE>/<html>/<body>/<div>/<svg> 等当 raw HTML 透传，浏览器尝试解析 →
    // bubble 里既污染样式又显示乱七八糟。这里检测：widget 模式 + 内容不是 ```
    // 开头 → 前置 "```widget\n" 让 markdown-it 把整段当未闭合 fence 渲染（hljs
    // 代码块外观，干净）。stream 结束后宿主端会把完整内容包成 ```widget...```，
    // showPreviewBubble 重建 DOM 时 renderWidgets 再把它变成 iframe。
    const turn = state.activeTurns.get(turnId);
    let renderText = text;
    if (turn && turn.mode === 'widget') {
      const trimmed = String(text || '').trim();
      // 还没开始 / 不以反引号开头（说明 AI 直接吐 HTML 或别的）
      if (trimmed && !/^```/.test(trimmed)) {
        renderText = '```widget\n' + text;
      }
    }

    body.innerHTML = sanitizeRawStyleScript(renderMarkdown(renderText));
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
        <button type="button" class="bubble-cancel-btn" data-action="cancel-turn" data-turn-id="${turnId}" title="取消这次 AI 生成（中断网络请求）">✕ 取消</button>
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
    // widget 模式提交时为了避免走 rewrite 写回，复用了 intent='ask' 发给后端，
    // 但前端 turn.mode 仍然记录的是真实意图 'widget'。UI 文案要优先看 turn.mode，
    // 否则 widget 模式会跟着 ask 路径显示成 "AI 回答" / "🤖 AI 回答" 的 callout。
    const isWidget = turn.mode === 'widget';
    const isAskLike = !isWidget && effectiveIntent === 'ask';
    bubble.classList.toggle('ask', isAskLike);
    bubble.classList.toggle('widget', isWidget);

    bubble.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'bubble-header';
    const tagLabel = isWidget ? '🎮 互动演示'
      : isAskLike ? 'AI 回答'
      : 'AI 建议';
    header.innerHTML = `
      <span class="bubble-tag">${tagLabel}</span>
      <span class="bubble-range">行 ${turn.info.startLine + 1}–${turn.info.endLine}</span>
    `;
    bubble.appendChild(header);

    const body = document.createElement('div');
    body.className = 'bubble-body markdown-body';
    // 跟 streaming 同样兜底 raw <style>/<script>：AI 偶尔忘写 ```widget 围栏直接吐
    // raw HTML，markdown-it html:true 会透传 → 浏览器执行 → 污染 webview :root。
    body.innerHTML = sanitizeRawStyleScript(renderMarkdown(suggestion));
    renderMath(body);
    void renderMermaid(body);
    void renderGraphviz(body);
    renderWidgets(body);
    bubble.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'bubble-actions';

    if (effectiveIntent === 'ask') {
      // 提问模式（或 widget 模式 —— widget 复用 ask 不走 rewrite 写回）：
      // 提供"存到讲义"和"关闭"两个按钮。widget 和真 ask 文案区分。
      const btnSaveAsIdea = document.createElement('button');
      btnSaveAsIdea.className = 'btn-ghost';
      btnSaveAsIdea.textContent = isWidget ? '保存到讲义' : '把回答存到讲义';
      btnSaveAsIdea.title = isWidget
        ? '把互动演示作为可折叠块追加到选区下方'
        : '把 AI 回答作为引用块追加到选区下方';
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
        const calloutLabel = isWidget ? '🎮 互动演示' : '🤖 AI 回答';
        const note = wrapAsCallout(calloutLabel, suggestion, { summary: rawQuestion });
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

  // ===== 多模态：粘贴图 / 拖入图 / 粘贴 URL =====
  // 设计：webview 监听全局 paste / drop，识别剪贴板/拖入数据：
  //   - 图片 blob → 读 dataURL → 发宿主 pasteMedia { kind:'image-blob' }
  //   - URL 字符串 → 识别图/YouTube/Bilibili → 发宿主 pasteMedia { kind:'url' }
  // 宿主端写到 assets/ 或生成视频卡片 markdown，插到 targetLine 或末尾。

  /** 从 URL 识别出多模态类型 + 元数据。 */
  function detectMediaUrl(url) {
    const s = String(url || '').trim();
    if (!s) return null;
    // YouTube：youtu.be/<ID>?t=N 或 youtube.com/watch?v=<ID>&t=Ns
    let m = s.match(/^https?:\/\/(?:www\.|m\.)?youtu(?:be\.com\/watch\?[^#\s]*v=|\.be\/)([A-Za-z0-9_-]{6,})/i);
    if (m) {
      const id = m[1];
      const tMatch = s.match(/[?&]t=(\d+)(?:h(\d+))?m?(\d+)?s?/i) || s.match(/[?&]t=(\d+)m(\d+)s/i) || s.match(/[?&]start=(\d+)/i);
      let t = 0;
      if (tMatch) {
        // 简单：只接受纯秒数（?t=120），更复杂的 1h2m30s 留给用户后续手改
        const raw = String(s).match(/[?&](?:t|start)=(\d+)/);
        if (raw) t = parseInt(raw[1], 10) || 0;
      }
      return { kind: 'video', platform: 'youtube', id, t, url: s };
    }
    // Bilibili：bilibili.com/video/BVxxx 或 av123，?t=N 秒
    m = s.match(/^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+|av\d+)/i);
    if (m) {
      const id = m[1];
      const tMatch = s.match(/[?&]t=(\d+)/);
      const t = tMatch ? parseInt(tMatch[1], 10) || 0 : 0;
      return { kind: 'video', platform: 'bilibili', id, t, url: s };
    }
    // 普通图片：扩展名结尾，或带常见图床路径
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(s) && /^https?:\/\//i.test(s)) {
      return { kind: 'image-url', url: s };
    }
    return null;
  }

  /** 从 File / Blob 读出 dataURL，给宿主发图片字节。 */
  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** 决定插入位置：有选区 → 选区结束行；无选区 → 末尾（'end'）。 */
  function pickInsertLine() {
    if (currentSelectionInfo && !currentSelectionInfo.isFullDoc
        && Number.isFinite(currentSelectionInfo.endLine)) {
      return currentSelectionInfo.endLine;
    }
    return 'end';
  }

  async function handlePastedFile(file) {
    if (!vscode) return false;
    if (!file || !/^image\//i.test(file.type || '')) return false;
    try {
      const dataUrl = await readBlobAsDataUrl(file);
      vscode.postMessage({
        type: 'pasteMedia',
        media: { kind: 'image-blob', dataUrl, name: file.name || 'image.png', mime: file.type },
        targetLine: pickInsertLine(),
      });
      toast('已粘贴图片，正在保存…', 'info');
      return true;
    } catch (err) {
      toast('读取图片失败：' + (err && err.message ? err.message : err), 'error');
      return false;
    }
  }

  function handlePastedUrl(url) {
    if (!vscode) return false;
    const info = detectMediaUrl(url);
    if (!info) return false;
    vscode.postMessage({
      type: 'pasteMedia',
      media: info,
      targetLine: pickInsertLine(),
    });
    const label = info.kind === 'video'
      ? (info.platform === 'youtube' ? 'YouTube' : 'Bilibili') + ' 视频'
      : '图片 URL';
    toast(`已识别 ${label}，正在嵌入…`, 'info');
    return true;
  }

  // paste 事件：剪贴板里有图就拦截走我们的流程；否则放行（让 textarea 等正常粘贴）
  document.addEventListener('paste', (e) => {
    // 在 input / textarea / contentEditable 内不拦截，让原生粘贴生效
    const t = e.target;
    const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;

    const cd = e.clipboardData;
    if (!cd) return;
    // 优先找图片
    for (let i = 0; i < cd.items.length; i++) {
      const item = cd.items[i];
      if (item.kind === 'file' && /^image\//i.test(item.type)) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void handlePastedFile(file);
          return;
        }
      }
    }
    // 没图片：尝试当 URL 处理
    const text = cd.getData('text/plain') || '';
    if (text && /^https?:\/\//i.test(text.trim())) {
      const handled = handlePastedUrl(text.trim());
      if (handled) e.preventDefault();
    }
  });

  // dragover + drop：拖入图片文件
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();  // 必须 preventDefault 才能触发 drop
    }
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    const file = e.dataTransfer.files[0];
    if (file && /^image\//i.test(file.type || '')) {
      e.preventDefault();
      void handlePastedFile(file);
    }
  });

  // ===== 视频卡片渲染 =====
  // 讲义 md 里的视频用如下 markdown 表示（pasteMedia 宿主端生成）：
  //   <div class="cc-video" data-platform="youtube" data-id="xxx" data-t="120"
  //        data-url="https://..."><a href="https://...">视频标题</a></div>
  // 这里把它替换成卡片 UI：缩略图 + 标题 + 时间戳 + 平台徽章，点击发消息让宿主用
  // vscode.env.openExternal 打开（webview 不能直接打开外链）。
  function renderVideoCards(root) {
    if (!root) return;
    const blocks = root.querySelectorAll('.cc-video[data-platform][data-id]');
    blocks.forEach((wrap) => {
      if (wrap.dataset.rendered === '1') return;
      const platform = wrap.dataset.platform;
      const id = wrap.dataset.id;
      const t = parseInt(wrap.dataset.t || '0', 10) || 0;
      const url = wrap.dataset.url || (
        platform === 'youtube'
          ? 'https://www.youtube.com/watch?v=' + id + (t ? '&t=' + t + 's' : '')
          : platform === 'bilibili'
            ? 'https://www.bilibili.com/video/' + id + (t ? '?t=' + t : '')
            : '#'
      );
      // YouTube 的 hqdefault 缩略图 URL 是固定模板；B 站官方缩略图需要 API，
      // 暂时用一个占位 SVG（深灰底 + 平台 logo 字符），后续可换 oEmbed 抓真图。
      const thumbUrl = platform === 'youtube'
        ? 'https://i.ytimg.com/vi/' + helpers.escapeHtml(id) + '/hqdefault.jpg'
        : '';
      // 时间戳：120 秒 → "2:00"
      const tStr = t > 0
        ? Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0')
        : '';
      const platformLabel = platform === 'youtube' ? 'YouTube'
        : platform === 'bilibili' ? 'Bilibili'
        : '视频';
      // 取卡片内现有的 <a> 文本（如果有）作为标题；否则用 URL 当标题
      const existingLink = wrap.querySelector('a');
      const title = (existingLink && existingLink.textContent.trim()) || url;
      wrap.innerHTML = `
        <a class="cc-video-card" href="#" data-open-external="${helpers.escapeHtml(url)}">
          <div class="cc-video-thumb"${thumbUrl ? ' style="background-image:url(' + thumbUrl + ')"' : ''}>
            ${thumbUrl ? '' : '<span class="cc-video-thumb-fallback">' + platformLabel + '</span>'}
            <span class="cc-video-play">▶</span>
          </div>
          <div class="cc-video-meta">
            <div class="cc-video-title">${helpers.escapeHtml(title)}</div>
            <div class="cc-video-sub">
              <span class="cc-video-platform">📺 ${platformLabel}</span>
              ${tStr ? '<span class="cc-video-t">⏱ ' + helpers.escapeHtml(tStr) + ' 起</span>' : ''}
            </div>
          </div>
        </a>
      `;
      wrap.dataset.rendered = '1';
    });
  }

  // 全局接管视频卡片点击 → 让宿主用 vscode.env.openExternal 打开
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('[data-open-external]');
    if (!a) return;
    e.preventDefault();
    const url = a.getAttribute('data-open-external');
    if (url && vscode) {
      vscode.postMessage({ type: 'openExternalUrl', url });
    }
  });

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

  // ===== 右键菜单：打开源文件 =====
  // 用动态创建的轻量菜单，不污染 index.html。
  let _contextMenuEl = null;

  function ensureContextMenu() {
    if (_contextMenuEl) return _contextMenuEl;
    const el = document.createElement('div');
    el.className = 'lecture-context-menu';
    el.hidden = true;
    el.innerHTML = '<button type="button" data-action="open-source-file">📄 打开源文件</button>';
    document.body.appendChild(el);
    el.addEventListener('mousedown', (e) => {
      // 阻止 button mousedown 偷 focus / 折叠 selection（虽然这里不依赖 selection，保险起见）
      e.preventDefault();
    });
    el.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      hideContextMenu();
      if (act === 'open-source-file') {
        if (vscode) vscode.postMessage({ type: 'openSourceFile' });
      }
    });
    _contextMenuEl = el;
    return el;
  }

  function showContextMenu(x, y) {
    const el = ensureContextMenu();
    el.hidden = false;
    // 先放出来再测尺寸，做边界裁剪避免菜单超出视口
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    el.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    el.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  }

  function hideContextMenu() {
    if (_contextMenuEl) _contextMenuEl.hidden = true;
  }

  document.addEventListener('contextmenu', (e) => {
    // textarea / input / contentEditable 留默认菜单（粘贴 / 复制等）
    const t = e.target;
    const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
    if (tag === 'textarea' || tag === 'input' || (t && t.isContentEditable)) return;
    // widget iframe 内的右键拿不到（跨源），这里不会被触发，无需特殊处理
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });

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
    // 点浮层菜单内部不关菜单；点别处关菜单。
    // .lecture-context-menu 覆盖：右键菜单 + widget ⋯ 菜单（两者共用 class）
    // .cc-widget-btn-more 是 widget toolbar 上的 ⋯ 按钮自身，点它不应被 mousedown 关掉
    // （否则 click 才能再开起来 → 行为正确但 toggle 不直观）
    const inMenu = e.target.closest && e.target.closest('.lecture-context-menu');
    const onMoreBtn = e.target.closest && e.target.closest('.cc-widget-btn-more');
    if (!inMenu && !onMoreBtn) {
      hideContextMenu();
      hideWidgetMoreMenu();
    }
    hidePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePopover();
      hideContextMenu();
      hideWidgetMoreMenu();
    }
    // Ctrl/Cmd + Z → 撤回上次 AI 写入。仅在 undo pill 可见时生效，
    // 用 .visible class 判断（写入后 12s 内）。不在 input/textarea/可编辑节点里。
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey && !e.altKey) {
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
      if (_undoPillEl && _undoPillEl.classList.contains('visible')) {
        e.preventDefault();
        if (vscode) vscode.postMessage({ type: 'revertLastWriteback' });
        _undoPillEl.textContent = '↷ 重做（再撤回）';
        return;
      }
    }
    // Ctrl/Cmd + Shift + Z → 重做（再次 revertLastWriteback）。
    // 后端 revertLastWriteback 是幂等 swap：A↔B 来回换。
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
      if (_undoPillEl && _undoPillEl.classList.contains('visible')) {
        e.preventDefault();
        if (vscode) vscode.postMessage({ type: 'revertLastWriteback' });
        return;
      }
    }
  });

  // Ctrl+滚轮 整体缩放（讲义阅读器独立 panel，本地缩放）。
  // 治根策略：body.zoom 整体缩放 + widget container 反向 zoom 抵消。
  // 这样 widget iframe 不被父 zoom 拉伸，内部 viewport 稳定，vh 元素永远不会
  // 因为 zoom 触发增长循环。代价：缩放时 widget 视觉不跟字号缩——值得换稳定性。
  let _zoomEndTimer = null;
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    _lectureFontScale = Math.max(0.7, Math.min(2.0, _lectureFontScale + delta));
    document.body.style.zoom = String(_lectureFontScale);
    // 同步给所有 widget container 反向 zoom，抵消父 body.zoom。
    // 净视觉效果：widget 不跟随父页缩放 → iframe 内部 viewport 不变 → vh 元素不变 → 无循环。
    const inverseZoom = _lectureFontScale === 1 ? '' : String(1 / _lectureFontScale);
    document.querySelectorAll('.cc-widget-container').forEach((wrap) => {
      wrap.style.zoom = inverseZoom;
    });
    _isZooming = true;
    if (_zoomEndTimer) clearTimeout(_zoomEndTimer);
    _zoomEndTimer = setTimeout(() => {
      _isZooming = false;
      _zoomEndTimer = null;
    }, 400);
  }, { passive: false });

  if (els.chip) {
    // 关键：阻止 <button> 在 mousedown 时偷走 document focus / 折叠 selection。
    // 没这一行的话，用户"先选中代码块源码 → 点蓝按钮"时，浏览器会在 mousedown 那一刻
    // 把 selection collapse 掉 → getSelectionLineRange 里 sel.isCollapsed 直接 return
    // null → pickContextInfo 掉到"全文 fallback"。这是标准 toolbar 按钮模式。
    // preventDefault 只阻止 focus/select 行为，不影响 click 事件触发。
    els.chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
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

  // 左上角撤回按钮：恢复 .bak 备份（Ctrl+Z 在 webview 内不可靠，给个显式入口）
  if (els.btnRevert && vscode) {
    els.btnRevert.addEventListener('click', () => {
      vscode.postMessage({ type: 'revertLastWriteback' });
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
        // 讲义所在目录的 webview URI 前缀，用于把 ![](assets/xxx.png) 相对路径
        // 重写成 webview 能加载的绝对 URI（renderLecture 后期处理）
        state.assetBaseUri = msg.assetBaseUri || '';
        // 学科 / 章节 / 讲义标题：智能搜图等场景给 Claude Code 当 context
        state.subject = msg.subject || '';
        state.topicTitle = msg.topicTitle || '';
        state.lessonTitle = msg.lessonTitle || '';
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
      case 'inlineCancelled': {
        // 用户点 ✕ 取消后，宿主端 AbortController.abort() 把 chatCompletion 中断，
        // 在 abort 错误分支发了这个消息。这里清理 bubble + streaming buf + 提示。
        // 同时也是"智能搜图未找到合适图"等失败场景的统一收尾：清 cc-suggest 卡 busy 态
        // 让用户能重试，而不是永远卡在灰色禁用状态。
        if (!msg.turnId) break;
        const entry = state.streamingTurns.get(msg.turnId);
        if (entry?.trailingTimer) clearTimeout(entry.trailingTimer);
        state.streamingTurns.delete(msg.turnId);
        state.activeTurns.delete(msg.turnId);
        removeBubble(msg.turnId);
        // 找到关联到此 turnId 的 cc-suggest 卡，解除 busy 灰态
        const stuckCard = document.querySelector(`.cc-suggest[data-busy-turn-id="${msg.turnId}"]`);
        if (stuckCard) {
          stuckCard.classList.remove('cc-suggest-busy');
          delete stuckCard.dataset.busyTurnId;
        }
        toast('已取消 AI 生成', 'info');
        break;
      }
      case 'inlineSuggestResult': {
        const result = msg.result || {};
        const { turnId, status, suggestion, errorMessage, appliedRange, intent } = result;
        if (!turnId) return;
        // 用户已经主动取消（cancelTurn 立即清 activeTurns）？
        // 忽略 abort 没拦住的"晚到"消息：宿主端 chatCompletion 可能在 abort 调用前
        // 已经接近完成，会回 preview/applied/failed；这些后续消息不该让 bubble 再冒出来。
        if (!state.activeTurns.has(turnId)) return;
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
