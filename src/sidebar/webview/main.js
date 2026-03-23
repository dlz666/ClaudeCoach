(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  const SUBJECT_LABELS = {
    calculus: '微积分',
    'linear-algebra': '线性代数',
    'discrete-math': '离散数学',
    react: 'React',
    programming: '编程基础',
  };

  const state = {
    courses: [],
    materials: { materials: [] },
    preferences: null,
    diagnosis: null,
    selectedSubject: saved.selectedSubject || null,
    selectedCourseMaterialId: saved.selectedCourseMaterialId || null,
    currentCourseMaterialPreview: null,
    chatGroundingMode: saved.chatGroundingMode || 'course',
    chatMessages: Array.isArray(saved.chatMessages) ? saved.chatMessages.slice() : [],
    activeTaskKeys: new Set(),
    aiConfigCenterCollapsed: !!saved.aiConfigCenterCollapsed,
    resolvedAIConfig: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: Array.from(document.querySelectorAll('.tab')),
    tabContents: Array.from(document.querySelectorAll('.tab-content')),
    ddTrigger: $('course-dropdown-trigger'),
    ddMenu: $('course-dropdown-menu'),
    ddLabel: $('course-dropdown-label'),
    subjectSelect: $('subject-select'),
    subjectInput: $('subject-input'),
    newCoursePanel: $('new-course-panel'),
    btnGenerateCourse: $('btn-generate-course'),
    btnRefreshCourses: $('btn-refresh-courses'),
    courseTitleRow: $('course-title-row'),
    courseTitleText: $('course-title-text'),
    btnEditCourseTitle: $('btn-edit-course-title'),
    editMenu: $('course-edit-menu'),
    editMenuItems: Array.from(document.querySelectorAll('#course-edit-menu [data-action]')),
    courseTree: $('course-tree'),
    courseMaterialsSection: $('course-materials-section'),
    btnImportCourseMaterial: $('btn-import-course-material'),
    courseMaterialsList: $('course-materials-list'),
    courseMaterialPreview: $('course-material-preview'),
    courseMaterialPreviewTitle: $('course-material-preview-title'),
    courseMaterialPreviewSource: $('course-material-preview-source'),
    courseMaterialPreviewBody: $('course-material-preview-body'),
    btnDiagnosis: $('btn-diagnosis'),
    diagnosisSummary: $('diagnosis-summary'),
    chatInput: $('chat-input'),
    chatMessages: $('chat-messages'),
    chatModeButtons: Array.from(document.querySelectorAll('.chat-mode-btn')),
    chatContextStatus: $('chat-context-status'),
    btnChatSend: $('btn-chat-send'),
    btnChatRebuildOutline: $('btn-chat-rebuild-outline'),
    materialSubject: $('material-subject'),
    btnImport: $('btn-import'),
    materialsList: $('materials-list'),
    btnSavePrefs: $('btn-save-prefs'),
    btnOpenDataDir: $('btn-open-data-dir'),
    logList: $('log-list'),
    taskList: $('task-list'),
    dataDirPath: $('data-dir-path'),
    aiConfigCenter: $('ai-config-center'),
    aiConfigCenterToggle: $('btn-toggle-ai-config-center'),
    aiConfigCenterToggleLabel: document.querySelector('#btn-toggle-ai-config-center .collapse-toggle-label'),
    resolvedConfigSource: $('resolved-config-source'),
    resolvedWarningPills: $('resolved-warning-pills'),
    resolvedConfigName: $('resolved-config-name'),
    resolvedConfigMeta: $('resolved-config-meta'),
    resolvedConfigUrl: $('resolved-config-url'),
    resolvedConfigContext: $('resolved-config-context'),
    resolvedConfigMaxTokens: $('resolved-config-max-tokens'),
    resolvedConfigHistoryBudget: $('resolved-config-history-budget'),
    prefDifficulty: $('pref-difficulty'),
    mixEasy: $('mix-easy'),
    mixMedium: $('mix-medium'),
    mixHard: $('mix-hard'),
    prefExercises: $('pref-exercises'),
    prefSpeed: $('pref-speed'),
    prefReview: $('pref-review'),
    prefLangContent: $('pref-lang-content'),
    prefLangCode: $('pref-lang-code'),
  };

  function subjectLabel(subject) {
    return SUBJECT_LABELS[subject] || subject || '未命名课程';
  }

  function hasCourse(subject) {
    return !!subject && state.courses.some((course) => course.subject === subject);
  }

  function getCourse(subject) {
    return state.courses.find((course) => course.subject === subject) || null;
  }

  function persist() {
    vscode.setState({
      selectedSubject: state.selectedSubject,
      selectedCourseMaterialId: state.selectedCourseMaterialId,
      chatGroundingMode: state.chatGroundingMode,
      chatMessages: state.chatMessages,
      aiConfigCenterCollapsed: state.aiConfigCenterCollapsed,
    });
  }

  function refreshCoursePanelData(showLog = false) {
    vscode.postMessage({ type: 'getCourses' });
    vscode.postMessage({ type: 'getMaterials' });
    if (state.selectedCourseMaterialId) {
      vscode.postMessage({ type: 'previewMaterial', materialId: state.selectedCourseMaterialId });
    }
    if (showLog) {
      addLog('已刷新课程文件与状态。', 'info');
    }
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    return String(text || '')
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (/^#{1,4}\s/.test(trimmed)) {
          return `<p><strong>${escapeHtml(trimmed.replace(/^#+\s*/, ''))}</strong></p>`;
        }
        if (/^[-*]\s/.test(trimmed)) {
          return `<li>${escapeHtml(trimmed.slice(2))}</li>`;
        }
        return `<p>${escapeHtml(trimmed)}</p>`;
      })
      .join('')
      .replace(/(<li>.*?<\/li>)+/g, (match) => `<ul>${match}</ul>`);
  }

  function addLog(message, level = 'info') {
    if (!els.logList) return;
    const muted = els.logList.querySelector('.muted');
    if (muted) {
      els.logList.innerHTML = '';
    }
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    els.logList.prepend(entry);
  }

  function addTask(id, name) {
    if (!els.taskList || $(`task-${id}`)) return;
    const item = document.createElement('div');
    item.className = 'task-item';
    item.id = `task-${id}`;
    item.innerHTML = '<div class="spinner-small"></div><span></span>';
    item.querySelector('span').textContent = name;
    els.taskList.appendChild(item);
  }

  function removeTask(id) {
    $(`task-${id}`)?.remove();
  }

  function updateTaskBlockedState() {
    const busy = state.activeTaskKeys.size > 0 || !!$('task-legacy');
    [
      els.btnGenerateCourse,
      els.btnDiagnosis,
      els.btnImport,
      els.btnImportCourseMaterial,
      els.btnChatRebuildOutline,
      els.btnChatSend,
      els.btnSavePrefs,
    ].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      button.classList.toggle('is-busy', busy);
    });
  }

  function appendChat(role, content, save = true) {
    if (!els.chatMessages) return;
    const el = document.createElement('div');
    el.className = `chat-msg ${role}`;
    if (role === 'assistant') {
      el.innerHTML = renderMarkdown(content);
    } else {
      el.textContent = content;
    }
    els.chatMessages.appendChild(el);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

    if (save) {
      state.chatMessages.push({ role, content });
      persist();
    }
  }

  function scrollChatToBottom() {
    if (!els.chatMessages) return;

    const applyScroll = () => {
      els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    };

    applyScroll();
    requestAnimationFrame(() => {
      applyScroll();
      setTimeout(applyScroll, 0);
    });
  }

  function getDraftSubject() {
    if (!els.subjectSelect) return '';
    return els.subjectSelect.value === '__custom__'
      ? (els.subjectInput?.value || '').trim()
      : (els.subjectSelect.value || '').trim();
  }

  function setCreateCourseMode(enabled) {
    if (enabled) {
      state.selectedSubject = null;
      renderDiagnosis(null);
    }
    els.newCoursePanel?.classList.toggle('hidden', !enabled);
    renderCourseDropdown();
    renderSelectedCourse();
    renderCourseMaterials();
    renderChatContext();
    syncMaterialImportTargets();
    persist();
  }

  function renderCourseDropdown() {
    if (!els.ddLabel || !els.ddMenu) return;

    const draft = getDraftSubject();
    const showCreatePanel = !state.selectedSubject || !hasCourse(state.selectedSubject);
    const selectedCourse = getCourse(state.selectedSubject);

    if (selectedCourse) {
      els.ddLabel.textContent = subjectLabel(selectedCourse.subject);
    } else if (draft) {
      els.ddLabel.textContent = `准备创建：${subjectLabel(draft)}`;
    } else if (state.courses.length) {
      els.ddLabel.textContent = '请选择课程';
    } else {
      els.ddLabel.textContent = '暂无课程';
    }

    els.newCoursePanel?.classList.toggle('hidden', !showCreatePanel);

    const items = state.courses.map((course) => `
      <div class="dropdown-item${course.subject === state.selectedSubject ? ' selected' : ''}" data-subject="${escapeHtml(course.subject)}">
        <span>${escapeHtml(course.title || subjectLabel(course.subject))}</span>
        <span class="muted">${escapeHtml(subjectLabel(course.subject))}</span>
      </div>
    `);

    items.push(`
      <div class="dropdown-item${showCreatePanel ? ' selected' : ''}" data-action="create-course">
        <span>${state.courses.length ? '创建新课程' : '创建第一门课程'}</span>
        <span class="muted">+</span>
      </div>
    `);

    els.ddMenu.innerHTML = items.join('');

    els.ddMenu.querySelectorAll('[data-subject]').forEach((item) => {
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        state.selectedSubject = item.getAttribute('data-subject');
        els.ddMenu.classList.add('hidden');
        onCourseSelected();
      });
    });

    els.ddMenu.querySelector('[data-action="create-course"]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      els.ddMenu.classList.add('hidden');
      setCreateCourseMode(true);
    });
  }

  function closeLessonActionMenus() {
    if (!els.courseTree) return;
    els.courseTree.querySelectorAll('.lesson-menu.open').forEach((menu) => {
      menu.classList.remove('open');
      menu.querySelector('.btn-more')?.setAttribute('aria-expanded', 'false');
    });
  }

  function renderSelectedCourse() {
    if (!els.courseTree || !els.courseTitleRow || !els.courseTitleText) return;

    if (!state.selectedSubject) {
      const draft = getDraftSubject();
      els.courseTitleRow.classList.add('hidden');
      els.courseTree.innerHTML = draft
        ? `<p class="muted">当前还没有课程大纲。你正在准备创建：${escapeHtml(subjectLabel(draft))}</p>`
        : '<p class="muted">请先选择或创建课程。</p>';
      return;
    }

    const course = getCourse(state.selectedSubject);
    if (!course) {
      els.courseTitleRow.classList.add('hidden');
      els.courseTree.innerHTML = '<p class="muted">未找到当前课程。</p>';
      return;
    }

    els.courseTitleRow.classList.remove('hidden');
    els.courseTitleRow.classList.add('open');
    els.courseTitleText.textContent = course.title;
    els.courseTree.classList.remove('hidden');

    els.courseTree.innerHTML = course.topics.map((topic, topicIndex) => `
      <div class="tree-node">
        <div class="tree-topic open">${escapeHtml(formatTopicTitle(topic, topicIndex))}</div>
        <div class="tree-children">
          ${(topic.lessons || []).map((lesson) => `
            <div
              class="tree-lesson tree-lesson-open"
              role="button"
              tabindex="0"
              data-subject="${escapeHtml(course.subject)}"
              data-topic-id="${escapeHtml(topic.id)}"
              data-topic-title="${escapeHtml(topic.title)}"
              data-lesson-id="${escapeHtml(lesson.id)}"
              data-lesson-title="${escapeHtml(lesson.title)}"
              data-difficulty="${Number(lesson.difficulty) || 1}"
            >
              <span class="tree-lesson-label">
                <span class="status-dot ${lesson.status || 'not-started'}"></span>
                ${escapeHtml(lesson.title)}
              </span>
              <span class="tree-actions">
                <button
                  class="tree-btn btn-lesson"
                  data-subject="${escapeHtml(course.subject)}"
                  data-topic-id="${escapeHtml(topic.id)}"
                  data-topic-title="${escapeHtml(topic.title)}"
                  data-lesson-id="${escapeHtml(lesson.id)}"
                  data-lesson-title="${escapeHtml(lesson.title)}"
                  data-difficulty="${Number(lesson.difficulty) || 1}"
                >讲义</button>
                <button
                  class="tree-btn btn-exercise"
                  data-subject="${escapeHtml(course.subject)}"
                  data-topic-id="${escapeHtml(topic.id)}"
                  data-topic-title="${escapeHtml(topic.title)}"
                  data-lesson-id="${escapeHtml(lesson.id)}"
                  data-lesson-title="${escapeHtml(lesson.title)}"
                  data-difficulty="${Number(lesson.difficulty) || 1}"
                >练习</button>
              </span>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    els.courseTree.querySelectorAll('.tree-topic').forEach((topicEl) => {
      topicEl.addEventListener('click', () => {
        topicEl.classList.toggle('open');
        topicEl.nextElementSibling?.classList.toggle('collapsed');
      });
    });

    const openLessonFromRow = (row) => {
      const d = row.dataset;
      vscode.postMessage({
        type: 'openLessonContent',
        subject: d.subject,
        topicId: d.topicId,
        topicTitle: d.topicTitle,
        lessonId: d.lessonId,
        lessonTitle: d.lessonTitle,
      });
    };

    els.courseTree.querySelectorAll('.tree-lesson-open').forEach((row) => {
      row.addEventListener('click', () => {
        openLessonFromRow(row);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openLessonFromRow(row);
        }
      });
    });

    els.courseTree.querySelectorAll('.btn-lesson').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const d = button.dataset;
        vscode.postMessage({
          type: 'openOrGenerateLesson',
          subject: d.subject,
          topicId: d.topicId,
          topicTitle: d.topicTitle,
          lessonId: d.lessonId,
          lessonTitle: d.lessonTitle,
          difficulty: Number(d.difficulty) || 1,
        });
      });
    });

    els.courseTree.querySelectorAll('.btn-exercise').forEach((button) => {
      const wrapper = document.createElement('span');
      wrapper.className = 'lesson-menu';

      button.parentNode?.insertBefore(wrapper, button);
      wrapper.appendChild(button);

      button.classList.add('btn-more');
      button.type = 'button';
      button.textContent = '...';
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('title', '更多操作');

      const popover = document.createElement('div');
      popover.className = 'lesson-menu-popover';
      popover.setAttribute('role', 'menu');
      popover.innerHTML = `
        <button class="lesson-menu-action" type="button" role="menuitem" data-action="exercise">练习</button>
        <button class="lesson-menu-action" type="button" role="menuitem" data-action="reset">重新学习</button>
        <button class="lesson-menu-action" type="button" role="menuitem" data-action="complete">已完成</button>
      `;
      wrapper.appendChild(popover);

      wrapper.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const shouldOpen = !wrapper.classList.contains('open');
        closeLessonActionMenus();
        if (shouldOpen) {
          wrapper.classList.add('open');
          button.setAttribute('aria-expanded', 'true');
        }
      });

      popover.querySelectorAll('.lesson-menu-action').forEach((actionButton) => {
        actionButton.addEventListener('click', (event) => {
          event.stopPropagation();
          closeLessonActionMenus();

          const d = button.dataset;
          const action = actionButton.dataset.action;

          if (action === 'exercise') {
            vscode.postMessage({
              type: 'openOrGenerateExercises',
              subject: d.subject,
              topicId: d.topicId,
              topicTitle: d.topicTitle,
              lessonId: d.lessonId,
              lessonTitle: d.lessonTitle,
              count: state.preferences?.pace?.exercisesPerSession || 5,
              difficulty: Number(d.difficulty) || 1,
            });
            return;
          }

          if (action === 'reset') {
            vscode.postMessage({
              type: 'resetLessonProgress',
              subject: d.subject,
              topicId: d.topicId,
              lessonId: d.lessonId,
              lessonTitle: d.lessonTitle,
            });
            return;
          }

          if (action === 'complete') {
            vscode.postMessage({
              type: 'markLessonCompleted',
              subject: d.subject,
              topicId: d.topicId,
              lessonId: d.lessonId,
              lessonTitle: d.lessonTitle,
            });
          }
        });
      });
    });
  }

  function formatTopicTitle(topic, topicIndex) {
    const chapterNumber = Number(topic?.chapterNumber);
    const prefix = Number.isFinite(chapterNumber) && chapterNumber > 0
      ? `${chapterNumber}. `
      : `${topicIndex + 1}. `;
    return `${prefix}${topic?.title || ''}`;
  }

  function renderCourseMaterials() {
    if (!els.courseMaterialsSection || !els.courseMaterialsList || !els.courseMaterialPreview) return;

    if (!state.selectedSubject) {
      els.courseMaterialsSection.classList.add('hidden');
      els.courseMaterialPreview.classList.add('hidden');
      return;
    }

    els.courseMaterialsSection.classList.remove('hidden');
    const materials = (state.materials.materials || []).filter((item) => item.subject === state.selectedSubject);

    if (!materials.length) {
      els.courseMaterialsList.innerHTML = '<p class="muted">暂无资料，可导入 PDF、TXT、Markdown。</p>';
      els.courseMaterialPreview.classList.add('hidden');
      return;
    }

    const labels = { pending: '待处理', extracted: '已提取', indexed: '已索引' };
    els.courseMaterialsList.innerHTML = materials.map((item) => `
      <div class="material-item clickable course-material-item${item.id === state.selectedCourseMaterialId ? ' active' : ''}" data-id="${escapeHtml(item.id)}">
        <span class="material-name">${escapeHtml(item.fileName)}</span>
        <span class="material-right">
          <span class="material-status ${item.status}">${labels[item.status] || item.status}</span>
          <button class="material-delete-btn" type="button" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.fileName)}" title="删除资料" aria-label="删除资料 ${escapeHtml(item.fileName)}">删除</button>
        </span>
      </div>
    `).join('');

    els.courseMaterialsList.querySelectorAll('.course-material-item').forEach((item) => {
      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'previewMaterial', materialId: item.getAttribute('data-id') });
      });
    });

    els.courseMaterialsList.querySelectorAll('.material-delete-btn').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({
          type: 'requestDeleteMaterial',
          materialId: button.getAttribute('data-id'),
          fileName: button.getAttribute('data-name'),
        });
      });
    });

    if (state.currentCourseMaterialPreview && state.selectedCourseMaterialId) {
      els.courseMaterialPreview.classList.remove('hidden');
      els.courseMaterialPreviewTitle.textContent = state.currentCourseMaterialPreview.title || '';
      els.courseMaterialPreviewSource.textContent = state.currentCourseMaterialPreview.sourceLabel || '';
      els.courseMaterialPreviewBody.innerHTML = state.currentCourseMaterialPreview.format === 'markdown'
        ? renderMarkdown(state.currentCourseMaterialPreview.content || '')
        : `<pre>${escapeHtml(state.currentCourseMaterialPreview.content || '')}</pre>`;
    } else {
      els.courseMaterialPreview.classList.add('hidden');
    }
  }

  function renderMaterials() {
    if (!els.materialsList) return;
    const materials = state.materials.materials || [];

    if (!materials.length) {
      els.materialsList.innerHTML = '<p class="muted">暂无资料</p>';
      return;
    }

    const grouped = {};
    materials.forEach((item) => {
      grouped[item.subject] = grouped[item.subject] || [];
      grouped[item.subject].push(item);
    });

    const labels = { pending: '待处理', extracted: '已提取', indexed: '已索引' };
    els.materialsList.innerHTML = Object.entries(grouped).map(([subject, items]) => `
      <div class="material-group">
        <div class="material-group-title">${escapeHtml(subjectLabel(subject))}</div>
        ${items.map((item) => `
          <div class="material-item clickable library-material-item" data-id="${escapeHtml(item.id)}" data-subject="${escapeHtml(item.subject)}">
            <span class="material-name">${escapeHtml(item.fileName)}</span>
            <span class="material-right">
              <span class="material-status ${item.status}">${labels[item.status] || item.status}</span>
              <button class="material-delete-btn" type="button" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.fileName)}" title="删除资料" aria-label="删除资料 ${escapeHtml(item.fileName)}">删除</button>
            </span>
          </div>
        `).join('')}
      </div>
    `).join('');

    els.materialsList.querySelectorAll('.library-material-item').forEach((item) => {
      item.addEventListener('click', () => {
        state.selectedSubject = item.getAttribute('data-subject') || state.selectedSubject;
        onCourseSelected();
        activateTab('learn');
        vscode.postMessage({ type: 'previewMaterial', materialId: item.getAttribute('data-id') });
      });
    });

    els.materialsList.querySelectorAll('.material-delete-btn').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({
          type: 'requestDeleteMaterial',
          materialId: button.getAttribute('data-id'),
          fileName: button.getAttribute('data-name'),
        });
      });
    });
  }

  function renderDiagnosis(diag) {
    if (!els.diagnosisSummary) return;
    state.diagnosis = diag || null;
    const snapshots = Array.isArray(diag?.subjectSnapshots)
      ? diag.subjectSnapshots.filter((snapshot) => !state.selectedSubject || snapshot.subject === state.selectedSubject)
      : [];

    if (!diag || !snapshots.length) {
      els.diagnosisSummary.textContent = state.selectedSubject ? '当前课程暂无诊断数据' : '请先选择课程';
      return;
    }

    const nextSteps = Array.isArray(diag.nextSteps) ? diag.nextSteps : [];
    els.diagnosisSummary.innerHTML = `
      ${snapshots.map((snapshot) => `
        <div class="diagnosis-card">
          <strong>${escapeHtml(subjectLabel(snapshot.subject))}</strong>
          <div class="mastery-bar">
            <div class="mastery-fill" style="width: ${Math.max(0, Math.min(100, Number(snapshot.mastery) || 0))}%"></div>
          </div>
          <div>掌握度：${escapeHtml(String(snapshot.mastery || 0))}%</div>
          <div class="muted">推荐聚焦：${escapeHtml(snapshot.recommendedFocus || '暂无')}</div>
        </div>
      `).join('')}
      <div class="feedback-line">${escapeHtml(diag.overallStrategy || '')}</div>
      ${nextSteps.length ? `<div class="feedback-line">${nextSteps.map((step, index) => `${index + 1}. ${step}`).join(' / ')}</div>` : ''}
    `;
  }

  function requestDiagnosis(run = false) {
    if (!state.selectedSubject) {
      renderDiagnosis(null);
      if (run) {
        addLog('请先选择当前课程。', 'warn');
      }
      return;
    }

    vscode.postMessage({ type: 'getDiagnosis', subject: state.selectedSubject, run });
  }

  function syncMaterialImportTargets() {
    if (!els.materialSubject) return;

    const subjects = new Set();
    state.courses.forEach((course) => subjects.add(course.subject));
    (state.materials.materials || []).forEach((item) => subjects.add(item.subject));

    const draft = getDraftSubject();
    if (draft) {
      subjects.add(draft);
    }

    const values = Array.from(subjects).filter(Boolean);
    if (!values.length) {
      els.materialSubject.innerHTML = '<option value="">请先创建课程</option>';
      els.materialSubject.value = '';
      return;
    }

    els.materialSubject.innerHTML = values.map((subject) => `
      <option value="${escapeHtml(subject)}">${escapeHtml(subjectLabel(subject))}</option>
    `).join('');

    const preferred = state.selectedSubject || draft || values[0];
    els.materialSubject.value = values.includes(preferred) ? preferred : values[0];
  }

  function renderPreferences(preferences) {
    if (!preferences) return;
    state.preferences = preferences;

    if (els.prefDifficulty) els.prefDifficulty.value = preferences.difficulty?.global || 'basic';
    if (els.mixEasy) els.mixEasy.value = String(preferences.difficulty?.exerciseMix?.easy ?? 40);
    if (els.mixMedium) els.mixMedium.value = String(preferences.difficulty?.exerciseMix?.medium ?? 40);
    if (els.mixHard) els.mixHard.value = String(preferences.difficulty?.exerciseMix?.hard ?? 20);
    if (els.prefExercises) els.prefExercises.value = String(preferences.pace?.exercisesPerSession ?? 5);
    if (els.prefSpeed) els.prefSpeed.value = preferences.pace?.speed || 'medium';
    if (els.prefReview) els.prefReview.value = String(preferences.pace?.reviewEveryNLessons ?? 3);
    if (els.prefLangContent) els.prefLangContent.value = preferences.language?.content || 'zh';
    if (els.prefLangCode) els.prefLangCode.value = preferences.language?.codeComments || 'zh';
  }

  function collectPreferences() {
    const current = state.preferences || {};
    return {
      difficulty: {
        global: els.prefDifficulty?.value || current.difficulty?.global || 'basic',
        perSubject: current.difficulty?.perSubject || {},
        exerciseMix: {
          easy: Number(els.mixEasy?.value || current.difficulty?.exerciseMix?.easy || 40),
          medium: Number(els.mixMedium?.value || current.difficulty?.exerciseMix?.medium || 40),
          hard: Number(els.mixHard?.value || current.difficulty?.exerciseMix?.hard || 20),
        },
      },
      pace: {
        dailyGoalMinutes: current.pace?.dailyGoalMinutes || 45,
        exercisesPerSession: Number(els.prefExercises?.value || current.pace?.exercisesPerSession || 5),
        speed: els.prefSpeed?.value || current.pace?.speed || 'medium',
        reviewEveryNLessons: Number(els.prefReview?.value || current.pace?.reviewEveryNLessons || 3),
      },
      language: {
        content: els.prefLangContent?.value || current.language?.content || 'zh',
        exercises: current.language?.exercises || 'zh',
        codeComments: els.prefLangCode?.value || current.language?.codeComments || 'zh',
      },
    };
  }

  function renderChatContext() {
    if (!els.chatContextStatus) return;

    els.chatModeButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.chatMode === state.chatGroundingMode);
      if (button.dataset.chatMode === 'material') {
        button.disabled = !state.selectedCourseMaterialId;
      } else if (button.dataset.chatMode === 'course') {
        button.disabled = !state.selectedSubject;
      } else {
        button.disabled = false;
      }
    });

    if (state.chatGroundingMode === 'general') {
      els.chatContextStatus.textContent = '当前模式：普通问答，不注入课程或资料。';
    } else if (state.chatGroundingMode === 'material') {
      els.chatContextStatus.textContent = `当前模式：所选资料。当前资料：${state.currentCourseMaterialPreview?.title || '未选择资料'}`;
    } else if (state.selectedSubject) {
      els.chatContextStatus.textContent = `当前模式：当前课程。当前课程：${subjectLabel(state.selectedSubject)}`;
    } else {
      els.chatContextStatus.textContent = '当前缺少课程上下文，已自动回退为普通问答。';
    }
  }

  function renderResolvedAIConfig(config, workspaceOverride) {
    if (!els.resolvedConfigName) return;

    if (!config) {
      if (els.resolvedConfigSource) els.resolvedConfigSource.textContent = '加载中...';
      els.resolvedConfigName.textContent = '-';
      els.resolvedConfigMeta.textContent = '-';
      els.resolvedConfigUrl.textContent = '-';
      els.resolvedConfigContext.textContent = '-';
      els.resolvedConfigMaxTokens.textContent = '-';
      els.resolvedConfigHistoryBudget.textContent = '-';
      if (els.resolvedWarningPills) els.resolvedWarningPills.innerHTML = '';
      return;
    }

    if (els.resolvedConfigSource) {
      els.resolvedConfigSource.textContent = config.resolvedFrom === 'workspace' ? '当前生效：项目覆盖' : '当前生效：全局配置';
    }
    els.resolvedConfigName.textContent = config.profileName || '-';
    els.resolvedConfigMeta.textContent = `${config.provider || '-'} / ${config.model || '-'}`;
    els.resolvedConfigUrl.textContent = config.effectiveBaseUrl || config.baseUrl || '-';
    els.resolvedConfigContext.textContent = String(config.contextWindow || '-');
    els.resolvedConfigMaxTokens.textContent = String(config.maxTokens || '-');
    els.resolvedConfigHistoryBudget.textContent = String(config.availableHistoryTokens || '-');

    if (els.resolvedWarningPills) {
      const warnings = Array.isArray(config.warnings) ? config.warnings : [];
      const pills = [];
      if (workspaceOverride?.enabled) {
        pills.push('<span class="pill warn">项目覆盖中</span>');
      }
      warnings.forEach((warning) => {
        pills.push(`<span class="pill danger">${escapeHtml(warning)}</span>`);
      });
      els.resolvedWarningPills.innerHTML = pills.join('');
    }
  }

  function renderAIConfigCenterCollapsedState() {
    if (!els.aiConfigCenter || !els.aiConfigCenterToggle || !els.aiConfigCenterToggleLabel) return;
    els.aiConfigCenter.classList.toggle('collapsed', state.aiConfigCenterCollapsed);
    els.aiConfigCenterToggle.setAttribute('aria-expanded', state.aiConfigCenterCollapsed ? 'false' : 'true');
    els.aiConfigCenterToggleLabel.textContent = state.aiConfigCenterCollapsed ? '展开' : '收起';
  }

  function onCourseSelected() {
    renderCourseDropdown();
    renderSelectedCourse();
    renderCourseMaterials();
    renderMaterials();
    requestDiagnosis(false);
    renderChatContext();
    syncMaterialImportTargets();
    persist();
  }

  function activateTab(tabName) {
    els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
    els.tabContents.forEach((content) => content.classList.toggle('active', content.id === `tab-${tabName}`));
    if (tabName === 'chat') {
      scrollChatToBottom();
    }
  }

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  els.ddTrigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    els.ddMenu?.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    els.ddMenu?.classList.add('hidden');
    els.editMenu?.classList.add('hidden');
    closeLessonActionMenus();
  });

  els.subjectSelect?.addEventListener('change', (event) => {
    const isCustom = event.target.value === '__custom__';
    els.subjectInput?.classList.toggle('hidden', !isCustom);
    setCreateCourseMode(true);
  });

  els.subjectInput?.addEventListener('input', () => {
    setCreateCourseMode(true);
  });

  els.btnGenerateCourse?.addEventListener('click', () => {
    const subject = getDraftSubject();
    if (!subject) {
      addLog('请先填写课程名称。', 'warn');
      return;
    }
    vscode.postMessage({ type: 'generateCourse', subject });
  });

  els.btnRefreshCourses?.addEventListener('click', () => {
    refreshCoursePanelData(true);
  });

  els.btnDiagnosis?.addEventListener('click', () => {
    requestDiagnosis(true);
  });

  els.btnImport?.addEventListener('click', () => {
    const subject = els.materialSubject?.value || getDraftSubject();
    if (!subject) {
      addLog('请先选择课程。', 'warn');
      return;
    }
    vscode.postMessage({ type: 'importMaterial', subject });
  });

  els.btnImportCourseMaterial?.addEventListener('click', () => {
    if (!state.selectedSubject) {
      addLog('请先选择课程。', 'warn');
      return;
    }
    vscode.postMessage({ type: 'importMaterial', subject: state.selectedSubject });
  });

  els.btnChatSend?.addEventListener('click', () => {
    const text = (els.chatInput?.value || '').trim();
    if (!text) return;
    appendChat('user', text);
    els.chatInput.value = '';
    vscode.postMessage({
      type: 'chat',
      message: text,
      subject: state.chatGroundingMode === 'general' ? undefined : state.selectedSubject,
      mode: state.chatGroundingMode,
      materialId: state.chatGroundingMode === 'material' ? state.selectedCourseMaterialId : undefined,
    });
  });

  els.chatInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.btnChatSend?.click();
    }
  });

  els.btnChatRebuildOutline?.addEventListener('click', () => {
    if (!state.selectedSubject) {
      addLog('请先选择课程。', 'warn');
      return;
    }
    vscode.postMessage({
      type: 'rebuildCourseOutline',
      subject: state.selectedSubject,
      materialId: state.selectedCourseMaterialId || undefined,
    });
  });

  els.chatModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.chatGroundingMode = button.dataset.chatMode;
      renderChatContext();
      persist();
    });
  });

  els.aiConfigCenterToggle?.addEventListener('click', () => {
    state.aiConfigCenterCollapsed = !state.aiConfigCenterCollapsed;
    renderAIConfigCenterCollapsedState();
    persist();
  });

  els.btnSavePrefs?.addEventListener('click', () => {
    const preferences = collectPreferences();
    state.preferences = preferences;
    vscode.postMessage({ type: 'savePreferences', preferences });
    addLog('学习偏好已提交保存。', 'info');
  });

  els.btnOpenDataDir?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openDataDir' });
  });

  els.btnEditCourseTitle?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.selectedSubject) return;
    els.editMenu?.classList.toggle('hidden');
  });

  els.editMenuItems.forEach((item) => {
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      const course = getCourse(state.selectedSubject);
      if (!course) return;

      const action = item.getAttribute('data-action');
      if (action === 'rename-title') {
        vscode.postMessage({
          type: 'renameCourse',
          subject: course.subject,
          currentTitle: course.title,
        });
      } else if (action === 'delete-title') {
        vscode.postMessage({
          type: 'confirmDeleteCourse',
          subject: course.subject,
          title: course.title,
        });
      }
      els.editMenu?.classList.add('hidden');
    });
  });

  els.courseTitleRow?.addEventListener('click', (event) => {
    if (event.target === els.btnEditCourseTitle || els.btnEditCourseTitle?.contains(event.target)) {
      return;
    }
    els.courseTitleRow.classList.toggle('open');
    els.courseTree?.classList.toggle('hidden');
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'courses': {
        state.courses = Array.isArray(msg.data) ? msg.data : [];
        if (state.selectedSubject && !hasCourse(state.selectedSubject)) {
          state.selectedSubject = state.courses[0]?.subject || null;
        } else if (!state.selectedSubject && state.courses.length === 1) {
          state.selectedSubject = state.courses[0].subject;
        }
        onCourseSelected();
        break;
      }
      case 'courseGenerated': {
        if (msg.outline) {
          const next = state.courses.filter((course) => course.subject !== msg.outline.subject);
          next.push(msg.outline);
          state.courses = next;
          state.selectedSubject = msg.outline.subject;
        }
        onCourseSelected();
        break;
      }
      case 'materials': {
        state.materials = msg.data || { materials: [] };
        if (
          state.selectedCourseMaterialId &&
          !state.materials.materials.some((item) => item.id === state.selectedCourseMaterialId)
        ) {
          state.selectedCourseMaterialId = null;
          state.currentCourseMaterialPreview = null;
          if (state.chatGroundingMode === 'material') {
            state.chatGroundingMode = state.selectedSubject ? 'course' : 'general';
          }
          persist();
        }
        syncMaterialImportTargets();
        renderMaterials();
        renderCourseMaterials();
        renderChatContext();
        break;
      }
      case 'materialPreview': {
        state.currentCourseMaterialPreview = msg.data || null;
        state.selectedCourseMaterialId = state.currentCourseMaterialPreview?.materialId || null;
        renderCourseMaterials();
        renderChatContext();
        persist();
        break;
      }
      case 'preferences': {
        renderPreferences(msg.data || null);
        break;
      }
      case 'diagnosis': {
        renderDiagnosis(msg.data || null);
        break;
      }
      case 'chatResponse': {
        appendChat('assistant', msg.content || '');
        break;
      }
      case 'gradeResult': {
        addLog(`批改完成，得分 ${msg.result?.score ?? 0}/100`, 'info');
        break;
      }
      case 'taskStart': {
        if (msg.key) state.activeTaskKeys.add(msg.key);
        addTask(msg.id, msg.name);
        updateTaskBlockedState();
        break;
      }
      case 'taskEnd': {
        if (msg.key) state.activeTaskKeys.delete(msg.key);
        removeTask(msg.id);
        updateTaskBlockedState();
        break;
      }
      case 'loading': {
        if (msg.active) addTask('legacy', msg.task || '处理中...');
        else removeTask('legacy');
        updateTaskBlockedState();
        break;
      }
      case 'resolvedAIConfig': {
        state.resolvedAIConfig = msg.data || null;
        renderResolvedAIConfig(msg.data || null, msg.workspaceOverride || null);
        break;
      }
      case 'log': {
        addLog(msg.message, msg.level);
        break;
      }
      case 'error': {
        addLog(msg.message, 'error');
        break;
      }
      case 'dataDir': {
        if (els.dataDirPath) {
          els.dataDirPath.textContent = msg.path || '';
          els.dataDirPath.title = msg.path || '';
        }
        break;
      }
      default:
        break;
    }
  });

  state.chatMessages.forEach((message) => appendChat(message.role, message.content, false));
  renderCourseDropdown();
  renderSelectedCourse();
  renderCourseMaterials();
  renderMaterials();
  renderDiagnosis(null);
  syncMaterialImportTargets();
  renderChatContext();
  renderResolvedAIConfig(null, null);
  renderAIConfigCenterCollapsedState();
  updateTaskBlockedState();

  refreshCoursePanelData();
  vscode.postMessage({ type: 'getPreferences' });
  vscode.postMessage({ type: 'getDataDir' });
  vscode.postMessage({ type: 'getResolvedAIConfig' });
})();
