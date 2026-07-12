(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const els = {
    lessonTitle: $('lesson-title'),
    roomStatus: $('room-status'),
    questionNav: $('question-nav'),
    gradedCount: $('graded-count'),
    questionNumber: $('question-number'),
    questionIntent: $('question-intent'),
    questionDifficulty: $('question-difficulty'),
    questionTime: $('question-time'),
    questionObjective: $('question-objective'),
    questionPrompt: $('question-prompt'),
    starterCode: $('starter-code'),
    answerZone: $('answer-zone'),
    hintZone: $('hint-zone'),
    feedbackZone: $('feedback-zone'),
    questionPosition: $('question-position'),
    draftStatus: $('draft-status'),
    btnHint: $('btn-hint'),
    btnGradeOne: $('btn-grade-one'),
    btnGradeMany: $('btn-grade-many'),
    btnPrev: $('btn-prev'),
    btnNext: $('btn-next'),
    btnOpenMarkdown: $('btn-open-markdown'),
    btnReload: $('btn-reload'),
  };

  const state = {
    args: null,
    exercises: [],
    generationId: 'legacy',
    activeIndex: 0,
    answers: {},
    hintsUsed: {},
    results: {},
    pending: new Set(),
    batchBusy: false,
  };

  const markdown = typeof window.markdownit === 'function'
    ? window.markdownit({ html: false, breaks: true, linkify: true })
    : null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(value) {
    if (!markdown) return `<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`;
    return markdown.render(String(value || ''));
  }

  function renderRichContent(root) {
    if (!root) return;
    root.querySelectorAll('pre code').forEach((node) => {
      try { window.hljs?.highlightElement(node); } catch { /* noop */ }
    });
    try {
      if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(root, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      }
    } catch { /* noop */ }
  }

  function sessionKey() {
    if (!state.args) return '';
    return `${state.args.subject}:${state.args.topicId}:${state.args.lessonId}:${state.generationId}`;
  }

  function loadDraft(serverResults) {
    const saved = vscode.getState() || {};
    const draft = saved.practiceSessions?.[sessionKey()];
    state.answers = draft?.answers && typeof draft.answers === 'object' ? { ...draft.answers } : {};
    state.hintsUsed = draft?.hintsUsed && typeof draft.hintsUsed === 'object' ? { ...draft.hintsUsed } : {};
    const draftResults = draft?.results && typeof draft.results === 'object' ? draft.results : {};
    state.results = { ...draftResults, ...(serverResults || {}) };
    Object.values(state.results).forEach((result) => {
      if (!result?.exerciseId) return;
      if (!state.answers[result.exerciseId] && result.studentAnswer) {
        state.answers[result.exerciseId] = result.studentAnswer;
      }
      state.hintsUsed[result.exerciseId] = Math.max(
        Number(state.hintsUsed[result.exerciseId]) || 0,
        Number(result.hintsUsed) || 0,
      );
    });
  }

  function saveDraft() {
    if (!state.args) return;
    const saved = vscode.getState() || {};
    const practiceSessions = { ...(saved.practiceSessions || {}) };
    practiceSessions[sessionKey()] = {
      answers: state.answers,
      hintsUsed: state.hintsUsed,
      results: state.results,
      savedAt: new Date().toISOString(),
    };
    vscode.setState({ ...saved, practiceSessions });
    els.draftStatus.textContent = `已自动保存 · ${new Date().toLocaleTimeString()}`;
  }

  function currentExercise() {
    return state.exercises[state.activeIndex] || null;
  }

  function currentAnswer() {
    const exercise = currentExercise();
    return exercise ? String(state.answers[exercise.id] || '') : '';
  }

  function setStatus(text, tone) {
    els.roomStatus.textContent = text;
    els.roomStatus.dataset.tone = tone || '';
  }

  function renderNav() {
    els.questionNav.innerHTML = state.exercises.map((exercise, index) => {
      const result = state.results[exercise.id];
      const pending = state.pending.has(exercise.id);
      const classes = [
        'question-dot',
        index === state.activeIndex ? 'is-active' : '',
        result ? 'is-graded' : '',
        pending ? 'is-pending' : '',
      ].filter(Boolean).join(' ');
      return `<button class="${classes}" type="button" data-index="${index}">
        <span class="dot-index">${result ? '✓' : index + 1}</span>
        <span class="dot-label">${escapeHtml(exercise.intent || exercise.type || '练习')}</span>
      </button>`;
    }).join('');
    els.questionNav.querySelectorAll('[data-index]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeIndex = Number(button.dataset.index) || 0;
        render();
      });
    });
    const graded = Object.keys(state.results).length;
    els.gradedCount.textContent = `${graded} / ${state.exercises.length}`;
  }

  function renderAnswer(exercise, disabled) {
    const answer = String(state.answers[exercise.id] || '');
    if (exercise.type === 'multiple-choice' && Array.isArray(exercise.options) && exercise.options.length) {
      els.answerZone.innerHTML = `<div class="option-list" role="radiogroup" aria-label="选择答案">${exercise.options.map((option, index) => {
        const value = `${String.fromCharCode(65 + index)}. ${option}`;
        return `<label class="option-card ${answer === value ? 'is-selected' : ''}">
          <input type="radio" name="answer-option" value="${escapeHtml(value)}" ${answer === value ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span class="option-key">${String.fromCharCode(65 + index)}</span>
          <span>${escapeHtml(option)}</span>
        </label>`;
      }).join('')}</div>`;
      els.answerZone.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.addEventListener('change', () => {
          state.answers[exercise.id] = input.value;
          saveDraft();
          render();
        });
      });
      return;
    }

    els.answerZone.innerHTML = `<textarea class="answer-input ${exercise.type === 'code' ? 'is-code' : ''}" aria-label="你的答案" placeholder="${exercise.type === 'code' ? '在这里补全或重写代码…' : '写下你的推理过程和答案…'}" ${disabled ? 'disabled' : ''}>${escapeHtml(answer)}</textarea>`;
    const input = els.answerZone.querySelector('textarea');
    let timer;
    input?.addEventListener('input', () => {
      state.answers[exercise.id] = input.value;
      clearTimeout(timer);
      timer = setTimeout(saveDraft, 500);
      updateButtons();
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && exercise.type === 'code') {
        event.preventDefault();
        input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        gradeCurrent();
      }
    });
  }

  function renderHints(exercise) {
    const hints = Array.isArray(exercise.hints) ? exercise.hints : [];
    const count = Math.max(0, Math.min(hints.length, Number(state.hintsUsed[exercise.id]) || 0));
    els.hintZone.innerHTML = hints.slice(0, count).map((hint, index) => `
      <div class="hint-card"><strong>提示 ${index + 1}</strong><span>${escapeHtml(hint)}</span></div>
    `).join('');
    els.btnHint.classList.toggle('hidden', !hints.length || count >= hints.length || !!state.results[exercise.id]);
    els.btnHint.textContent = count ? '再看一级提示' : '给我一点提示';
  }

  function renderFeedback(result) {
    if (!result) {
      els.feedbackZone.classList.add('hidden');
      els.feedbackZone.innerHTML = '';
      return;
    }
    const dimensions = Array.isArray(result.dimensionScores) ? result.dimensionScores : [];
    els.feedbackZone.innerHTML = `
      <div class="feedback-head">
        <h2>${result.score >= 90 ? '掌握稳固' : result.score >= 80 ? '基本掌握' : '需要订正'}</h2>
        <span class="feedback-score">${Number(result.score) || 0}</span>
      </div>
      <div class="feedback-body">${renderMarkdown(result.feedback || '')}</div>
      ${dimensions.length ? `<div class="dimension-grid">${dimensions.map((item) => {
        const score = Math.max(0, Math.min(100, Number(item.score) || 0));
        return `<div class="dimension">
          <div class="dimension-title"><span>${escapeHtml(item.name)}</span><strong>${score}</strong></div>
          <div class="dimension-track"><span style="width:${score}%"></span></div>
          ${item.comment ? `<small>${escapeHtml(item.comment)}</small>` : ''}
        </div>`;
      }).join('')}</div>` : ''}
      ${result.errorDiagnosis ? `<div class="diagnosis-row"><strong>关键诊断</strong><span>${escapeHtml(result.errorDiagnosis)}</span></div>` : ''}
      ${result.correction ? `<div class="diagnosis-row"><strong>最小修正</strong><span>${escapeHtml(result.correction)}</span></div>` : ''}
      ${result.nextStep ? `<div class="diagnosis-row"><strong>现在做</strong><span>${escapeHtml(result.nextStep)}</span></div>` : ''}
      <div class="feedback-persistence">
        <span><b>✓</b> 已同步到当前练习.md，不会另开反馈文件</span>
        <button class="room-link-btn" id="btn-review-markdown" type="button">在同一文件中查看</button>
      </div>
      <div class="feedback-actions"><button class="room-btn ghost" id="btn-retry" type="button">订正本题</button></div>
    `;
    els.feedbackZone.classList.remove('hidden');
    renderRichContent(els.feedbackZone);
    $('btn-review-markdown')?.addEventListener('click', () => vscode.postMessage({ type: 'openMarkdown' }));
    $('btn-retry')?.addEventListener('click', () => {
      const exercise = currentExercise();
      if (!exercise) return;
      delete state.results[exercise.id];
      state.answers[exercise.id] = '';
      saveDraft();
      render();
      requestAnimationFrame(() => els.answerZone.querySelector('textarea, input')?.focus());
    });
  }

  function updateButtons() {
    const exercise = currentExercise();
    const pending = exercise ? state.pending.has(exercise.id) : false;
    const hasAnswer = !!currentAnswer().trim();
    els.btnGradeOne.disabled = !exercise || !hasAnswer || pending || state.batchBusy || !!state.results[exercise.id];
    els.btnGradeOne.textContent = pending ? '批改中…' : '批改本题';
    const ready = state.exercises.filter((item) =>
      String(state.answers[item.id] || '').trim() && !state.results[item.id] && !state.pending.has(item.id)
    ).length;
    els.btnGradeMany.disabled = ready === 0 || state.batchBusy || state.pending.size > 0;
    els.btnGradeMany.textContent = state.batchBusy ? '整组批改中…' : `批改所有已作答题目${ready ? `（${ready}）` : ''}`;
    els.btnPrev.disabled = state.activeIndex <= 0;
    els.btnNext.disabled = state.activeIndex >= state.exercises.length - 1;
  }

  function render() {
    const exercise = currentExercise();
    if (!exercise) return;
    const pending = state.pending.has(exercise.id);
    const result = state.results[exercise.id];
    els.questionNumber.textContent = `QUESTION ${state.activeIndex + 1}`;
    els.questionIntent.textContent = exercise.intent || exercise.type || '练习';
    els.questionDifficulty.textContent = `难度 ${Number(exercise.difficulty) || 1}/5`;
    els.questionTime.textContent = `约 ${Number(exercise.estimatedMinutes) || 5} min`;
    els.questionObjective.textContent = exercise.learningObjective ? `训练目标：${exercise.learningObjective}` : '';
    els.questionPrompt.innerHTML = renderMarkdown(exercise.prompt || '');
    renderRichContent(els.questionPrompt);
    if (exercise.type === 'code' && exercise.starterCode) {
      els.starterCode.innerHTML = `<pre><code class="language-${escapeHtml(exercise.language || 'text')}">${escapeHtml(exercise.starterCode)}</code></pre>`;
      els.starterCode.classList.remove('hidden');
      renderRichContent(els.starterCode);
    } else {
      els.starterCode.classList.add('hidden');
      els.starterCode.innerHTML = '';
    }
    renderAnswer(exercise, pending || state.batchBusy || !!result);
    renderHints(exercise);
    renderFeedback(result);
    els.questionPosition.textContent = `${state.activeIndex + 1} / ${state.exercises.length}`;
    renderNav();
    updateButtons();
  }

  function gradeCurrent() {
    const exercise = currentExercise();
    const answer = currentAnswer().trim();
    if (!exercise || !answer || state.pending.has(exercise.id) || state.results[exercise.id]) return;
    state.pending.add(exercise.id);
    setStatus(`正在批改第 ${state.activeIndex + 1} 题…`);
    render();
    vscode.postMessage({
      type: 'gradeOne',
      exerciseId: exercise.id,
      generationId: state.generationId,
      answer,
      hintsUsed: Number(state.hintsUsed[exercise.id]) || 0,
    });
  }

  els.btnHint.addEventListener('click', () => {
    const exercise = currentExercise();
    if (!exercise) return;
    const max = Array.isArray(exercise.hints) ? exercise.hints.length : 0;
    state.hintsUsed[exercise.id] = Math.min(max, (Number(state.hintsUsed[exercise.id]) || 0) + 1);
    saveDraft();
    render();
  });
  els.btnGradeOne.addEventListener('click', gradeCurrent);
  els.btnPrev.addEventListener('click', () => { state.activeIndex = Math.max(0, state.activeIndex - 1); render(); });
  els.btnNext.addEventListener('click', () => { state.activeIndex = Math.min(state.exercises.length - 1, state.activeIndex + 1); render(); });
  els.btnOpenMarkdown.addEventListener('click', () => vscode.postMessage({ type: 'openMarkdown' }));
  els.btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  els.btnGradeMany.addEventListener('click', () => {
    const answers = state.exercises
      .map((exercise) => ({
        exerciseId: exercise.id,
        answer: String(state.answers[exercise.id] || '').trim(),
        hintsUsed: Number(state.hintsUsed[exercise.id]) || 0,
      }))
      .filter((item) => item.answer && !state.results[item.exerciseId] && !state.pending.has(item.exerciseId));
    if (!answers.length) return;
    state.batchBusy = true;
    answers.forEach((item) => state.pending.add(item.exerciseId));
    setStatus(`正在批改 0/${answers.length}…`);
    render();
    vscode.postMessage({ type: 'gradeMany', generationId: state.generationId, answers });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'init') {
      state.args = message.args;
      state.exercises = Array.isArray(message.exercises) ? message.exercises : [];
      state.generationId = message.generationId || 'legacy';
      state.activeIndex = 0;
      const serverResults = Object.fromEntries(
        (Array.isArray(message.results) ? message.results : [])
          .filter((result) => result?.exerciseId)
          .map((result) => [result.exerciseId, result]),
      );
      state.results = serverResults;
      state.pending = new Set();
      state.batchBusy = false;
      loadDraft(serverResults);
      els.lessonTitle.textContent = state.args?.lessonTitle || '专注练习室';
      setStatus(`${state.exercises.length} 道题 · 草稿自动保存`);
      render();
      return;
    }
    if (message.type === 'gradeStarted') {
      state.pending.add(message.exerciseId);
      render();
      return;
    }
    if (message.type === 'gradeProgress') {
      setStatus(`正在批改 ${message.current}/${message.total}…`);
      return;
    }
    if (message.type === 'gradeResult') {
      state.pending.delete(message.result.exerciseId);
      state.results[message.result.exerciseId] = message.result;
      saveDraft();
      setStatus(`第 ${Math.max(1, state.exercises.findIndex((item) => item.id === message.result.exerciseId) + 1)} 题批改完成 · ${message.result.score}/100`);
      render();
      return;
    }
    if (message.type === 'gradeFailed') {
      state.pending.delete(message.exerciseId);
      setStatus(`批改失败：${message.message || '未知错误'}`, 'error');
      render();
      return;
    }
    if (message.type === 'gradeComplete') {
      state.batchBusy = false;
      state.pending.clear();
      setStatus(`本轮完成 ${message.succeeded}/${message.total} · 平均 ${message.averageScore}`);
      render();
      return;
    }
    if (message.type === 'error') {
      state.batchBusy = false;
      state.pending.clear();
      setStatus(`操作失败：${message.message || '未知错误'}`, 'error');
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
