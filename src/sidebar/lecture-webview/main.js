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
        // ```widget 块：完整 HTML+JS+CSS 的交互式演示，由 renderWidgets 用 iframe 渲染
        if (lang === 'widget' || lang === 'interactive' || lang === 'demo') {
          const escaped = (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<pre class="widget-source"><code class="language-widget">${escaped}</code></pre>`;
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
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.innerHTML = svg;
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
      pre.replaceWith(container);
    }
  }

  function makeWidgetContainer(userSrc, id) {
    const container = document.createElement('div');
    container.className = 'cc-widget-container';
    container.dataset.widgetId = id;

    // 顶部 toolbar：查看源码 / 复制源码 / 重载
    const toolbar = document.createElement('div');
    toolbar.className = 'cc-widget-toolbar';
    toolbar.innerHTML = `
      <span class="cc-widget-label">互动演示</span>
      <span class="cc-widget-spacer"></span>
      <button class="cc-widget-btn" data-action="copy-source" title="复制源码到剪贴板（方便发给开发者排查）">📋 复制源码</button>
      <button class="cc-widget-btn" data-action="reload" title="重新加载">↻</button>
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
      } else if (act === 'reload') {
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
    return html.replace(/<script\b[^>]*>([\s\S]*)<\/script\s*>/gi, (match, body) => {
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
        // 直接匹配 widget 内容真实高度 + 16px 安全余量，永不出内层滚动条。
        // 之前有 4000 上限和"单调增高"约束 → 大 widget 被截 + 加载完后没法
        // shrink 回真实高度。现在完全跟随内容。
        iframe.style.height = (d.height + 16) + 'px';
      }
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
    renderWidgets(els.body);       // 同步，但 iframe 内部脚本异步加载
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
          { key: 'idea', label: '💡 记想法', hint: '把你的想法以引用块追加到讲义末尾' },
        ]
      : [
          { key: 'rewrite', label: '🛠 改这段', hint: 'AI 输出会替换/插入到选区' },
          { key: 'ask', label: '❓ 提问', hint: 'AI 会以聊天形式回答，不动讲义' },
          { key: 'widget', label: '🎮 互动演示', hint: '强制让 AI 基于这段输出一个 ```widget 互动演示块' },
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
              : (info.isFullDoc
                  ? '记下你自己的想法/疑问，会作为引用块追加到讲义末尾。'
                  : '记下你自己的想法/疑问，会作为引用块追加到这段下方。');
        btnSubmit.textContent = m.key === 'rewrite'
          ? (info.isFullDoc
              ? '重写整篇讲义'
              : (state.applyMode === 'auto-apply' ? '直接改写' : '发送给 AI'))
          : m.key === 'ask' ? '问 AI'
          : m.key === 'widget' ? '🎮 生成互动演示'
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
      '6. JS 字符串里如果有 `</script>`，**必须**写成 `<\\/script>`；CSS 里的 `</style>` 同理写 `<\\/style>`',
      '7. **颜色 CSS 变量 + 必须保证对比**：可用 `var(--bg)` `var(--fg)` `var(--accent)` `var(--accent-fg)` `var(--border)` `var(--input-bg)` `var(--input-fg)` `var(--muted)` `var(--panel-bg)`，**但绝对不能 SVG 节点 fill 用容器同色变量**：',
      '   - ❌ `.graph-shell { background: var(--input-bg) }` + `.node circle { fill: var(--input-bg) }` → 节点融进背景看起来空',
      '   - ✅ SVG 节点 fill 用 `var(--accent)` / `var(--fg)`（前景色）；stroke 用 `var(--border)` / `var(--accent-fg)`',
      '   - ✅ SVG 边 stroke 用 `var(--fg)` / `var(--accent)` 这种前景色；不要用 `var(--border)` 因为 border 颜色对暗背景对比度低',
      '8. **不要写死 1000px 这种像素宽度**，要响应式',
      '9. **绝对不要内联 `// 注释`**：因为 AI 经常把多个语句压一行，`// xxx` 注释会**吃掉同一行后面的所有代码**，导致 syntax error。要写注释**用 `/* xxx */` 块注释**，或者把注释独占一行。',
      '10. **每个语句独占一行**，不要 `a;b;c;d;` 压一行。代码再啰嗦也比单行难调试强。',
      '11. **不要把整段 JS 包在 try/catch** —— 会吞掉真实逻辑 bug。让错误抛出，iframe bridge 的 error 监听会显示醒目红色覆盖层方便排查',
      '12. **写完代码自己脑中跑一遍**：数据数组（nodes/edges/items）有真元素？init()/reset() 真填了状态？render() 调用时数据 ready 了吗？',
      '13. **保持简单 < 100 行 JS**。多功能 ≠ 好 widget。别上 playback / 调速滑块 / 多状态那一套，单纯"下一步 / 重置 + 高亮当前节点"就够好。复杂 = bug = 白屏',
      '',
      '## 演示设计要求',
      '- 有可点的按钮（至少 1-2 个：下一步 / 重置）',
      '- 有视觉反馈（高亮 / 颜色变化 / 数字更新），不能只是静态图',
      '- 当前步骤 / 状态在 UI 上可见',
      '',
      '## 用户需求',
      instruction,
      '',
      '现在请直接输出 ```widget 代码块，开始。',
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
    renderWidgets(body);
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
