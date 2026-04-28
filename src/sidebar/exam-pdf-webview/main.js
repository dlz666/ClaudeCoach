// 变体题 PDF 预览 webview 控制器。
// 接收 init 消息携带 variantSet，按题型差异化渲染。
// 点击打印按钮触发 window.print()，让用户用浏览器原生打印面板"另存为 PDF"。

(function () {
  'use strict';

  // @ts-ignore
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: () => {} };

  const $ = (id) => document.getElementById(id);
  const els = {
    paperTitle: $('paper-title'),
    paperSubtitle: $('paper-subtitle'),
    paperH1: $('paper-h1'),
    paperMeta: $('paper-meta'),
    questions: $('questions'),
    emptyState: $('empty-state'),
    btnPrint: $('btn-print'),
  };

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let md = null;
  if (typeof window.markdownit === 'function') {
    md = window.markdownit({ html: false, breaks: true, linkify: false, typographer: false });
  }

  function renderMarkdown(text) {
    if (md) {
      try { return md.render(String(text || '')); }
      catch (err) { console.warn('md render fail', err); }
    }
    return `<p>${escapeHtml(text || '')}</p>`;
  }

  function renderMath(root) {
    if (root && typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(root, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
          strict: 'ignore',
        });
      } catch (err) {
        console.warn('math render fail', err);
      }
    }
  }

  function typeLabel(t) {
    switch (t) {
      case 'choice': return '选择题';
      case 'fill': return '填空题';
      case 'free': return '简答/自由作答';
      case 'proof': return '证明题';
      case 'code': return '编程题';
      case 'short': return '短答题';
      default: return '题';
    }
  }

  function focusModeLabel(mode) {
    if (mode === 'cover-all') return '覆盖全卷';
    if (mode === 'mock-full') return '模考整套';
    return '强化弱项';
  }

  function difficultyDots(d) {
    const n = Math.max(1, Math.min(5, Number(d) || 3));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  function blankLines(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += '<div class="blank-line"></div>';
    return out;
  }

  function renderQuestion(q, idx) {
    const li = document.createElement('li');
    li.className = `question type-${escapeHtml(q.type || 'unknown')}`;
    li.dataset.diff = String(q.difficulty || 3);

    const head = document.createElement('div');
    head.className = 'q-head';
    head.innerHTML = `
      <span class="q-num">${idx + 1}.</span>
      <span class="q-type-tag">${escapeHtml(typeLabel(q.type))}</span>
      <span class="q-diff" title="难度">${escapeHtml(difficultyDots(q.difficulty))}</span>
      ${q.estimatedScore ? `<span class="q-score">(${escapeHtml(String(q.estimatedScore))} 分)</span>` : ''}
      ${(q.knowledgePoints || []).length ? `<span class="q-points">考点：${(q.knowledgePoints || []).map(escapeHtml).join(' / ')}</span>` : ''}
    `;
    li.appendChild(head);

    const prompt = document.createElement('div');
    prompt.className = 'q-prompt';
    prompt.innerHTML = renderMarkdown(q.prompt || '');
    li.appendChild(prompt);

    // 题型差异化排版
    if (q.type === 'choice') {
      // 选择题：选项 ABCD，紧凑排列
      const opts = q.options && q.options.length ? q.options : [];
      if (opts.length) {
        const ol = document.createElement('ol');
        ol.className = 'q-options';
        ol.setAttribute('type', 'A');
        opts.forEach((opt) => {
          const item = document.createElement('li');
          item.innerHTML = renderMarkdown(opt);
          ol.appendChild(item);
        });
        li.appendChild(ol);
      }
      const ans = document.createElement('div');
      ans.className = 'q-answer-line';
      ans.innerHTML = '<span class="answer-label">答：</span><span class="answer-fill">_____________</span>';
      li.appendChild(ans);
    } else if (q.type === 'fill') {
      // 填空：紧凑，留 2 行
      const ans = document.createElement('div');
      ans.className = 'q-answer-blanks';
      ans.innerHTML = blankLines(2);
      li.appendChild(ans);
    } else if (q.type === 'short') {
      // 短答题：4 行
      const ans = document.createElement('div');
      ans.className = 'q-answer-area type-short';
      ans.innerHTML = blankLines(4);
      li.appendChild(ans);
    } else if (q.type === 'proof' || q.type === 'code') {
      // 证明 / 编程：留 12 行（约半页）
      const ans = document.createElement('div');
      ans.className = `q-answer-area type-${q.type}`;
      ans.innerHTML = blankLines(12);
      li.appendChild(ans);
    } else {
      // 自由作答 / unknown：6 行
      const ans = document.createElement('div');
      ans.className = `q-answer-area type-${q.type || 'free'}`;
      ans.innerHTML = blankLines(6);
      li.appendChild(ans);
    }

    return li;
  }

  function renderVariantSet(payload) {
    const sessionName = payload.sessionName || '';
    const variantSet = payload.variantSet || {};
    const questions = variantSet.questions || [];

    const titleText = sessionName
      ? `${sessionName} · 变体题集`
      : '变体题集';
    if (els.paperTitle) els.paperTitle.textContent = titleText;
    if (els.paperH1) els.paperH1.textContent = titleText;

    const total = (questions.length) || variantSet.count || 0;
    const totalScore = questions.reduce((sum, q) => sum + (Number(q.estimatedScore) || 0), 0);
    const metaParts = [
      `题量：${total}`,
      `策略：${focusModeLabel(variantSet.focusMode)}`,
      totalScore ? `合计：${totalScore} 分` : '',
      `生成于：${variantSet.generatedAt ? new Date(variantSet.generatedAt).toLocaleString('zh-CN') : '—'}`,
    ].filter(Boolean);
    if (els.paperMeta) {
      els.paperMeta.innerHTML = metaParts.map((p) => `<span class="meta-piece">${escapeHtml(p)}</span>`).join('');
    }
    if (els.paperSubtitle) {
      els.paperSubtitle.textContent = `${total} 题 / ${focusModeLabel(variantSet.focusMode)}`;
    }

    if (els.questions) {
      els.questions.innerHTML = '';
      if (!questions.length) {
        if (els.emptyState) els.emptyState.classList.remove('hidden');
        return;
      }
      if (els.emptyState) els.emptyState.classList.add('hidden');
      questions.forEach((q, idx) => {
        els.questions.appendChild(renderQuestion(q, idx));
      });
      // 渲染数学公式
      renderMath(els.questions);
    }
  }

  // 打印按钮
  els.btnPrint?.addEventListener('click', () => {
    try {
      window.print();
    } catch (err) {
      console.warn('print failed:', err);
    }
  });

  // 接收消息
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'init') {
      renderVariantSet(msg);
    }
  });

  // 通知后端 ready
  vscode.postMessage({ type: 'pdfReady' });
})();
