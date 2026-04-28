// 备考工作台 webview 控制器。
// 与后端 ExamWebviewProvider 通信，负责 5 区块的渲染 + 图片上传交互（粘贴/拖拽/文件选择）。
// IIFE 完整封装，避免污染全局。

(function () {
  'use strict';

  // @ts-ignore
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: () => {} };

  // ===== state =====
  const state = {
    sessionId: null,
    session: null,
    pendingImages: [], // [{ name, mimeType, base64 }]
    visionFallback: false,
  };

  // ===== DOM helpers =====
  const $ = (id) => document.getElementById(id);
  const els = {
    examName: $('exam-name'),
    examDaysTo: $('exam-days-to'),
    examSubject: $('exam-subject'),
    examStatus: $('exam-status'),

    paperAnalysesList: $('paper-analyses-list'),
    btnAnalyzePaper: $('btn-analyze-paper'),
    knowledgeHeatmap: $('knowledge-heatmap'),
    heatmapBars: $('heatmap-bars'),

    variantCount: $('variant-count'),
    variantFocus: $('variant-focus'),
    btnGenerateVariants: $('btn-generate-variants'),
    variantSetsList: $('variant-sets-list'),

    submissionVariantSet: $('submission-variant-set'),
    dropzone: $('image-dropzone'),
    btnPickImage: $('btn-pick-image'),
    fileInput: $('file-input'),
    imageThumbs: $('image-thumbs'),
    btnGradeSubmission: $('btn-grade-submission'),
    btnClearImages: $('btn-clear-images'),
    visionFallback: $('vision-fallback'),
    btnSwitchToText: $('btn-switch-to-text'),
    textFallbackModal: $('text-fallback-modal'),
    textFallbackTextarea: $('text-fallback-textarea'),
    btnSubmitTextAnswers: $('btn-submit-text-answers'),
    btnCancelTextFallback: $('btn-cancel-text-fallback'),
    btnCancelTextFallback2: $('btn-cancel-text-fallback-2'),

    submissionsTbody: $('submissions-tbody'),

    readyScoreBig: $('ready-score-big'),
    readinessComponents: $('readiness-components'),
    rcExam: $('rc-exam'),
    rcWrong: $('rc-wrong'),
    rcCoverage: $('rc-coverage'),
    rcPlan: $('rc-plan'),
    rbMastered: $('rb-mastered'),
    rbWobbly: $('rb-wobbly'),
    rbUntouched: $('rb-untouched'),
    btnRecomputeReadiness: $('btn-recompute-readiness'),
    preExamChecklist: $('pre-exam-checklist'),
    checklistItems: $('checklist-items'),

    paperPickerModal: $('paper-picker-modal'),
    paperPickerList: $('paper-picker-list'),
    btnClosePaperPicker: $('btn-close-paper-picker'),
    btnCancelPaperPicker: $('btn-cancel-paper-picker'),

    loadingBanner: $('loading-banner'),
    loadingText: $('loading-text'),
    examLog: $('exam-log'),
  };

  // ===== utils =====
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let md = null;
  if (typeof window.markdownit === 'function') {
    md = window.markdownit({
      html: false,
      breaks: true,
      linkify: true,
      typographer: false,
      highlight: (str, lang) => {
        if (typeof window.hljs !== 'undefined' && window.hljs) {
          try {
            if (lang && window.hljs.getLanguage(lang)) {
              const out = window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
              return `<pre class="hljs"><code class="hljs language-${lang}">${out}</code></pre>`;
            }
            const auto = window.hljs.highlightAuto(str);
            return `<pre class="hljs"><code class="hljs language-${auto.language || 'text'}">${auto.value}</code></pre>`;
          } catch (err) { /* fallthrough */ }
        }
        return '';
      },
    });
  }
  function renderMarkdown(text) {
    if (md) {
      try { return md.render(String(text || '')); }
      catch (err) { console.warn('md render fail', err); }
    }
    // fallback：极简 markdown 渲染
    return String(text || '').split(/\n+/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      return `<p>${escapeHtml(trimmed)}</p>`;
    }).join('');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('zh-CN'); }
    catch { return iso; }
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    } catch { return iso; }
  }

  function daysBetween(target) {
    if (!target) return null;
    const t = new Date(target).getTime();
    if (Number.isNaN(t)) return null;
    const diff = Math.ceil((t - Date.now()) / (1000 * 60 * 60 * 24));
    return diff;
  }

  function addLog(message, level = 'info') {
    if (!els.examLog) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    els.examLog.prepend(entry);
    while (els.examLog.children.length > 30) {
      els.examLog.removeChild(els.examLog.lastChild);
    }
  }

  function setLoading(active, task) {
    if (!els.loadingBanner) return;
    if (active) {
      els.loadingText.textContent = task || '处理中…';
      els.loadingBanner.classList.remove('hidden');
    } else {
      els.loadingBanner.classList.add('hidden');
    }
  }

  // ===== 渲染：session 头部 =====
  function renderHeader() {
    const s = state.session;
    if (!s) {
      els.examName.textContent = '🎯 备考会话：—';
      els.examDaysTo.textContent = '';
      els.examSubject.textContent = '';
      els.examStatus.textContent = '';
      return;
    }
    els.examName.textContent = `🎯 备考会话：${s.name || s.id}`;
    if (s.examDate) {
      const days = daysBetween(s.examDate);
      els.examDaysTo.textContent = days != null
        ? (days >= 0 ? `距考 ${days} 天` : `已过考 ${Math.abs(days)} 天`)
        : `考期：${formatDate(s.examDate)}`;
      els.examDaysTo.classList.toggle('warn', days != null && days <= 7 && days >= 0);
      els.examDaysTo.classList.toggle('danger', days != null && days < 0);
    } else {
      els.examDaysTo.textContent = '未设考期';
    }
    els.examSubject.textContent = `课程：${s.subject || '—'}`;
    els.examStatus.textContent = s.status === 'archived' ? '已归档' : '进行中';
    els.examStatus.classList.toggle('archived', s.status === 'archived');
  }

  // ===== 渲染：真题分析 =====
  function renderPaperAnalyses() {
    const s = state.session;
    const analyses = (s && s.paperAnalyses) || [];

    if (!analyses.length) {
      els.paperAnalysesList.innerHTML = '<p class="muted">尚未分析任何真题。点击下方按钮上传/分析真题。</p>';
      els.knowledgeHeatmap.classList.add('hidden');
      return;
    }

    els.paperAnalysesList.innerHTML = analyses.map((a, idx) => {
      const sectionsCount = (a.sections || []).reduce((sum, sec) => sum + (sec.questions || []).length, 0);
      const topPoints = Object.entries(a.knowledgeFrequency || {})
        .sort((p, q) => q[1] - p[1])
        .slice(0, 5)
        .map(([k, v]) => `<span class="kpoint">${escapeHtml(k)} ×${v}</span>`)
        .join('');
      return `
        <div class="paper-analysis-card">
          <div class="pa-head">
            <span class="pa-num">第 ${idx + 1} 份</span>
            <span class="pa-name">${escapeHtml(a.paperFileName || a.paperId)}</span>
            <span class="pa-meta">${sectionsCount} 题 · ${formatDate(a.parsedAt)}</span>
          </div>
          ${a.toneAndDifficulty ? `<div class="pa-tone">${escapeHtml(a.toneAndDifficulty)}</div>` : ''}
          ${topPoints ? `<div class="pa-points">${topPoints}</div>` : ''}
        </div>
      `;
    }).join('');

    // 渲染热力图（合并所有分析的考点频率）
    const merged = {};
    analyses.forEach((a) => {
      Object.entries(a.knowledgeFrequency || {}).forEach(([k, v]) => {
        merged[k] = (merged[k] || 0) + Number(v || 0);
      });
    });
    const points = Object.entries(merged).sort((p, q) => q[1] - p[1]).slice(0, 12);
    if (points.length === 0) {
      els.knowledgeHeatmap.classList.add('hidden');
      return;
    }
    const maxFreq = points[0][1] || 1;
    els.heatmapBars.innerHTML = points.map(([k, v]) => {
      const pct = Math.max(8, Math.round((v / maxFreq) * 100));
      const intensity = Math.round((v / maxFreq) * 100);
      return `
        <div class="hb-row">
          <span class="hb-label">${escapeHtml(k)}</span>
          <div class="hb-track"><div class="hb-fill" style="width:${pct}%; opacity:${0.4 + intensity / 200}"></div></div>
          <span class="hb-count">${v}</span>
        </div>
      `;
    }).join('');
    els.knowledgeHeatmap.classList.remove('hidden');
  }

  // ===== 渲染：变体题集列表 =====
  function renderVariantSets() {
    const s = state.session;
    const sets = (s && s.variantSets) || [];

    // 同步 submission 关联下拉
    const opts = ['<option value="">— 直接答真题 —</option>'].concat(
      sets.map((vs, idx) => `<option value="${escapeHtml(vs.id)}">第 ${idx + 1} 套（${vs.questions?.length || vs.count || 0} 题，${focusModeLabel(vs.focusMode)}）</option>`)
    );
    if (els.submissionVariantSet) {
      const currentValue = els.submissionVariantSet.value;
      els.submissionVariantSet.innerHTML = opts.join('');
      if (currentValue && sets.some((vs) => vs.id === currentValue)) {
        els.submissionVariantSet.value = currentValue;
      }
    }

    if (!sets.length) {
      els.variantSetsList.innerHTML = '<p class="muted">尚无变体题集。先上传真题并分析，再选择策略生成变体。</p>';
      return;
    }

    els.variantSetsList.innerHTML = sets.map((vs, idx) => {
      const qCount = (vs.questions || []).length || vs.count || 0;
      return `
        <div class="variant-set-card" data-vset-id="${escapeHtml(vs.id)}">
          <div class="vs-head">
            <span class="vs-num">第 ${idx + 1} 套</span>
            <span class="vs-meta">${qCount} 题 · ${focusModeLabel(vs.focusMode)} · ${formatDate(vs.generatedAt)}</span>
          </div>
          <div class="vs-actions">
            <button class="btn small" type="button" data-vs-action="preview" data-vset-id="${escapeHtml(vs.id)}">📄 预览/导出 PDF</button>
          </div>
        </div>
      `;
    }).join('');

    els.variantSetsList.querySelectorAll('[data-vs-action="preview"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vsetId = btn.getAttribute('data-vset-id');
        if (!vsetId) return;
        vscode.postMessage({
          type: 'exportExamVariantsPdf',
          sessionId: state.sessionId,
          variantSetId: vsetId,
        });
      });
    });
  }

  function focusModeLabel(mode) {
    if (mode === 'cover-all') return '覆盖全卷';
    if (mode === 'mock-full') return '模考整套';
    return '强化弱项';
  }

  // ===== 渲染：图片缩略图 =====
  function renderThumbs() {
    if (!els.imageThumbs) return;
    if (!state.pendingImages.length) {
      els.imageThumbs.innerHTML = '';
      els.btnGradeSubmission.disabled = true;
      return;
    }
    els.imageThumbs.innerHTML = state.pendingImages.map((img, idx) => {
      const dataUrl = `data:${escapeHtml(img.mimeType || 'image/png')};base64,${img.base64}`;
      return `
        <div class="thumb" data-idx="${idx}">
          <img src="${dataUrl}" alt="${escapeHtml(img.name || `image-${idx + 1}`)}" />
          <button type="button" class="thumb-remove" data-idx="${idx}" title="移除">×</button>
          <div class="thumb-name">${escapeHtml(img.name || `image-${idx + 1}`)}</div>
        </div>
      `;
    }).join('');
    els.imageThumbs.querySelectorAll('.thumb-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-idx'));
        if (Number.isInteger(idx)) {
          state.pendingImages.splice(idx, 1);
          renderThumbs();
        }
      });
    });
    els.btnGradeSubmission.disabled = false;
  }

  // ===== 渲染：历次提交 =====
  function renderSubmissions() {
    const s = state.session;
    const subs = ((s && s.submissions) || []).slice().sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));

    if (!subs.length) {
      els.submissionsTbody.innerHTML = '<tr class="empty-row"><td colspan="5">尚无提交。</td></tr>';
      return;
    }

    els.submissionsTbody.innerHTML = subs.map((sub) => {
      const grading = sub.gradingResult;
      const score = grading ? `${grading.overall.totalScore}/${grading.overall.maxScore} (${grading.overall.percentage}%)` : '—';
      const weaknesses = (grading?.overall?.weaknesses || []).slice(0, 3).map(escapeHtml).join('、') || '—';
      const vsetLabel = sub.variantSetId ? findVariantSetLabel(sub.variantSetId) : '直接答真题';
      const mode = sub.textAnswers && sub.textAnswers.length ? '📝 文字' : `🖼 ${(sub.imagePaths || []).length}张图`;
      return `
        <tr>
          <td>${formatDateTime(sub.uploadedAt)}</td>
          <td>${escapeHtml(vsetLabel)} · ${mode}</td>
          <td class="score-cell">${score}</td>
          <td>${weaknesses}</td>
          <td><button class="btn small ghost" type="button" data-sub-id="${escapeHtml(sub.id)}" data-sub-action="detail">详情</button></td>
        </tr>
      `;
    }).join('');
  }

  function findVariantSetLabel(vsetId) {
    const sets = (state.session && state.session.variantSets) || [];
    const idx = sets.findIndex((vs) => vs.id === vsetId);
    if (idx < 0) return vsetId;
    return `第 ${idx + 1} 套`;
  }

  // ===== 渲染：综合就绪度 =====
  function renderReadiness() {
    const s = state.session;
    const r = s && s.latestReadiness;
    if (!r) {
      els.readyScoreBig.textContent = '— / 100';
      els.readinessComponents.classList.add('hidden');
      els.rbMastered.innerHTML = '<li class="muted">点击 ↻ 让 AI 综合诊断。</li>';
      els.rbWobbly.innerHTML = '';
      els.rbUntouched.innerHTML = '';
      els.preExamChecklist.classList.add('hidden');
      return;
    }

    els.readyScoreBig.textContent = `${r.readyScore} / 100`;
    const c = r.components || {};
    els.rcExam.textContent = `${c.examScoreComponent || 0}/40`;
    els.rcWrong.textContent = `${c.wrongQuestionComponent || 0}/30`;
    els.rcCoverage.textContent = `${c.coverageComponent || 0}/20`;
    els.rcPlan.textContent = `${c.planAdherenceComponent || 0}/10`;
    els.readinessComponents.classList.remove('hidden');

    const status = (r.knowledgeStatus || []);
    const mastered = status.filter((k) => k.status === 'mastered');
    const wobbly = status.filter((k) => k.status === 'wobbly');
    const untouched = status.filter((k) => k.status === 'untouched');

    const fmtItem = (k) => `<li><span class="kp-name">${escapeHtml(k.point)}</span>${k.evidence ? `<span class="kp-evidence">${escapeHtml(k.evidence)}</span>` : ''}</li>`;

    els.rbMastered.innerHTML = mastered.length ? mastered.map(fmtItem).join('') : '<li class="muted">—</li>';
    els.rbWobbly.innerHTML = wobbly.length ? wobbly.map(fmtItem).join('') : '<li class="muted">—</li>';
    els.rbUntouched.innerHTML = untouched.length ? untouched.map(fmtItem).join('') : '<li class="muted">—</li>';

    const checklist = r.preExamChecklist || [];
    if (checklist.length) {
      els.checklistItems.innerHTML = checklist.map((c) => `<li>${escapeHtml(c)}</li>`).join('');
      els.preExamChecklist.classList.remove('hidden');
    } else {
      els.preExamChecklist.classList.add('hidden');
    }
  }

  // ===== 图片上传：3 种方式 =====
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function addFiles(fileList) {
    if (!fileList || !fileList.length) return;
    let added = 0;
    for (const file of fileList) {
      if (!file || !(file instanceof Blob)) continue;
      if (file.type && !file.type.startsWith('image/')) continue;
      try {
        const base64 = await blobToBase64(file);
        const name = (file && file.name) || `paste-${Date.now()}-${added}.png`;
        state.pendingImages.push({
          name,
          mimeType: file.type || 'image/png',
          base64,
        });
        added++;
      } catch (err) {
        console.warn('blobToBase64 fail', err);
      }
    }
    if (added) {
      renderThumbs();
      addLog(`已添加 ${added} 张图片，共 ${state.pendingImages.length} 张待批改。`, 'info');
    }
  }

  // 1. 文件按钮
  els.btnPickImage?.addEventListener('click', (e) => {
    e.stopPropagation();
    els.fileInput?.click();
  });
  els.fileInput?.addEventListener('change', (e) => {
    addFiles(e.target.files);
    // 清空 input value，防止再次选同一文件不触发 change
    e.target.value = '';
  });

  // 2. 粘贴
  document.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const items = e.clipboardData.items || [];
    const blobs = [];
    for (const item of items) {
      if (item.kind === 'file' && (item.type || '').startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) blobs.push(blob);
      }
    }
    if (blobs.length) {
      e.preventDefault();
      addFiles(blobs);
    }
  });

  // 3. 拖拽
  if (els.dropzone) {
    els.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.dropzone.classList.add('dragging');
    });
    els.dropzone.addEventListener('dragleave', () => {
      els.dropzone.classList.remove('dragging');
    });
    els.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('dragging');
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      addFiles(files);
    });
    // 全局也拦截一下，防止浏览器把图片拖进来直接打开
    window.addEventListener('dragover', (e) => { if (e.target.closest('#image-dropzone')) e.preventDefault(); });
  }

  // 清空
  els.btnClearImages?.addEventListener('click', () => {
    state.pendingImages = [];
    renderThumbs();
  });

  // 提交批改
  els.btnGradeSubmission?.addEventListener('click', () => {
    if (!state.sessionId) {
      addLog('未加载备考会话。', 'error');
      return;
    }
    if (!state.pendingImages.length) {
      addLog('请先添加图片。', 'warn');
      return;
    }
    vscode.postMessage({
      type: 'uploadExamSubmissionImages',
      sessionId: state.sessionId,
      variantSetId: els.submissionVariantSet?.value || undefined,
      images: state.pendingImages.slice(),
    });
    addLog(`正在上传 ${state.pendingImages.length} 张截图…`, 'info');
  });

  // ===== vision fallback：文字答题 =====
  els.btnSwitchToText?.addEventListener('click', () => {
    if (!els.textFallbackModal) return;
    els.textFallbackModal.classList.remove('hidden');
    els.textFallbackModal.setAttribute('aria-hidden', 'false');
    els.textFallbackTextarea?.focus();
  });

  function closeTextFallback() {
    els.textFallbackModal?.classList.add('hidden');
    els.textFallbackModal?.setAttribute('aria-hidden', 'true');
  }
  els.btnCancelTextFallback?.addEventListener('click', closeTextFallback);
  els.btnCancelTextFallback2?.addEventListener('click', closeTextFallback);
  els.textFallbackModal?.addEventListener('click', (e) => {
    if (e.target === els.textFallbackModal) closeTextFallback();
  });

  els.btnSubmitTextAnswers?.addEventListener('click', () => {
    const raw = (els.textFallbackTextarea?.value || '').trim();
    if (!raw) { addLog('请先输入答案。', 'warn'); return; }
    const answers = parseTextAnswers(raw);
    if (!answers.length) {
      addLog('未能解析出题号。请按 "## 第 N 题" 格式输入。', 'warn');
      return;
    }
    vscode.postMessage({
      type: 'submitExamTextAnswers',
      sessionId: state.sessionId,
      variantSetId: els.submissionVariantSet?.value || undefined,
      answers,
    });
    addLog(`已提交 ${answers.length} 题文字答案，正在批改…`, 'info');
    closeTextFallback();
  });

  function parseTextAnswers(raw) {
    const lines = raw.split(/\r?\n/);
    const out = [];
    let current = null;
    const headerRe = /^##\s*第\s*([\w.()（）]+)\s*题/;
    const altRe = /^##\s*([\w.()（）]+)/;
    for (const line of lines) {
      const m = headerRe.exec(line) || altRe.exec(line);
      if (m) {
        if (current) out.push(current);
        current = { questionNumber: m[1], answer: '' };
      } else if (current) {
        current.answer += (current.answer ? '\n' : '') + line;
      }
    }
    if (current) out.push(current);
    return out
      .map((it) => ({ questionNumber: String(it.questionNumber).trim(), answer: String(it.answer).trim() }))
      .filter((it) => it.questionNumber && it.answer);
  }

  // ===== 真题分析按钮 =====
  els.btnAnalyzePaper?.addEventListener('click', () => {
    if (!state.sessionId) return;
    vscode.postMessage({ type: 'getCourseExamPapers' });
    if (els.paperPickerList) {
      els.paperPickerList.innerHTML = '<p class="muted">加载中…</p>';
    }
    els.paperPickerModal?.classList.remove('hidden');
    els.paperPickerModal?.setAttribute('aria-hidden', 'false');
  });

  function closePaperPicker() {
    els.paperPickerModal?.classList.add('hidden');
    els.paperPickerModal?.setAttribute('aria-hidden', 'true');
  }
  els.btnClosePaperPicker?.addEventListener('click', closePaperPicker);
  els.btnCancelPaperPicker?.addEventListener('click', closePaperPicker);
  els.paperPickerModal?.addEventListener('click', (e) => {
    if (e.target === els.paperPickerModal) closePaperPicker();
  });

  function renderPaperPicker(payload) {
    const examPapers = payload?.examPapers || [];
    const others = payload?.others || [];
    const all = examPapers.concat(others);
    if (!all.length) {
      els.paperPickerList.innerHTML = '<p class="muted">当前课程下还没有任何资料。请先在主面板"课程资料"导入真题/模拟卷。</p>';
      return;
    }
    const renderRow = (m, isExam) => `
      <button class="selection-item paper-row" type="button" data-paper-id="${escapeHtml(m.id)}">
        <div>
          <div class="ct-label">${escapeHtml(m.fileName || m.id)}${isExam ? ' <span class="exam-tag">真题</span>' : ''}</div>
          <div class="ct-desc">${escapeHtml(m.materialType || '其他')} · ${escapeHtml(m.status || '')}</div>
        </div>
      </button>
    `;
    let html = '';
    if (examPapers.length) {
      html += '<h4 class="picker-group">📋 真题/模拟卷</h4>';
      html += examPapers.map((m) => renderRow(m, true)).join('');
    }
    if (others.length) {
      html += '<h4 class="picker-group">其他资料（兜底）</h4>';
      html += others.map((m) => renderRow(m, false)).join('');
    }
    els.paperPickerList.innerHTML = html;
    els.paperPickerList.querySelectorAll('.paper-row').forEach((row) => {
      row.addEventListener('click', () => {
        const pid = row.getAttribute('data-paper-id');
        if (!pid) return;
        vscode.postMessage({
          type: 'analyzeExamPaper',
          sessionId: state.sessionId,
          paperId: pid,
        });
        addLog(`已请求分析真题 ${pid}…`, 'info');
        closePaperPicker();
      });
    });
  }

  // ===== 变体出题 =====
  els.btnGenerateVariants?.addEventListener('click', () => {
    if (!state.sessionId) return;
    const count = Number(els.variantCount?.value || 10);
    const focusMode = els.variantFocus?.value || 'reinforce-weakness';
    vscode.postMessage({
      type: 'generateExamVariants',
      sessionId: state.sessionId,
      count,
      focusMode,
    });
    addLog(`正在生成 ${count} 题变体（${focusModeLabel(focusMode)}）…`, 'info');
  });

  // ===== 重新分析就绪度 =====
  els.btnRecomputeReadiness?.addEventListener('click', () => {
    if (!state.sessionId) return;
    vscode.postMessage({ type: 'recomputeExamReadiness', sessionId: state.sessionId });
    addLog('正在重新分析就绪度…', 'info');
  });

  // ===== 接收后端消息 =====
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'init':
        state.sessionId = msg.sessionId || null;
        break;

      case 'examSession':
        state.session = msg.data || null;
        renderHeader();
        renderPaperAnalyses();
        renderVariantSets();
        renderSubmissions();
        renderReadiness();
        break;

      case 'examPaperAnalyzed':
        addLog(`真题分析完成：${msg.analysis?.paperFileName || msg.analysis?.paperId || ''}`, 'info');
        // session 数据由后端通过 examSession 推过来
        break;

      case 'examVariantsGenerated':
        addLog(`变体题生成完成：${msg.variantSet?.questions?.length || msg.variantSet?.count || 0} 题`, 'info');
        // 同上
        break;

      case 'examSubmissionUploaded':
        addLog(`已上传 ${(msg.submission?.imagePaths || []).length} 张截图，正在提交批改…`, 'info');
        // 自动触发批改
        if (msg.submission?.id && !msg.submission.textAnswers) {
          vscode.postMessage({
            type: 'gradeExamSubmission',
            sessionId: msg.sessionId || state.sessionId,
            submissionId: msg.submission.id,
          });
        }
        // 清空 pending
        state.pendingImages = [];
        renderThumbs();
        break;

      case 'examSubmissionGraded':
        addLog(`批改完成：${msg.submission?.gradingResult?.overall?.percentage ?? '—'}%`, 'info');
        break;

      case 'examReadinessUpdated':
        addLog('就绪度已更新。', 'info');
        // 数据通过 examSession 推送
        break;

      case 'examVisionUnsupported': {
        state.visionFallback = true;
        if (els.visionFallback) {
          els.visionFallback.classList.remove('hidden');
          const warn = els.visionFallback.querySelector('.warn-text');
          if (warn) {
            const suggested = (msg.suggestedModels || []).join(' / ') || 'gpt-4o / claude-3.5-sonnet';
            warn.textContent = `当前模型 "${msg.modelName || '未知'}" 不支持图片输入。建议切换到 ${suggested}，或：`;
          }
        }
        addLog('当前 AI 配置不支持视觉，已切换到文字 fallback。', 'warn');
        break;
      }

      case 'courseExamPapers':
        renderPaperPicker(msg.data || {});
        break;

      case 'loading':
        setLoading(!!msg.active, msg.task);
        break;

      case 'log':
        addLog(msg.message || '', msg.level || 'info');
        break;

      case 'error':
        addLog(msg.message || '未知错误', 'error');
        setLoading(false);
        break;

      default:
        break;
    }
  });

  // ===== 启动 =====
  renderHeader();
  renderPaperAnalyses();
  renderVariantSets();
  renderThumbs();
  renderSubmissions();
  renderReadiness();
  // 主动拉一次（防 init 错过）
  vscode.postMessage({ type: 'getExamSession' });

  // Ctrl+滚轮 整体缩放
  let _examFontScale = 1;
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    _examFontScale = Math.max(0.7, Math.min(2.0, _examFontScale + delta));
    document.body.style.zoom = String(_examFontScale);
  }, { passive: false });
})();
