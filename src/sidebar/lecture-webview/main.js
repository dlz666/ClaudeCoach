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
      html: false,
      linkify: true,
      typographer: false,
      breaks: false,
      highlight: (str, lang) => {
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

  // ===== chip / popover =====

  function hideChip() {
    if (els.chip) els.chip.hidden = true;
    currentSelectionInfo = null;
  }

  function showChipAt(info) {
    if (!els.chip || !info || !info.rect) return;
    currentSelectionInfo = info;
    const rect = info.rect;
    const top = window.scrollY + rect.top - 6;
    const left = window.scrollX + rect.right + 8;
    els.chip.style.top = `${Math.max(top, 8)}px`;
    els.chip.style.left = `${Math.min(left, window.innerWidth - 48)}px`;
    els.chip.hidden = false;
  }

  function hidePopover() {
    if (els.popover) {
      els.popover.hidden = true;
      els.popover.innerHTML = '';
    }
  }

  function showPopoverFor(info) {
    if (!els.popover || !info) return;
    const rect = info.rect;
    const top = window.scrollY + rect.bottom + 12;
    const left = Math.max(16, Math.min(window.scrollX + rect.left, window.innerWidth - 420));
    els.popover.style.top = `${top}px`;
    els.popover.style.left = `${left}px`;
    els.popover.innerHTML = '';

    // 三种 mode：rewrite=改这段 / ask=提问 / idea=记一下想法（不改文件）
    let currentMode = 'rewrite';

    const heading = document.createElement('div');
    heading.className = 'popover-heading';
    heading.textContent = `选中第 ${info.startLine + 1}–${info.endLine} 行`;
    els.popover.appendChild(heading);

    // mode 切换条
    const modeBar = document.createElement('div');
    modeBar.className = 'popover-mode-bar';
    const modes = [
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
          ? '告诉 AI 怎么改：「补一个例子」「化简这段」「加公式推导」…'
          : m.key === 'ask'
            ? '关于这段你想问什么：「这步为什么成立」「能换种方式解释吗」…'
            : '记下你自己的想法/疑问，会作为引用块追加到这段下方。';
        btnSubmit.textContent = m.key === 'rewrite'
          ? (state.applyMode === 'auto-apply' ? '直接改写' : '发送给 AI')
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
    textarea.placeholder = '告诉 AI 怎么改：「补一个例子」「化简这段」「加公式推导」…';
    textarea.rows = 3;
    els.popover.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'popover-actions';
    const btnSubmit = document.createElement('button');
    btnSubmit.className = 'btn-primary';
    btnSubmit.textContent = state.applyMode === 'auto-apply' ? '直接改写' : '发送给 AI';
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
      hideChip();
    }

    btnSubmit.addEventListener('click', submit);
    btnCancel.addEventListener('click', () => {
      hidePopover();
      hideChip();
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePopover();
        hideChip();
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

  /** idea 模式：本地直接把想法以引用块追加到选区下方，不调 AI。 */
  function submitInlineIdea(info, instruction) {
    if (!vscode) return;
    const turnId = (helpers.uuid && helpers.uuid()) || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const ideaBlock = '\n\n> 💡 **我的想法**：' + instruction.replace(/\n/g, '\n> ');
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

  function showPendingBubble(turnId, info) {
    const bubble = ensureBubble(turnId);
    bubble.classList.remove('preview', 'applied', 'failed');
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
        const note = '\n\n> 🤖 **AI 回答**：\n> ' + suggestion.replace(/\n/g, '\n> ');
        if (!vscode) return;
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
        finalContent: suggestion,
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

  // ===== events =====

  function onSelectionEnd() {
    const info = helpers.getSelectionLineRange ? helpers.getSelectionLineRange(els.body) : null;
    if (!info || !info.text || !info.text.trim()) {
      hideChip();
      return;
    }
    showChipAt(info);
  }

  document.addEventListener('mouseup', () => {
    // 让 selection 状态稳定
    setTimeout(onSelectionEnd, 0);
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
      onSelectionEnd();
    }
  });

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      // 评论框打开时不要被收起
      if (els.popover && !els.popover.hidden) return;
      hideChip();
    }
  });

  document.addEventListener('mousedown', (e) => {
    // 点 chip 自身不收
    if (e.target.closest && e.target.closest('#chip')) return;
    // 点评论框 / 气泡内部不收
    if (e.target.closest && (e.target.closest('#popover') || e.target.closest('.lecture-suggestion-bubble'))) return;
    hidePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePopover();
      hideChip();
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
      if (!currentSelectionInfo) return;
      showPopoverFor(currentSelectionInfo);
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
        } else {
          flashStatus('已刷新', 'info');
        }
        // 重新定位剩余气泡
        bubbles.forEach((bubble, turnId) => {
          positionBubble(bubble, bubbleAnchorRect(turnId));
        });
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
        break;
      }
      case 'log': {
        if (msg.level === 'error') toast(msg.message, 'error');
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
