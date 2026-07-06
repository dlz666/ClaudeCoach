(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  // ============================================================
  // 全局 toast：之前主 sidebar 11 处调用 showToast 但没定义函数 → 静默崩溃。
  // 现在 design-system.css 的 .ds-toast-* 提供视觉，这里给 main.js 定义全局函数。
  // level: 'success' | 'error' | 'warn' | 'info'（默认 info）
  // ============================================================
  function _ensureToastContainer() {
    let el = document.getElementById('ds-toast-container');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ds-toast-container';
    el.className = 'ds-toast-container';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
  }
  function showToast(message, level, options) {
    if (!message) return;
    const container = _ensureToastContainer();
    const el = document.createElement('div');
    el.className = 'ds-toast ds-toast--' + (level || 'info');
    el.textContent = String(message);
    container.appendChild(el);
    const duration = (options && options.duration) || 2400;
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 320);
    }, duration);
  }
  // 暴露给 window 方便 webview 调试 / 跨函数调用
  window.showToast = showToast;

  // 课程教学法 Tag 元数据（与 types.ts 的 COURSE_TAG_LABELS/DESCRIPTIONS 同步）
  const COURSE_TAGS = [
    { value: 'cs-skill', label: '计算机技能', desc: '编程语言、框架、工具（如 React、Python、SQL、Git）' },
    { value: 'cs-theory', label: '计算机系统课', desc: '算法、操作系统、数据库、网络等系统课' },
    { value: 'math-foundation', label: '数学基础', desc: '微积分、线性代数、概率论、离散数学' },
    { value: 'math-advanced', label: '数学进阶', desc: '实分析、抽象代数、拓扑、泛函' },
    { value: 'physics', label: '物理', desc: '力学、电磁、量子、热统' },
    { value: 'engineering', label: '工程方法', desc: '系统设计、架构、设计模式、产品思维' },
    { value: 'language', label: '语言学习', desc: '英语、二外，重在词汇/语法/听说读写' },
    { value: 'exam-prep', label: '考试备考', desc: '考研、托福、CFA、AP 等有固定题型的备考' },
    { value: 'humanities', label: '人文社科', desc: '哲学、历史、心理学、社会学' },
    { value: 'research', label: '研究/论文', desc: '论文阅读、ML 理论、密码学进阶' },
  ];
  const COURSE_TAG_LABEL_MAP = COURSE_TAGS.reduce((m, t) => { m[t.value] = t.label; return m; }, {});

  // 资料类型元数据（与 types.ts 的 MATERIAL_TYPE_LABELS 同步）
  const MATERIAL_TYPES = [
    { value: 'textbook', label: '📚 教材/参考书' },
    { value: 'lecture-notes', label: '📝 课堂笔记/讲义' },
    { value: 'official-doc', label: '📖 官方文档/API' },
    { value: 'exam-paper', label: '📋 真题/模拟卷' },
    { value: 'paper', label: '📄 学术论文' },
    { value: 'cheatsheet', label: '🗂 速查表/汇总' },
    { value: 'video-transcript', label: '🎬 视频字幕' },
    { value: 'other', label: '📁 其他' },
  ];
  const MATERIAL_TYPE_LABEL_MAP = MATERIAL_TYPES.reduce((m, t) => { m[t.value] = t.label; return m; }, {});

  const SUBJECT_LABELS = {
    calculus: '微积分',
    'linear-algebra': '线性代数',
    'discrete-math': '离散数学',
    react: 'React',
    programming: '编程基础',
  };

  // ========== 默认偏好（用于"恢复默认"按钮） ==========
  const DEFAULT_PREFS = {
    difficulty: {
      global: 'basic',
      perSubject: {},
      exerciseMix: { easy: 30, medium: 50, hard: 20 },
    },
    pace: {
      dailyGoalMinutes: 45,
      exercisesPerSession: 5,
      speed: 'medium',
      reviewEveryNLessons: 3,
      restDays: [0, 6],
      studyTimeSlots: ['evening'],
    },
    language: {
      content: 'zh',
      exercises: 'zh',
      codeComments: 'zh',
    },
    aiStyle: {
      lessonDetail: 'standard',
      feedbackTone: 'encouraging',
      explanationStyles: ['example-first'],
      mathSymbol: 'latex',
      exerciseTypeMix: { multipleChoice: 40, freeResponse: 40, code: 20 },
      includeProofs: false,
      includeHistory: false,
    },
    retrieval: {
      defaultGrounding: false,
      strictness: 'balanced',
      citeSources: true,
      maxExcerpts: 4,
    },
    ui: {
      fontSize: 13,
      defaultTab: 'learn',
      expandCourseTree: true,
      showEmoji: true,
      theme: 'auto',
    },
    coach: {
      lecture: {
        viewerMode: 'lecture-webview',
        applyMode: 'preview-confirm',
        syncSourceEditor: true,
        highlightChangesMs: 3000,
      },
    },
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function deepMerge(base, override) {
    if (!override || typeof override !== 'object') return base;
    const result = Array.isArray(base) ? base.slice() : { ...base };
    Object.keys(override).forEach((key) => {
      const a = result[key];
      const b = override[key];
      if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a)) {
        result[key] = deepMerge(a, b);
      } else {
        result[key] = b;
      }
    });
    return result;
  }

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
    resolvedAIConfig: null,
    wrongQuestions: [],
    lastChatTurnId: null,
    answerSubmitContext: null,
    lastOpenedLesson: saved.lastOpenedLesson || null,
    // === 知识点 + lesson 编辑（不持久化，每次 webview 重载重置）===
    editingTopics: new Set(),       // 处于"编辑模式"的 topic ids（lesson 变输入框 + 增删按钮）
    expandedLessons: new Set(),     // 已展开知识点 inline 面板的 lesson ids
    keyPointsCache: {},             // { [lessonId]: LessonKeyPoints | null } 后端 loadKeyPoints 返回缓存
    aiProfiles: [],
    activeProfileId: null,
    workspaceAIOverride: null,
    settingsCollapsedGroups: saved.settingsCollapsedGroups || {}, // v1 legacy（不再使用，保留向后兼容）
    settingsActiveSection: saved.settingsActiveSection || null,    // v2：当前激活的 settings section ('pace' / 'aiStyle' / ...)
    materialsFilter: saved.materialsFilter || 'all',               // v2：资料库 filter chip 选择
    editingProfileId: null,
    rebuildModal: {
      open: false,
      mode: 'full',
      selectionStart: null,
      selectionEnd: null,
      selectionAnchor: null,
      instruction: '',
      showLibrary: false,
      selectedMaterialIds: [],
      preview: null,
      loadingPreview: false,
      applyingPreview: false,
      error: '',
    },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: Array.from(document.querySelectorAll('.tab')),
    tabContents: Array.from(document.querySelectorAll('.tab-content')),
    ddTrigger: $('course-dropdown-trigger'),
    ddMenu: $('course-dropdown-menu'),
    ddLabel: $('course-dropdown-label'),
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
    outlineRebuildModal: $('outline-rebuild-modal'),
    btnCloseOutlineRebuildModal: $('btn-close-outline-rebuild-modal'),
    btnOutlineRebuildModeFull: $('btn-outline-rebuild-mode-full'),
    btnOutlineRebuildModePartial: $('btn-outline-rebuild-mode-partial'),
    outlineRebuildModeHint: $('outline-rebuild-mode-hint'),
    outlineRebuildSelectionSection: $('outline-rebuild-selection-section'),
    outlineRebuildSelectionStatus: $('outline-rebuild-selection-status'),
    outlineRebuildTopicList: $('outline-rebuild-topic-list'),
    outlineRebuildInstruction: $('outline-rebuild-instruction'),
    outlineRebuildShowLibrary: $('outline-rebuild-show-library'),
    outlineRebuildMaterialScopeHint: $('outline-rebuild-material-scope-hint'),
    outlineRebuildMaterialList: $('outline-rebuild-material-list'),
    outlineRebuildPreviewStatus: $('outline-rebuild-preview-status'),
    outlineRebuildImpact: $('outline-rebuild-impact'),
    outlineRebuildPreviewTree: $('outline-rebuild-preview-tree'),
    outlineRebuildError: $('outline-rebuild-error'),
    btnOutlineRebuildPreview: $('btn-outline-rebuild-preview'),
    btnOutlineRebuildApply: $('btn-outline-rebuild-apply'),
    btnOutlineRebuildCancel: $('btn-outline-rebuild-cancel'),
    materialSubject: $('material-subject'),
    btnImport: $('btn-import'),
    materialsList: $('materials-list'),
    btnSavePrefs: $('btn-save-prefs'),
    btnOpenDataDir: $('btn-open-data-dir'),
    logList: $('log-list'),
    taskList: $('task-list'),
    dataDirPath: $('data-dir-path'),
    aiConfigCenter: $('ai-config-center'),
    btnChangeAIConfig: $('btn-ai-import'),
    aiChangeMenu: $('ai-import-menu'),
    resolvedConfigSource: $('resolved-config-source'),
    resolvedWarningPills: $('resolved-warning-pills'),
    resolvedConfigName: $('resolved-config-name'),
    resolvedConfigMeta: $('resolved-config-meta'),
    resolvedConfigProvider: $('resolved-config-provider'),
    resolvedConfigOrigin: $('resolved-config-origin'),
    resolvedConfigUrl: $('resolved-config-url'),
    resolvedConfigContext: $('resolved-config-context'),
    resolvedConfigMaxTokens: $('resolved-config-max-tokens'),
    resolvedConfigHistoryBudget: $('resolved-config-history-budget'),
    aiProfileCount: $('ai-profile-count'),
    prefDifficulty: $('pref-difficulty'),
    mixEasy: $('mix-easy'),
    mixMedium: $('mix-medium'),
    mixHard: $('mix-hard'),
    prefExercises: $('pref-exercises'),
    prefSpeed: $('pref-speed'),
    prefReview: $('pref-review'),
    prefLangContent: $('pref-lang-content'),
    prefLangCode: $('pref-lang-code'),
    wrongQuestionsSection: $('wrong-questions-section'),
    btnRefreshWrongQuestions: $('btn-refresh-wrong-questions'),
    wrongQuestionsActions: $('wrong-questions-actions'),
    btnPracticeWrongQuestions: $('btn-practice-wrong-questions'),
    wrongQuestionsList: $('wrong-questions-list'),
    answerSubmitModal: $('answer-submit-modal'),
    btnCloseAnswerSubmitModal: $('btn-close-answer-submit-modal'),
    answerSubmitLessonInfo: $('answer-submit-lesson-info'),
    answerSubmitTextarea: $('answer-submit-textarea'),
    btnAnswerSubmitSaveDraft: $('btn-answer-submit-save-draft'),
    btnAnswerSubmitClearDraft: $('btn-answer-submit-clear-draft'),
    answerSubmitDraftStatus: $('answer-submit-draft-status'),
    courseTagsModal: $('course-tags-modal'),
    courseTagsChecklist: $('course-tags-checklist'),
    courseTagsSubtitle: $('course-tags-subtitle'),
    btnSaveCourseTags: $('btn-save-course-tags'),
    btnCancelCourseTags: $('btn-cancel-course-tags'),
    btnCloseCourseTagsModal: $('btn-close-course-tags-modal'),
    answerSubmitError: $('answer-submit-error'),
    btnAnswerSubmitConfirm: $('btn-answer-submit-confirm'),
    btnAnswerSubmitCancel: $('btn-answer-submit-cancel'),

    // ===== 设置页搜索 =====
    settingsSearch: $('settings-search'),

    // ===== 设置组（折叠） =====
    settingsGroups: Array.from(document.querySelectorAll('.settings-group')),

    // ===== 学习节奏与目标 =====
    prefDailyGoal: $('pref-daily-goal'),
    prefDailyGoalNum: $('pref-daily-goal-num'),
    studySlotMorning: document.querySelector('[data-study-slot="morning"]'),
    studySlotAfternoon: document.querySelector('[data-study-slot="afternoon"]'),
    studySlotEvening: document.querySelector('[data-study-slot="evening"]'),
    restDayCheckboxes: Array.from(document.querySelectorAll('[data-rest-day]')),
    studySlotCheckboxes: Array.from(document.querySelectorAll('[data-study-slot]')),
    mixSumHint: $('mix-sum-hint'),
    perSubjectDifficultyList: $('per-subject-difficulty-list'),

    // ===== AI 风格与内容 =====
    aiDetailLevelRadios: Array.from(document.querySelectorAll('input[name="ai-detail-level"]')),
    aiFeedbackToneRadios: Array.from(document.querySelectorAll('input[name="ai-feedback-tone"]')),
    explainStyleCheckboxes: Array.from(document.querySelectorAll('[data-explain-style]')),
    aiMathStyleRadios: Array.from(document.querySelectorAll('input[name="ai-math-style"]')),
    exTypeConcept: $('ex-type-concept'),
    exTypeCalc: $('ex-type-calc'),
    exTypeProof: $('ex-type-proof'),
    exTypeSumHint: $('ex-type-sum-hint'),
    aiIncludeProofs: $('ai-include-proofs'),
    aiIncludeHistory: $('ai-include-history'),
    prefLangExercises: $('pref-lang-exercises'),

    // ===== 资料检索 =====
    retrievalGroundingDefault: $('retrieval-grounding-default'),
    retrievalStrictnessRadios: Array.from(document.querySelectorAll('input[name="retrieval-strictness"]')),
    retrievalCiteDefault: $('retrieval-cite-default'),
    retrievalSnippets: $('retrieval-snippets'),
    retrievalSnippetsValue: $('retrieval-snippets-value'),
    // Hybrid RAG
    embeddingEnabled: $('embedding-enabled'),
    embeddingBaseUrl: $('embedding-baseUrl'),
    embeddingToken: $('embedding-token'),
    embeddingModel: $('embedding-model'),
    embeddingDimension: $('embedding-dimension'),
    embeddingHybridWeight: $('embedding-hybrid-weight'),
    embeddingHybridWeightValue: $('embedding-hybrid-weight-value'),
    btnTestEmbedding: $('btn-test-embedding'),
    btnReindexVectors: $('btn-reindex-vectors'),
    embeddingTestStatus: $('embedding-test-status'),
    // Vision API（PDF → markdown）
    visionEnabled: $('vision-enabled'),
    visionBaseUrl: $('vision-baseUrl'),
    visionToken: $('vision-token'),
    visionModel: $('vision-model'),
    visionConcurrency: $('vision-concurrency'),
    visionConcurrencyValue: $('vision-concurrency-value'),
    visionDpi: $('vision-dpi'),

    // ===== 讲义阅读体验 =====
    lectureReaderModeRadios: Array.from(document.querySelectorAll('input[name="lecture-reader-mode"]')),
    lectureApplyModeRadios: Array.from(document.querySelectorAll('input[name="lecture-apply-mode"]')),
    lectureSyncSource: $('lecture-sync-source'),
    lectureHighlightDuration: $('lecture-highlight-duration'),
    lectureHighlightDurationValue: $('lecture-highlight-duration-value'),

    // ===== UI 与显示 =====
    uiFontSize: $('ui-font-size'),
    uiFontSizeValue: $('ui-font-size-value'),
    uiDefaultTabRadios: Array.from(document.querySelectorAll('input[name="ui-default-tab"]')),
    uiTreeDefaultExpand: $('ui-tree-default-expand'),
    uiThemeRadios: Array.from(document.querySelectorAll('input[name="ui-theme"]')),
    uiShowEmoji: $('ui-show-emoji'),

    // ===== AI Profile 编辑器 =====
    btnAddAIProfile: $('btn-add-ai-profile'),
    aiProfilesList: $('ai-profiles-list'),
    aiProfileEditor: $('ai-profile-editor-modal'),
    aiProfileEditorTitle: $('ai-profile-editor-title'),
    aiProfileName: $('ai-profile-name'),
    aiProfileProvider: $('ai-profile-provider'),
    aiProfileBaseUrl: $('ai-profile-base-url'),
    aiProfileAnthropicBaseUrl: $('ai-profile-anthropic-base-url'),
    aiProfileToken: $('ai-profile-token'),
    aiProfileModel: $('ai-profile-model'),
    aiProfileWireApi: $('ai-profile-wire-api'),
    aiProfileContextWindow: $('ai-profile-context-window'),
    aiProfileMaxTokens: $('ai-profile-max-tokens'),
    aiProfileReasoningEffort: $('ai-profile-reasoning-effort'),
    aiProfileNotes: $('ai-profile-notes'),
    aiProfileDraftFeedback: $('ai-profile-draft-feedback'),
    btnSaveAIProfile: $('btn-save-ai-profile'),
    btnTestAIProfileDraft: $('btn-test-ai-profile-draft'),
    btnCancelAIProfile: $('btn-close-ai-profile-modal'),
    aiWsOverrideEnabled: $('ai-ws-override-enabled'),
    aiWsBaseProfile: $('ai-ws-base-profile'),
    aiWsProvider: $('ai-ws-provider'),
    aiWsBaseUrl: $('ai-ws-base-url'),
    aiWsAnthropicBaseUrl: $('ai-ws-anthropic-base-url'),
    aiWsToken: $('ai-ws-token'),
    aiWsModel: $('ai-ws-model'),
    aiWsWireApi: $('ai-ws-wire-api'),
    aiWsReasoningEffort: $('ai-ws-reasoning-effort'),
    aiWsContextWindow: $('ai-ws-context-window'),
    aiWsMaxTokens: $('ai-ws-max-tokens'),
    btnSaveWsOverride: $('btn-save-ws-override'),
    aiPresetGrid: $('ai-preset-grid'),
    aiWsSummary: $('ai-ws-summary'),
    btnCloseAIProfileModal: $('btn-close-ai-profile-modal'),

    // ===== 数据管理 =====
    dataSubjectSelect: $('data-subject-select'),
    btnClearWrongQuestions: $('btn-clear-wrong-questions'),
    btnClearDiagnosis: $('btn-clear-diagnosis'),
    btnResetCourseProgress: $('btn-reset-course-progress'),
    btnExportLearningData: $('btn-export-learning-data'),
    btnImportLearningData: $('btn-import-learning-data'),

    // ===== 数据目录与高级 =====
    btnExportPrefs: $('btn-export-prefs'),
    btnImportPrefs: $('btn-import-prefs'),
    btnResetAllPrefs: $('btn-reset-all-prefs'),

    // ===== Onboarding =====
    onboardingCard: $('onboarding-card'),
    onboardingStepAi: $('onboarding-step-ai'),
    onboardingStepCourse: $('onboarding-step-course'),
    onboardingStepMaterial: $('onboarding-step-material'),
    onboardingStepLesson: $('onboarding-step-lesson'),
    btnOnboardingDismiss: $('btn-onboarding-dismiss'),
    btnOnboardingGoAi: $('btn-onboarding-go-ai'),

    // ===== 重置组按钮 =====
    resetGroupButtons: Array.from(document.querySelectorAll('[data-reset-group]')),
  };

  function subjectLabel(subject) {
    return SUBJECT_LABELS[subject] || subject || '未命名课程';
  }

  /** 渲染一组 tag 徽章 HTML（用于课程标题旁、下拉菜单内）。 */
  function renderCourseTagBadges(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    return `<span class="course-tag-badges">${tags
      .map((t) => `<span class="course-tag-badge">${escapeHtml(COURSE_TAG_LABEL_MAP[t] || t)}</span>`)
      .join('')}</span>`;
  }

  function hasCourse(subject) {
    return !!subject && state.courses.some((course) => course.subject === subject);
  }

  function getCourse(subject) {
    return state.courses.find((course) => course.subject === subject) || null;
  }

  function getCourseMaterials(subject) {
    if (!subject) return [];
    return (state.materials.materials || []).filter((item) => item.subject === subject);
  }

  function getOutlineRebuildAvailableMaterials() {
    if (state.rebuildModal.showLibrary) {
      return state.materials.materials || [];
    }
    return getCourseMaterials(state.selectedSubject);
  }

  function clearOutlineRebuildPreview() {
    state.rebuildModal.preview = null;
    state.rebuildModal.error = '';
  }

  function resetOutlineRebuildSelection() {
    state.rebuildModal.selectionStart = null;
    state.rebuildModal.selectionEnd = null;
    state.rebuildModal.selectionAnchor = null;
  }

  function reconcileOutlineRebuildMaterials() {
    const allowed = new Set(getOutlineRebuildAvailableMaterials().map((item) => item.id));
    state.rebuildModal.selectedMaterialIds = (state.rebuildModal.selectedMaterialIds || []).filter((materialId) => allowed.has(materialId));
  }

  function closeOutlineRebuildModal() {
    state.rebuildModal.open = false;
    state.rebuildModal.loadingPreview = false;
    state.rebuildModal.applyingPreview = false;
    renderOutlineRebuildModal();
  }

  function openOutlineRebuildModal() {
    if (!state.selectedSubject || !getCourse(state.selectedSubject)) {
      addLog('请先选择当前课程。', 'warn');
      return;
    }

    state.rebuildModal.open = true;
    state.rebuildModal.mode = 'full';
    state.rebuildModal.instruction = '';
    state.rebuildModal.showLibrary = false;
    state.rebuildModal.selectedMaterialIds = state.selectedCourseMaterialId ? [state.selectedCourseMaterialId] : [];
    state.rebuildModal.loadingPreview = false;
    state.rebuildModal.applyingPreview = false;
    clearOutlineRebuildPreview();
    resetOutlineRebuildSelection();
    reconcileOutlineRebuildMaterials();
    renderOutlineRebuildModal();
  }

  function getOutlineRebuildSelection() {
    if (state.rebuildModal.mode !== 'partial') {
      return undefined;
    }

    if (!Number.isInteger(state.rebuildModal.selectionStart) || !Number.isInteger(state.rebuildModal.selectionEnd)) {
      return undefined;
    }

    return {
      startIndex: Math.min(state.rebuildModal.selectionStart, state.rebuildModal.selectionEnd),
      endIndex: Math.max(state.rebuildModal.selectionStart, state.rebuildModal.selectionEnd),
    };
  }

  function describeOutlineRebuildSelection(course) {
    const selection = getOutlineRebuildSelection();
    if (!course || !selection) {
      return '还没有选择连续区间。';
    }

    const startTopic = course.topics?.[selection.startIndex];
    const endTopic = course.topics?.[selection.endIndex];
    if (!startTopic || !endTopic) {
      return '当前选区无效，请重新选择。';
    }

    return `当前选区：第 ${selection.startIndex + 1} 到第 ${selection.endIndex + 1} 个主题，${startTopic.title} -> ${endTopic.title}`;
  }

  function toggleOutlineRebuildTopic(index) {
    if (state.rebuildModal.mode !== 'partial') {
      return;
    }

    const start = state.rebuildModal.selectionStart;
    const end = state.rebuildModal.selectionEnd;
    const anchor = state.rebuildModal.selectionAnchor;

    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(anchor)) {
      state.rebuildModal.selectionStart = index;
      state.rebuildModal.selectionEnd = index;
      state.rebuildModal.selectionAnchor = index;
      clearOutlineRebuildPreview();
      renderOutlineRebuildModal();
      return;
    }

    if (start === end && anchor === start && index !== anchor) {
      state.rebuildModal.selectionStart = Math.min(anchor, index);
      state.rebuildModal.selectionEnd = Math.max(anchor, index);
      state.rebuildModal.selectionAnchor = null;
    } else {
      state.rebuildModal.selectionStart = index;
      state.rebuildModal.selectionEnd = index;
      state.rebuildModal.selectionAnchor = index;
    }

    clearOutlineRebuildPreview();
    renderOutlineRebuildModal();
  }

  function toggleOutlineRebuildMaterial(materialId) {
    const current = new Set(state.rebuildModal.selectedMaterialIds || []);
    if (current.has(materialId)) {
      current.delete(materialId);
    } else {
      current.add(materialId);
    }
    state.rebuildModal.selectedMaterialIds = Array.from(current);
    clearOutlineRebuildPreview();
    renderOutlineRebuildModal();
  }

  function persist() {
    vscode.setState({
      selectedSubject: state.selectedSubject,
      selectedCourseMaterialId: state.selectedCourseMaterialId,
      chatGroundingMode: state.chatGroundingMode,
      chatMessages: state.chatMessages,
      lastOpenedLesson: state.lastOpenedLesson,
      settingsCollapsedGroups: state.settingsCollapsedGroups, // legacy
      settingsActiveSection: state.settingsActiveSection,
      materialsFilter: state.materialsFilter,
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

  const markdownRenderer = typeof window.markdownit === 'function'
    ? window.markdownit({
        html: false,
        breaks: true,
        linkify: true,
        typographer: false,
        highlight: (str, lang) => {
          // 用 highlight.js 渲染代码块（如果它已加载）
          if (typeof window.hljs !== 'undefined' && window.hljs) {
            try {
              if (lang && window.hljs.getLanguage(lang)) {
                const out = window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
                return `<pre class="hljs"><code class="hljs language-${lang}">${out}</code></pre>`;
              }
              // 未指定语言时让 hljs 自动检测
              const auto = window.hljs.highlightAuto(str);
              return `<pre class="hljs"><code class="hljs language-${auto.language || 'text'}">${auto.value}</code></pre>`;
            } catch (err) {
              console.warn('hljs render failed:', err);
            }
          }
          // hljs 不可用时回退默认转义
          return ''; // 让 markdown-it 走默认 escapeHtml
        },
      })
    : null;

  if (markdownRenderer) {
    const defaultLinkOpen = markdownRenderer.renderer.rules.link_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
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

  function renderMarkdownFallback(text) {
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

  function renderMarkdown(text) {
    const source = String(text || '');
    if (!markdownRenderer) {
      return renderMarkdownFallback(source);
    }

    try {
      return markdownRenderer.render(source);
    } catch (error) {
      console.warn('Markdown render failed, falling back to plain renderer.', error);
      return renderMarkdownFallback(source);
    }
  }

  function renderMath(element) {
    if (!element || typeof window.renderMathInElement !== 'function') {
      return;
    }

    try {
      window.renderMathInElement(element, mathRenderOptions);
    } catch (error) {
      console.warn('KaTeX render failed.', error);
    }
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
    const chatBusy = state.activeTaskKeys.has('AI 对话') || state.activeTaskKeys.has('修改讲义');
    [
      els.btnGenerateCourse,
      els.btnDiagnosis,
      els.btnImport,
      els.btnImportCourseMaterial,
      els.btnChatRebuildOutline,
      els.btnSavePrefs,
      els.btnOutlineRebuildPreview,
      els.btnOutlineRebuildApply,
    ].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      button.classList.toggle('is-busy', busy);
    });
    if (els.btnChatSend) {
      els.btnChatSend.disabled = chatBusy;
      els.btnChatSend.classList.toggle('is-busy', chatBusy);
    }
    renderOutlineRebuildModal();
  }

  function appendChat(role, content, save = true) {
    if (!els.chatMessages) return;
    const el = document.createElement('div');
    el.className = `chat-msg ${role}`;
    if (role === 'assistant') {
      el.innerHTML = renderMarkdown(content);
      renderMath(el);
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
    return (els.subjectInput?.value || '').trim();
  }

  function setCreateCourseMode(enabled) {
    if (enabled) {
      state.selectedSubject = null;
      renderDiagnosis(null);
      // 首次进入创建模式时渲染新课程的 tag checklist（复用 COURSE_TAGS）
      renderNewCourseTagsChecklist();
    }
    els.newCoursePanel?.classList.toggle('hidden', !enabled);
    if (enabled) {
      requestAnimationFrame(() => {
        els.subjectInput?.focus();
      });
    }
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

    const items = state.courses.map((course) => {
      const title = course.title || subjectLabel(course.subject);
      const subject = subjectLabel(course.subject);
      // title 与 subject 几乎重复时，只显示 title（去掉右侧冗余）
      const showSubject = title.trim() !== subject.trim() && !title.includes(subject) && !subject.includes(title);
      return `
        <div class="dropdown-item${course.subject === state.selectedSubject ? ' selected' : ''}" data-subject="${escapeHtml(course.subject)}">
          <span class="dropdown-item-main">
            <span class="dropdown-item-title">${escapeHtml(title)}</span>
            ${renderCourseTagBadges(course.tags)}
          </span>
          ${showSubject ? `<span class="muted dropdown-item-aux">${escapeHtml(subject)}</span>` : ''}
        </div>
      `;
    });

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
    // 标题旁渲染 tag 徽章
    const tagsHtml = renderCourseTagBadges(course.tags);
    els.courseTitleText.innerHTML = `${escapeHtml(course.title)}${tagsHtml ? ' ' + tagsHtml : ''}`;
    els.courseTree.classList.remove('hidden');

    // topic 三点菜单（编辑 lessons / 生成本章知识点）+ lesson 行（编辑模式切换 + 知识点 inline 折叠）
    const topicsHtml = course.topics.map((topic, topicIndex) => {
      const editing = state.editingTopics.has(topic.id);
      const lessonsHtml = (topic.lessons || []).map((lesson) => {
        const expanded = state.expandedLessons.has(lesson.id);
        const commonData = `
          data-subject="${escapeHtml(course.subject)}"
          data-topic-id="${escapeHtml(topic.id)}"
          data-topic-title="${escapeHtml(topic.title)}"
          data-lesson-id="${escapeHtml(lesson.id)}"
          data-lesson-title="${escapeHtml(lesson.title)}"
          data-difficulty="${Number(lesson.difficulty) || 1}"`;
        if (editing) {
          // 编辑模式：标题→输入框；右侧增删/上下移动按钮；隐藏讲义/练习/...
          return `
            <div class="tree-lesson tree-lesson-editing" ${commonData}>
              <input type="text" class="tree-lesson-input" value="${escapeHtml(lesson.title)}"
                aria-label="重命名讲义" />
              <span class="tree-actions tree-edit-actions">
                <button class="tree-btn btn-move-up" title="上移" ${commonData}>↑</button>
                <button class="tree-btn btn-move-down" title="下移" ${commonData}>↓</button>
                <button class="tree-btn btn-delete-lesson" title="删除" ${commonData}>×</button>
              </span>
            </div>`;
        }
        // 正常模式：左侧 ▸ 知识点展开箭头 + 状态点 + 标题 + 右侧讲义/练习/... + 可选 inline 知识点面板
        return `
          <div class="tree-lesson tree-lesson-open" role="button" tabindex="0" ${commonData}>
            <button class="tree-lesson-toggle ${expanded ? 'open' : ''}" title="知识点" ${commonData}>▸</button>
            <span class="tree-lesson-label">
              <span class="status-dot ${lesson.status || 'not-started'}"></span>
              ${escapeHtml(lesson.title)}
            </span>
            <span class="tree-actions">
              <button class="tree-btn btn-lesson" ${commonData}>讲义</button>
              <button class="tree-btn btn-exercise" ${commonData}>练习</button>
            </span>
          </div>
          ${expanded ? `<div class="lesson-keypoints-panel" data-lesson-id="${escapeHtml(lesson.id)}" data-topic-id="${escapeHtml(topic.id)}" data-subject="${escapeHtml(course.subject)}"></div>` : ''}
        `;
      }).join('');
      const addLessonRow = editing ? `
        <div class="tree-lesson-add">
          <button class="tree-btn btn-add-lesson"
            data-subject="${escapeHtml(course.subject)}"
            data-topic-id="${escapeHtml(topic.id)}"
            data-topic-title="${escapeHtml(topic.title)}"
          >＋ 添加章节</button>
        </div>` : '';
      return `
        <div class="tree-node">
          <div class="tree-topic-row">
            <div class="tree-topic open" data-topic-id="${escapeHtml(topic.id)}">${escapeHtml(formatTopicTitle(topic, topicIndex))}</div>
            <button class="tree-btn btn-topic-more" data-topic-id="${escapeHtml(topic.id)}" data-topic-title="${escapeHtml(topic.title)}" data-subject="${escapeHtml(course.subject)}" title="编辑 / 生成知识点">⋯</button>
          </div>
          <div class="tree-children${editing ? ' editing-mode' : ''}">
            ${lessonsHtml}
            ${addLessonRow}
          </div>
        </div>
      `;
    }).join('');

    // 注意：outline.projects 的"推荐项目"**不再**渲染在 course-tree 里。
    // 跟"已创建的项目"合并到独立面板 #course-projects-section 的两个 subsection
    // 见 renderCourseProjectProposals + renderProjectsList。
    els.courseTree.innerHTML = topicsHtml;

    els.courseTree.querySelectorAll('.tree-topic').forEach((topicEl) => {
      topicEl.addEventListener('click', () => {
        topicEl.classList.toggle('open');
        // 折叠目标是 .tree-node 内的 .tree-children —— 现在 .tree-topic 被
        // .tree-topic-row 包了（旁边是 ⋯ 按钮），nextElementSibling 不再是 .tree-children
        const node = topicEl.closest('.tree-node');
        node?.querySelector(':scope > .tree-children')?.classList.toggle('collapsed');
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
      state.lastOpenedLesson = {
        subject: d.subject,
        topicId: d.topicId,
        topicTitle: d.topicTitle,
        lessonId: d.lessonId,
        lessonTitle: d.lessonTitle,
      };
      persist();
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
        state.lastOpenedLesson = {
          subject: d.subject,
          topicId: d.topicId,
          topicTitle: d.topicTitle,
          lessonId: d.lessonId,
          lessonTitle: d.lessonTitle,
        };
        persist();
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
        <button class="lesson-menu-action" type="button" role="menuitem" data-action="answer">答题与批改</button>
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

          if (action === 'answer') {
            openAnswerSubmitModal({
              subject: d.subject,
              topicId: d.topicId,
              topicTitle: d.topicTitle,
              lessonId: d.lessonId,
              lessonTitle: d.lessonTitle,
            });
            return;
          }

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
            state.lastOpenedLesson = {
              subject: d.subject,
              topicId: d.topicId,
              topicTitle: d.topicTitle,
              lessonId: d.lessonId,
              lessonTitle: d.lessonTitle,
            };
            persist();
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

    // ===== topic 三点菜单（编辑 lessons / 生成本章知识点） =====
    els.courseTree.querySelectorAll('.btn-topic-more').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const d = btn.dataset;
        const topicId = d.topicId;
        const editing = state.editingTopics.has(topicId);
        // 关闭已打开的别的 topic 菜单
        document.querySelectorAll('.topic-menu-popover').forEach((p) => p.remove());
        const popover = document.createElement('div');
        popover.className = 'topic-menu-popover';
        popover.innerHTML = `
          <button type="button" data-action="toggle-edit">${editing ? '✓ 完成编辑' : '✎ 编辑讲义'}</button>
          <button type="button" data-action="gen-keypoints">💡 一键生成本章知识点</button>
        `;
        btn.parentNode?.appendChild(popover);
        const closer = (e) => {
          if (!popover.contains(e.target) && e.target !== btn) {
            popover.remove();
            document.removeEventListener('click', closer);
          }
        };
        setTimeout(() => document.addEventListener('click', closer), 0);
        popover.querySelectorAll('button').forEach((actionBtn) => {
          actionBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const action = actionBtn.dataset.action;
            popover.remove();
            if (action === 'toggle-edit') {
              if (editing) state.editingTopics.delete(topicId);
              else state.editingTopics.add(topicId);
              renderSelectedCourse();
            } else if (action === 'gen-keypoints') {
              vscode.postMessage({
                type: 'generateKeyPointsForTopic',
                subject: d.subject,
                topicId,
                topicTitle: d.topicTitle,
              });
            }
          });
        });
      });
    });

    // ===== 编辑模式：lesson 输入框 rename / 上下移动 / 删除 / 添加 =====
    els.courseTree.querySelectorAll('.tree-lesson-input').forEach((input) => {
      const row = input.closest('.tree-lesson-editing');
      if (!row) return;
      const d = row.dataset;
      const commit = () => {
        const newTitle = input.value.trim();
        if (!newTitle || newTitle === d.lessonTitle) return;
        vscode.postMessage({
          type: 'renameLesson',
          subject: d.subject,
          topicId: d.topicId,
          lessonId: d.lessonId,
          newTitle,
        });
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = d.lessonTitle; input.blur(); }
      });
    });

    els.courseTree.querySelectorAll('.btn-move-up, .btn-move-down').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const d = btn.dataset;
        vscode.postMessage({
          type: 'reorderLesson',
          subject: d.subject,
          topicId: d.topicId,
          lessonId: d.lessonId,
          dir: btn.classList.contains('btn-move-up') ? -1 : 1,
        });
      });
    });

    els.courseTree.querySelectorAll('.btn-delete-lesson').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        // 直接删 —— 编辑模式本身已是二次操作，且 VSCode webview 默认禁 confirm()（静默
        // 返回 false 会让按钮看似无反应）。误删可在讲义阅读器 .bak 撤回 / 重新生成。
        const d = btn.dataset;
        vscode.postMessage({
          type: 'deleteLesson',
          subject: d.subject,
          topicId: d.topicId,
          lessonId: d.lessonId,
          lessonTitle: d.lessonTitle,
        });
      });
    });

    els.courseTree.querySelectorAll('.btn-add-lesson').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        // 直接添加默认标题 —— VSCode webview 禁 prompt()（静默返回 null）。
        // 后端创建后用户在编辑模式输入框里立即改名即可。
        const d = btn.dataset;
        vscode.postMessage({
          type: 'addLesson',
          subject: d.subject,
          topicId: d.topicId,
          title: '新章节',
        });
      });
    });

    // ===== 知识点 inline 折叠展开 =====
    els.courseTree.querySelectorAll('.tree-lesson-toggle').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const d = btn.dataset;
        const lessonId = d.lessonId;
        if (state.expandedLessons.has(lessonId)) {
          state.expandedLessons.delete(lessonId);
        } else {
          state.expandedLessons.add(lessonId);
          // 没缓存就 load；缓存有就直接渲染（lazy load）
          if (!(lessonId in state.keyPointsCache)) {
            vscode.postMessage({
              type: 'loadKeyPoints',
              subject: d.subject,
              topicId: d.topicId,
              lessonId,
            });
          }
        }
        renderSelectedCourse();
        // 渲染完后填充已缓存的 panel
        if (state.expandedLessons.has(lessonId) && lessonId in state.keyPointsCache) {
          renderKeyPointsPanel(lessonId);
        }
      });
    });

    // 渲染已展开 lesson 的知识点面板内容（页面切换/重渲后调用）
    state.expandedLessons.forEach((lessonId) => {
      if (lessonId in state.keyPointsCache) {
        renderKeyPointsPanel(lessonId);
      }
    });
  }

  // ============================================================
  // 知识点 inline 面板渲染 + 编辑
  // ============================================================

  /** 渲染指定 lesson 的知识点 panel（按 parentId 分层、按 order 排序）。 */
  function renderKeyPointsPanel(lessonId) {
    const panel = document.querySelector(`.lesson-keypoints-panel[data-lesson-id="${CSS.escape(lessonId)}"]`);
    if (!panel) return;
    const d = panel.dataset;
    const kp = state.keyPointsCache[lessonId];
    if (kp === undefined) {
      panel.innerHTML = '<div class="keypoints-empty muted">加载中…</div>';
      return;
    }
    if (kp === null || !kp.items || kp.items.length === 0) {
      panel.innerHTML = `
        <div class="keypoints-empty">
          <span class="muted">还没生成知识点。可在 topic ⋯ 菜单"一键生成本章知识点"，或</span>
          <button class="tree-btn btn-init-keypoint" data-subject="${escapeHtml(d.subject)}" data-topic-id="${escapeHtml(d.topicId)}" data-lesson-id="${escapeHtml(lessonId)}">手动添加</button>
        </div>
      `;
      panel.querySelector('.btn-init-keypoint')?.addEventListener('click', (e) => {
        e.stopPropagation();
        addKeyPoint(lessonId, null);
      });
      return;
    }

    // 按 parentId 分组、按 order 排
    const byParent = new Map();
    kp.items.forEach((it) => {
      const p = it.parentId || null;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(it);
    });
    byParent.forEach((list) => list.sort((a, b) => (a.order || 0) - (b.order || 0)));

    const renderNode = (item, depth) => {
      const star = item.core ? '⭐' : '☆';
      const hasNote = item.note && item.note.trim();
      return `
        <div class="keypoint-item" data-id="${escapeHtml(item.id)}" data-depth="${depth}" style="margin-left:${depth * 18}px">
          <button class="keypoint-star ${item.core ? 'on' : ''}" data-id="${escapeHtml(item.id)}" title="重点掌握">${star}</button>
          <input type="text" class="keypoint-title" data-id="${escapeHtml(item.id)}" value="${escapeHtml(item.title)}" />
          <button class="keypoint-note-btn ${hasNote ? 'has-note' : ''}" data-id="${escapeHtml(item.id)}" title="${hasNote ? '备注：' + escapeHtml(item.note) : '加备注'}">📝</button>
          ${depth < 1 ? `<button class="keypoint-add-child" data-id="${escapeHtml(item.id)}" title="加子点">＋子</button>` : ''}
          <button class="keypoint-delete" data-id="${escapeHtml(item.id)}" title="删除">×</button>
        </div>
        ${(byParent.get(item.id) || []).map((child) => renderNode(child, depth + 1)).join('')}
      `;
    };

    const rootItems = byParent.get(null) || [];
    panel.innerHTML = `
      <div class="keypoints-list">
        ${rootItems.map((it) => renderNode(it, 0)).join('')}
      </div>
      <button class="tree-btn btn-add-root-kp" title="新增根级知识点">＋ 添加</button>
    `;

    // 绑定操作
    panel.querySelectorAll('.keypoint-star').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = kp.items.find((x) => x.id === id);
        if (item) {
          item.core = !item.core;
          saveKeyPoints(lessonId);
          renderKeyPointsPanel(lessonId);
        }
      });
    });

    panel.querySelectorAll('.keypoint-title').forEach((input) => {
      input.addEventListener('blur', () => {
        const id = input.dataset.id;
        const item = kp.items.find((x) => x.id === id);
        if (item && input.value.trim() && item.title !== input.value.trim()) {
          item.title = input.value.trim();
          saveKeyPoints(lessonId);
        }
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    });

    panel.querySelectorAll('.keypoint-note-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = kp.items.find((x) => x.id === id);
        if (!item) return;
        // 替代 prompt()（VSCode webview 禁用）—— 在 keypoint-item 下方插一个 inline editor
        panel.querySelectorAll('.keypoint-note-editor').forEach((ed) => ed.remove());
        const itemEl = panel.querySelector(`.keypoint-item[data-id="${CSS.escape(id)}"]`);
        if (!itemEl) return;
        const editor = document.createElement('div');
        editor.className = 'keypoint-note-editor';
        editor.innerHTML = `
          <input type="text" placeholder="备注（清空则删除，例如：教材 P127 / 易错 / 超纲跳过）" value="${escapeHtml(item.note || '')}" />
          <button type="button" class="tree-btn kp-note-save">保存</button>
          <button type="button" class="tree-btn kp-note-cancel">取消</button>
        `;
        itemEl.insertAdjacentElement('afterend', editor);
        const input = editor.querySelector('input');
        input.focus();
        input.select();
        const cleanup = () => editor.remove();
        const save = () => {
          item.note = input.value.trim() || undefined;
          cleanup();
          saveKeyPoints(lessonId);
          renderKeyPointsPanel(lessonId);
        };
        editor.querySelector('.kp-note-save').addEventListener('click', save);
        editor.querySelector('.kp-note-cancel').addEventListener('click', cleanup);
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') { ke.preventDefault(); save(); }
          if (ke.key === 'Escape') cleanup();
        });
      });
    });

    panel.querySelectorAll('.keypoint-add-child').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addKeyPoint(lessonId, btn.dataset.id);
      });
    });

    panel.querySelectorAll('.keypoint-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        // 删除节点 + 其所有 children
        const toDelete = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          kp.items.forEach((it) => {
            if (toDelete.has(it.parentId) && !toDelete.has(it.id)) {
              toDelete.add(it.id);
              grew = true;
            }
          });
        }
        kp.items = kp.items.filter((it) => !toDelete.has(it.id));
        saveKeyPoints(lessonId);
        renderKeyPointsPanel(lessonId);
      });
    });

    panel.querySelector('.btn-add-root-kp')?.addEventListener('click', (e) => {
      e.stopPropagation();
      addKeyPoint(lessonId, null);
    });
  }

  /** 添加新知识点（默认空标题，输入框 focus 让用户立刻填）。 */
  function addKeyPoint(lessonId, parentId) {
    let kp = state.keyPointsCache[lessonId];
    if (!kp) {
      kp = { lessonId, version: 1, items: [] };
      state.keyPointsCache[lessonId] = kp;
    }
    const siblings = kp.items.filter((it) => (it.parentId || null) === parentId);
    const newItem = {
      id: 'kp-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title: '新知识点',
      parentId,
      order: siblings.length,
      core: false,
    };
    kp.items.push(newItem);
    saveKeyPoints(lessonId);
    renderKeyPointsPanel(lessonId);
    // 自动 focus 到新加项
    setTimeout(() => {
      const newInput = document.querySelector(`.keypoint-title[data-id="${CSS.escape(newItem.id)}"]`);
      if (newInput) { newInput.focus(); newInput.select(); }
    }, 50);
  }

  /** 把当前缓存的 keypoints 写回后端（防抖：连续编辑只发最后一次）。 */
  const _saveKpTimers = {};
  function saveKeyPoints(lessonId) {
    clearTimeout(_saveKpTimers[lessonId]);
    _saveKpTimers[lessonId] = setTimeout(() => {
      const kp = state.keyPointsCache[lessonId];
      if (!kp) return;
      // 从 lesson DOM 拿 subject/topicId
      const panel = document.querySelector(`.lesson-keypoints-panel[data-lesson-id="${CSS.escape(lessonId)}"]`);
      const subject = panel?.dataset.subject;
      const topicId = panel?.dataset.topicId;
      if (!subject || !topicId) return;
      vscode.postMessage({
        type: 'saveKeyPoints',
        subject,
        topicId,
        lessonId,
        items: kp.items,
      });
    }, 220);
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
      els.courseMaterialsList.className = '';
      els.courseMaterialsList.innerHTML = '<p class="cc-material-empty">本课程暂无资料，可在「资料库」标签导入</p>';
      els.courseMaterialPreview.classList.add('hidden');
      return;
    }

    const vectorStats = state.materials.vectorStats || {};
    els.courseMaterialsList.className = 'cc-material-list';
    // 用统一卡片组件 + active 高亮当前预览中的那一项
    els.courseMaterialsList.innerHTML = materials.map((item) =>
      _renderMaterialCard(item, vectorStats, { activeId: state.selectedCourseMaterialId })
    ).join('');

    // 卡片点击 → 在本面板内预览（不切 tab）
    _bindMaterialCardEvents(els.courseMaterialsList, {
      onCardClick: (id) => {
        vscode.postMessage({ type: 'previewMaterial', materialId: id });
      },
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

  // ===== Materials v2 渲染 =====
  // 单个资料 = 一张 cc-material-card：
  //   主行：图标 + 文件名 + 状态 chip + 主操作按钮 + ⋯ 菜单
  //   meta 行：类型 · v1/v2+块数+章节 · 维度 · 提取方式
  // 状态分 4 个 filter chip：全部 / 待处理 / 已索引 / 失败
  const MATERIAL_STATUS_LABELS = { pending: '待处理', extracted: '已提取', indexed: '已索引', failed: '失败' };
  function _fileIconFor(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    if (ext === 'pdf') return '📕';
    if (ext === 'md' || ext === 'markdown') return '📝';
    if (ext === 'txt') return '📄';
    return '📁';
  }
  function _materialMetaLine(item, stats) {
    const parts = [];
    const typeLabel = (MATERIAL_TYPES.find((t) => t.value === (item.materialType || 'other')) || {}).label;
    if (typeLabel) parts.push(escapeHtml(typeLabel));
    if (stats && stats.exists && stats.chunks) {
      const chapterCount = stats.chapters ?? 0;
      parts.push(chapterCount > 0
        ? `<span class="cc-meta-strong">v2</span> · ${stats.chunks} 块 · ${chapterCount} 章`
        : `<span class="cc-meta-strong">v1</span> · ${stats.chunks} 块`);
      if (stats.dimension) parts.push(`${stats.dimension}维`);
    } else {
      parts.push('<span class="cc-meta-strong" style="color:#fca5a5">未向量化</span>');
    }
    if (item.extractMethod) {
      const m = { 'vision': 'Vision', 'pdf-parse': 'pdf-parse', 'windows-ocr': 'OCR' }[item.extractMethod] || item.extractMethod;
      parts.push(`📥 ${escapeHtml(m)}`);
    }
    return parts.join('<span class="cc-meta-sep">·</span>');
  }
  // 按状态决定主操作 — 只显示最可能要做的那一个
  function _primaryActionFor(item, stats) {
    if (item.status === 'failed')  return { label: '重试',   action: 'retry',   variant: 'warn' };
    if (item.status === 'pending') return { label: '重试',   action: 'retry',   variant: 'warn' };
    if (!stats || !stats.exists || !stats.chunks)
                                   return { label: '建索引', action: 'rebuild', variant: ''     };
    return { label: '预览', action: 'preview', variant: '' };
  }
  // ⋯ 菜单的所有可选动作（去掉跟主操作重复的）
  function _menuActionsFor(item, stats, primaryAction) {
    const all = [
      { id: 'preview',  icon: '👁', label: '预览资料' },
      { id: 'rebuild',  icon: '⚙',  label: '重建向量索引' },
      { id: 'vision',   icon: '✨', label: 'Vision API 提取' },
      { id: 'reparse',  icon: '🔄', label: '重新解析章节' },
      { id: 'retry',    icon: '↻',  label: '重试' },
      { id: 'divider1', divider: true },
      { id: 'delete',   icon: '🗑', label: '删除资料', danger: true },
    ];
    return all.filter((m) => {
      if (m.divider) return true;
      if (m.id === primaryAction) return false;
      if (m.id === 'reparse') {
        return stats && stats.exists && stats.chunks && (stats.chapters ?? 0) < 3 && stats.chunks > 200;
      }
      if (m.id === 'retry') return item.status === 'failed' || item.status === 'pending';
      return true;
    });
  }
  function _renderMaterialCard(item, vectorStats, opts) {
    opts = opts || {};
    const stats = vectorStats[item.id];
    const status = item.status || 'pending';
    const statusLabel = MATERIAL_STATUS_LABELS[status] || status;
    const primary = _primaryActionFor(item, stats);
    const menuActions = _menuActionsFor(item, stats, primary.action);
    const isActive = opts.activeId === item.id;
    return `
      <div class="cc-material-card${isActive ? ' active' : ''}"
           data-id="${escapeHtml(item.id)}"
           data-subject="${escapeHtml(item.subject)}"
           data-status="${escapeHtml(status)}">
        <div class="cc-material-row">
          <span class="cc-material-icon" aria-hidden="true">${_fileIconFor(item.fileName)}</span>
          <span class="cc-material-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</span>
          <span class="cc-material-actions">
            <span class="cc-chip cc-status-chip ${status}"><span class="cc-chip-dot"></span>${statusLabel}</span>
            <button class="cc-primary-action ${primary.variant}"
                    type="button"
                    data-cc-action="${primary.action}"
                    title="${escapeHtml(primary.label)}">${primary.label}</button>
            <span class="cc-menu-wrap">
              <button class="cc-icon-btn cc-menu-toggle" type="button" aria-haspopup="true" aria-expanded="false" title="更多操作">⋯</button>
              <div class="cc-menu" role="menu">
                ${menuActions.map((m) => m.divider
                  ? `<div class="cc-menu-divider"></div>`
                  : `<button class="cc-menu-item${m.danger ? ' danger' : ''}" role="menuitem" type="button" data-cc-action="${m.id}">
                       <span class="cc-menu-item-icon">${m.icon}</span><span>${m.label}</span>
                     </button>`).join('')}
              </div>
            </span>
          </span>
        </div>
        <div class="cc-material-meta">${_materialMetaLine(item, stats)}</div>
      </div>`;
  }
  // 统一的卡片事件代理 — 主操作 / 菜单切换 / 菜单项 / 卡片点击预览
  function _bindMaterialCardEvents(container, ctx) {
    container.querySelectorAll('.cc-material-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        if (event.target.closest('.cc-material-actions')) return;
        const id = card.getAttribute('data-id');
        const subject = card.getAttribute('data-subject');
        if (ctx.onCardClick) ctx.onCardClick(id, subject, card);
      });
    });
    container.querySelectorAll('[data-cc-action]').forEach((btn) => {
      if (btn.classList.contains('cc-menu-toggle')) return;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const card = btn.closest('.cc-material-card');
        if (!card) return;
        const id = card.getAttribute('data-id');
        const subject = card.getAttribute('data-subject');
        const action = btn.getAttribute('data-cc-action');
        _closeAllMaterialMenus();
        _dispatchMaterialAction(action, id, subject, card);
      });
    });
    container.querySelectorAll('.cc-menu-toggle').forEach((toggle) => {
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const menu = toggle.parentElement.querySelector('.cc-menu');
        if (!menu) return;
        const isOpen = menu.getAttribute('data-open') === 'true';
        _closeAllMaterialMenus();
        if (!isOpen) {
          menu.setAttribute('data-open', 'true');
          toggle.setAttribute('aria-expanded', 'true');
        }
      });
    });
  }
  function _closeAllMaterialMenus() {
    document.querySelectorAll('.cc-menu[data-open="true"]').forEach((m) => m.setAttribute('data-open', 'false'));
    document.querySelectorAll('.cc-menu-toggle[aria-expanded="true"]').forEach((t) => t.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.cc-menu-wrap')) _closeAllMaterialMenus();
  });
  function _dispatchMaterialAction(action, id, subject, card) {
    const fileName = card.querySelector('.cc-material-name')?.getAttribute('title') || '';
    switch (action) {
      case 'preview':
        state.selectedSubject = subject || state.selectedSubject;
        onCourseSelected();
        activateTab('learn');
        vscode.postMessage({ type: 'previewMaterial', materialId: id });
        break;
      case 'rebuild':
        vscode.postMessage({ type: 'reindexSingleMaterial', materialId: id, subject });
        addLog(`已开始向量化资料 (${subject})`, 'info');
        break;
      case 'reparse':
        vscode.postMessage({ type: 'reparseMaterialSummary', materialId: id, subject });
        addLog(`已开始重新解析章节 (${subject})`, 'info');
        break;
      case 'vision':
        vscode.postMessage({ type: 'reextractMaterialVision', materialId: id, subject });
        addLog(`已开始 Vision API 提取 (${subject})—— 5 并发约 6s/页，等几分钟`, 'info');
        break;
      case 'retry':
        vscode.postMessage({ type: 'retryMaterial', materialId: id });
        break;
      case 'delete':
        vscode.postMessage({ type: 'requestDeleteMaterial', materialId: id, fileName });
        break;
    }
  }

  function renderMaterials() {
    if (!els.materialsList) return;
    const materials = state.materials.materials || [];
    const filterBar = document.getElementById('materials-filter-bar');

    // 状态计数：pending/extracted 都归"待处理"
    const counts = { all: materials.length, pending: 0, indexed: 0, failed: 0 };
    materials.forEach((m) => {
      if (m.status === 'pending' || m.status === 'extracted') counts.pending++;
      else if (m.status === 'indexed') counts.indexed++;
      else if (m.status === 'failed') counts.failed++;
    });

    const activeFilter = state.materialsFilter || 'all';
    if (filterBar) {
      filterBar.innerHTML = [
        { id: 'all',     label: '全部' },
        { id: 'pending', label: '待处理' },
        { id: 'indexed', label: '已索引' },
        { id: 'failed',  label: '失败' },
      ].map((f) => {
        const n = counts[f.id] ?? 0;
        const active = activeFilter === f.id;
        return `<button class="cc-chip" type="button" data-filter="${f.id}" aria-pressed="${active}">${f.label}<span class="cc-chip-count">${n}</span></button>`;
      }).join('');
      filterBar.querySelectorAll('[data-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.materialsFilter = btn.getAttribute('data-filter') || 'all';
          renderMaterials();
          persist();
        });
      });
    }

    if (!materials.length) {
      els.materialsList.className = '';
      els.materialsList.innerHTML = '<p class="cc-material-empty">还没有资料 —— 在上方导入 PDF / TXT / Markdown 试试</p>';
      return;
    }

    // 按 filter 过滤
    const filtered = materials.filter((item) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'pending') return item.status === 'pending' || item.status === 'extracted';
      return item.status === activeFilter;
    });

    if (!filtered.length) {
      els.materialsList.className = '';
      const label = activeFilter === 'pending' ? '待处理' : activeFilter === 'indexed' ? '已索引' : '失败';
      els.materialsList.innerHTML = `<p class="cc-material-empty">没有"${label}"状态的资料</p>`;
      return;
    }

    // 按 subject 分组
    const grouped = {};
    filtered.forEach((item) => {
      grouped[item.subject] = grouped[item.subject] || [];
      grouped[item.subject].push(item);
    });

    const vectorStats = state.materials.vectorStats || {};
    els.materialsList.className = 'cc-material-list';
    els.materialsList.innerHTML = Object.entries(grouped).map(([subject, items]) => `
      <div class="cc-material-group">
        <div class="cc-material-group-title">${escapeHtml(subjectLabel(subject))}</div>
        ${items.map((item) => _renderMaterialCard(item, vectorStats)).join('')}
      </div>
    `).join('');

    _bindMaterialCardEvents(els.materialsList, {
      onCardClick: (id, subject) => {
        state.selectedSubject = subject || state.selectedSubject;
        onCourseSelected();
        activateTab('learn');
        vscode.postMessage({ type: 'previewMaterial', materialId: id });
      },
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

  /**
   * Adaptive Insights Panel：把 courseProfile（已经在收集的画像数据）可视化。
   * 用 state.courseProfile 渲染——若没有就不显示。
   * 数据从后端推 'courseProfile' 消息得到，per subject 缓存在 state.courseProfilesBySubject。
   */
  function renderInsights() {
    const section = document.getElementById('insights-section');
    if (!section) return;
    if (!state.selectedSubject) {
      section.classList.add('hidden');
      return;
    }
    const profile = (state.courseProfilesBySubject || {})[state.selectedSubject];
    section.classList.remove('hidden');

    const overallEl = document.getElementById('insights-overall');
    const heatmapEl = document.getElementById('insights-heatmap');
    const tagsEl = document.getElementById('insights-tags');
    const weakTagsEl = document.getElementById('insights-weakness-tags');
    const strongTagsEl = document.getElementById('insights-strength-tags');

    if (!profile || !profile.chapters || !profile.chapters.length) {
      if (overallEl) overallEl.textContent = '暂无数据 — 完成几道练习后，AI 会在这里画出你的画像';
      if (heatmapEl) heatmapEl.classList.add('hidden');
      if (tagsEl) tagsEl.classList.add('hidden');
      return;
    }

    // 总览
    const masteryNumeric = (profile.chapters || []).map((c) => c.masteryPercent).filter((x) => Number.isFinite(x));
    const overallMastery = masteryNumeric.length
      ? Math.round(masteryNumeric.reduce((a, b) => a + b, 0) / masteryNumeric.length)
      : null;
    const levelLabel = profile.overall?.learnerLevelEstimate || 'undetermined';
    const levelTranslate = { undetermined: '观察中', beginner: '入门', developing: '发展中', intermediate: '进阶' };
    if (overallEl) {
      overallEl.innerHTML = `
        <strong>${escapeHtml(profile.courseTitle || state.selectedSubject)}</strong>
        ${overallMastery !== null ? `· 总体掌握 ${overallMastery}%` : '· 总体掌握 待观察'}
        <span class="insights-level-badge">${levelTranslate[levelLabel] || levelLabel}</span>
      `;
    }

    // 章节热力图
    if (heatmapEl) {
      heatmapEl.classList.remove('hidden');
      heatmapEl.innerHTML = (profile.chapters || []).map((c) => {
        const m = c.masteryPercent;
        const masteryClass = m === null || m === undefined
          ? 'mastery-none'
          : m >= 80 ? 'mastery-high' : m >= 60 ? 'mastery-mid' : 'mastery-low';
        const inProgressClass = c.status === 'in-progress' ? 'in-progress' : '';
        const trendClass = (() => {
          const t = (c.weaknessTrend || [])[0];
          if (!t) return '';
          if (t.direction === 'improving') return 'trend-up';
          if (t.direction === 'worsening') return 'trend-down';
          return '';
        })();
        const tooltip = [
          c.title,
          m !== null && m !== undefined ? `掌握 ${m}%` : '尚未做题',
          c.gradeCount ? `已答 ${c.gradeCount} 题` : null,
          c.weaknessTags?.length ? `弱：${c.weaknessTags.join('、')}` : null,
          c.strengthTags?.length ? `强：${c.strengthTags.join('、')}` : null,
          (c.weaknessTrend || []).map((t) =>
            `${t.tag} ${Math.round(t.prevRate * 100)}%→${Math.round(t.currRate * 100)}%`,
          ).join(' · ') || null,
        ].filter(Boolean).join('\n');
        return `
          <div class="insights-chapter-cell ${masteryClass} ${inProgressClass} ${trendClass}" title="${escapeHtml(tooltip)}">
            <div class="chapter-number">${c.chapterNumber || '?'}</div>
            <div class="chapter-mastery">${m === null || m === undefined ? '—' : m + '%'}</div>
          </div>
        `;
      }).join('');
    }

    // tag 列表
    if (tagsEl && weakTagsEl && strongTagsEl) {
      const weak = (profile.overall?.commonWeaknessTags || []);
      const strong = (profile.overall?.commonStrengthTags || []);
      if (weak.length || strong.length) {
        tagsEl.classList.remove('hidden');
        weakTagsEl.innerHTML = weak.map((t) => `<span class="insights-tag-pill weakness">${escapeHtml(t)}</span>`).join(' ') || '—';
        strongTagsEl.innerHTML = strong.map((t) => `<span class="insights-tag-pill strength">${escapeHtml(t)}</span>`).join(' ') || '—';
      } else {
        tagsEl.classList.add('hidden');
      }
    }
  }

  function renderWrongQuestions() {
    if (!els.wrongQuestionsSection || !els.wrongQuestionsList) return;

    if (!state.selectedSubject) {
      els.wrongQuestionsSection.classList.add('hidden');
      return;
    }

    els.wrongQuestionsSection.classList.remove('hidden');

    const items = Array.isArray(state.wrongQuestions) ? state.wrongQuestions : [];
    if (!items.length) {
      els.wrongQuestionsList.innerHTML = '<p class="muted">暂无错题。回答练习题后，未掌握的题会出现在这里。</p>';
      els.wrongQuestionsActions?.classList.add('hidden');
      return;
    }

    const grouped = {};
    items.forEach((item) => {
      const key = item.lessonTitle || '未命名讲义';
      grouped[key] = grouped[key] || [];
      grouped[key].push(item);
    });

    els.wrongQuestionsList.innerHTML = Object.entries(grouped).map(([lessonTitle, list]) => `
      <div class="wrong-questions-group">
        <div class="wrong-questions-group-title">${escapeHtml(lessonTitle)}</div>
        <ul class="wrong-questions-list-ul">
          ${list.map((item) => {
            const text = String(item.questionText || '');
            const truncated = text.length > 100 ? `${text.slice(0, 100)}...` : text;
            const weakness = Array.isArray(item.weaknessTags) ? item.weaknessTags : [];
            const score = Number(item.score);
            return `
              <li class="wrong-question-item" data-id="${escapeHtml(item.id)}">
                <div class="wrong-question-text">${escapeHtml(truncated)}</div>
                ${weakness.length ? `<div class="wrong-question-tags">${weakness.map((tag) => `<span class="wrong-question-tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
                <div class="wrong-question-meta">
                  ${Number.isFinite(score) ? `<span class="wrong-question-score">${escapeHtml(String(score))}</span>` : ''}
                  <button class="wrong-question-resolve" type="button" data-id="${escapeHtml(item.id)}">已解决</button>
                </div>
              </li>
            `;
          }).join('')}
        </ul>
      </div>
    `).join('');

    els.wrongQuestionsActions?.classList.remove('hidden');

    els.wrongQuestionsList.querySelectorAll('.wrong-question-resolve').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!state.selectedSubject) return;
        vscode.postMessage({
          type: 'resolveWrongQuestion',
          subject: state.selectedSubject,
          questionId: button.getAttribute('data-id'),
        });
      });
    });
  }

  function requestWrongQuestions() {
    if (!state.selectedSubject) return;
    vscode.postMessage({ type: 'getWrongQuestions', subject: state.selectedSubject });
  }

  /** 草稿存储 key：按 subject + lessonId 区分。 */
  function answerDraftKey(ctx) {
    return `cc-answer-draft:${ctx.subject}:${ctx.topicId}:${ctx.lessonId}`;
  }

  function loadAnswerDraft(ctx) {
    try {
      const all = (vscode.getState() || {}).answerDrafts || {};
      return all[answerDraftKey(ctx)] || '';
    } catch { return ''; }
  }

  function saveAnswerDraft(ctx, text) {
    try {
      const cur = vscode.getState() || {};
      const drafts = { ...(cur.answerDrafts || {}) };
      const key = answerDraftKey(ctx);
      if (text && text.trim()) {
        drafts[key] = text;
      } else {
        delete drafts[key];
      }
      vscode.setState({ ...cur, answerDrafts: drafts });
    } catch { /* ignore */ }
  }

  function clearAnswerDraft(ctx) {
    saveAnswerDraft(ctx, '');
  }

  function openAnswerSubmitModal(ctx) {
    state.answerSubmitContext = ctx;
    if (els.answerSubmitLessonInfo) {
      const draft = loadAnswerDraft(ctx);
      const draftHint = draft ? '（已加载之前保存的草稿）' : '';
      els.answerSubmitLessonInfo.textContent = `当前讲义：${ctx.lessonTitle}${draftHint}`;
    }
    if (els.answerSubmitTextarea) {
      // 优先恢复草稿
      els.answerSubmitTextarea.value = loadAnswerDraft(ctx);
    }
    if (els.answerSubmitError) {
      els.answerSubmitError.classList.add('hidden');
      els.answerSubmitError.textContent = '';
    }
    els.answerSubmitModal?.classList.remove('hidden');
    els.answerSubmitModal?.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      els.answerSubmitTextarea?.focus();
      // 光标移到末尾（让用户继续在草稿后写）
      try {
        const len = els.answerSubmitTextarea?.value?.length || 0;
        els.answerSubmitTextarea?.setSelectionRange(len, len);
      } catch { /* ignore */ }
    });
  }

  function closeAnswerSubmitModal() {
    // 关闭时若有未提交内容，自动保存为草稿（用户没点保存草稿也算）
    if (state.answerSubmitContext && els.answerSubmitTextarea) {
      const text = els.answerSubmitTextarea.value || '';
      if (text.trim()) {
        saveAnswerDraft(state.answerSubmitContext, text);
      }
    }
    state.answerSubmitContext = null;
    els.answerSubmitModal?.classList.add('hidden');
    els.answerSubmitModal?.setAttribute('aria-hidden', 'true');
  }

  function parseAnswerSubmissions(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    const headerRegex = /^##\s*第?\s*(\d+)\s*题[^\n]*\n/gm;
    const parts = [];
    let match;
    let lastIndex = 0;
    let lastNumber = null;
    while ((match = headerRegex.exec(text)) !== null) {
      if (lastNumber !== null) {
        parts.push({ number: lastNumber, body: text.slice(lastIndex, match.index).trim() });
      }
      lastNumber = parseInt(match[1], 10);
      lastIndex = headerRegex.lastIndex;
    }
    if (lastNumber !== null) {
      parts.push({ number: lastNumber, body: text.slice(lastIndex).trim() });
    } else {
      parts.push({ number: 1, body: text });
    }
    return parts
      .filter((part) => part.body.length > 0)
      .map((part) => ({ exerciseId: `ex-${part.number}`, answer: part.body }));
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

  function setRadioGroup(radios, value) {
    if (!radios) return;
    radios.forEach((radio) => { radio.checked = radio.value === String(value); });
  }

  function getRadioGroup(radios) {
    if (!radios) return null;
    const checked = radios.find((r) => r.checked);
    return checked ? checked.value : null;
  }

  function renderPerSubjectDifficulty(preferences) {
    if (!els.perSubjectDifficultyList) return;
    const subjects = state.courses.map((c) => c.subject);
    if (!subjects.length) {
      els.perSubjectDifficultyList.innerHTML = '<p class="hint">尚无已知学科。生成课程后会出现在这里。</p>';
      return;
    }
    const perSubject = preferences?.difficulty?.perSubject || {};
    const globalLevel = preferences?.difficulty?.global || 'basic';
    const levels = [
      { value: 'beginner', label: '入门' },
      { value: 'basic', label: '基础' },
      { value: 'intermediate', label: '进阶' },
      { value: 'challenge', label: '挑战' },
    ];
    // 用 pill 按钮组替代 select（更紧凑、不出现下拉白底问题）
    els.perSubjectDifficultyList.innerHTML = subjects.map((subject) => {
      const level = perSubject[subject] || globalLevel;
      const pills = levels.map((lv) =>
        `<button type="button" class="difficulty-pill${lv.value === level ? ' active' : ''}" data-subject-difficulty="${escapeHtml(subject)}" data-level="${lv.value}">${lv.label}</button>`
      ).join('');
      return `
        <div class="per-subject-row" data-subject="${escapeHtml(subject)}">
          <span class="per-subject-label">${escapeHtml(subjectLabel(subject))}</span>
          <div class="difficulty-pill-group" data-subject-pills="${escapeHtml(subject)}">${pills}</div>
        </div>
      `;
    }).join('');

    els.perSubjectDifficultyList.querySelectorAll('[data-subject-difficulty]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!state.preferences) return;
        const subject = btn.getAttribute('data-subject-difficulty');
        const level = btn.getAttribute('data-level');
        state.preferences.difficulty = state.preferences.difficulty || { global: 'basic', perSubject: {}, exerciseMix: { easy: 30, medium: 50, hard: 20 } };
        state.preferences.difficulty.perSubject = state.preferences.difficulty.perSubject || {};
        state.preferences.difficulty.perSubject[subject] = level;
        // 更新同组按钮 active
        const group = btn.parentElement;
        if (group) {
          group.querySelectorAll('.difficulty-pill').forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
        }
        schedulePreferenceSave();
      });
    });
  }

  function updateMixSumHint() {
    if (!els.mixSumHint) return;
    const sum = Number(els.mixEasy?.value || 0) + Number(els.mixMedium?.value || 0) + Number(els.mixHard?.value || 0);
    if (sum === 100) {
      els.mixSumHint.textContent = '';
    } else {
      els.mixSumHint.textContent = `当前合计：${sum}%（应为 100%）`;
    }
    els.mixSumHint.classList.toggle('warn-text', sum !== 100);
    syncPresetButtonsActive('exercise-mix');
  }

  function updateExTypeSumHint() {
    if (!els.exTypeSumHint) return;
    const sum = Number(els.exTypeConcept?.value || 0) + Number(els.exTypeCalc?.value || 0) + Number(els.exTypeProof?.value || 0);
    if (sum === 100) {
      els.exTypeSumHint.textContent = '';
    } else {
      els.exTypeSumHint.textContent = `当前合计：${sum}%（应为 100%）`;
    }
    els.exTypeSumHint.classList.toggle('warn-text', sum !== 100);
    syncPresetButtonsActive('exercise-type');
  }

  /** 当前数值匹配某个预设 → 把对应按钮设 active；否则只激活"自定义"。 */
  function syncPresetButtonsActive(target) {
    const group = document.querySelector(`.preset-group[data-preset-target="${target}"]`);
    if (!group) return;
    const values = target === 'exercise-mix'
      ? [Number(els.mixEasy?.value || 0), Number(els.mixMedium?.value || 0), Number(els.mixHard?.value || 0)]
      : [Number(els.exTypeConcept?.value || 0), Number(els.exTypeCalc?.value || 0), Number(els.exTypeProof?.value || 0)];
    let matchedPreset = null;
    group.querySelectorAll('.preset-btn[data-mix]').forEach((btn) => {
      const preset = (btn.getAttribute('data-mix') || '').split(',').map(Number);
      if (preset.length === 3 && preset.every((v, i) => v === values[i])) {
        matchedPreset = btn;
      }
    });
    group.querySelectorAll('.preset-btn').forEach((btn) => {
      const isCustomToggle = btn.classList.contains('preset-custom-toggle');
      if (matchedPreset) {
        btn.classList.toggle('active', btn === matchedPreset);
      } else {
        // 没匹配任何预设 → 只激活自定义按钮
        btn.classList.toggle('active', isCustomToggle);
      }
    });
  }

  function applyPreset(target, mixStr) {
    const values = (mixStr || '').split(',').map(Number);
    if (values.length !== 3 || values.some((v) => !Number.isFinite(v))) return;
    if (target === 'exercise-mix') {
      if (els.mixEasy) els.mixEasy.value = String(values[0]);
      if (els.mixMedium) els.mixMedium.value = String(values[1]);
      if (els.mixHard) els.mixHard.value = String(values[2]);
      updateMixSumHint();
    } else if (target === 'exercise-type') {
      if (els.exTypeConcept) els.exTypeConcept.value = String(values[0]);
      if (els.exTypeCalc) els.exTypeCalc.value = String(values[1]);
      if (els.exTypeProof) els.exTypeProof.value = String(values[2]);
      updateExTypeSumHint();
    }
    schedulePreferenceSave();
  }

  function bindPresetGroups() {
    document.querySelectorAll('.preset-group').forEach((group) => {
      const target = group.getAttribute('data-preset-target');
      if (!target) return;
      group.querySelectorAll('.preset-btn').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          if (btn.classList.contains('preset-custom-toggle')) {
            // 切换自定义区显示
            const customAreaId = target === 'exercise-mix' ? 'mix-custom-area' : 'ex-type-custom-area';
            const area = document.getElementById(customAreaId);
            if (area) {
              area.classList.toggle('hidden');
              if (!area.classList.contains('hidden')) {
                // 展开后聚焦第一个 input
                area.querySelector('input')?.focus();
              }
            }
            return;
          }
          const mix = btn.getAttribute('data-mix');
          if (mix) applyPreset(target, mix);
        });
      });
    });
  }

  function renderPreferences(preferences) {
    if (!preferences) return;
    // 与默认偏好深合并，避免读取空字段
    const merged = deepMerge(deepClone(DEFAULT_PREFS), preferences);
    state.preferences = merged;

    // ===== 学习节奏与目标 =====
    if (els.prefDifficulty) els.prefDifficulty.value = merged.difficulty?.global || 'basic';
    if (els.mixEasy) els.mixEasy.value = String(merged.difficulty?.exerciseMix?.easy ?? 30);
    if (els.mixMedium) els.mixMedium.value = String(merged.difficulty?.exerciseMix?.medium ?? 50);
    if (els.mixHard) els.mixHard.value = String(merged.difficulty?.exerciseMix?.hard ?? 20);
    updateMixSumHint();
    if (els.prefExercises) els.prefExercises.value = String(merged.pace?.exercisesPerSession ?? 5);
    if (els.prefSpeed) els.prefSpeed.value = merged.pace?.speed || 'medium';
    if (els.prefReview) els.prefReview.value = String(merged.pace?.reviewEveryNLessons ?? 3);
    const dailyGoal = merged.pace?.dailyGoalMinutes ?? 45;
    if (els.prefDailyGoal) els.prefDailyGoal.value = String(dailyGoal);
    if (els.prefDailyGoalNum) els.prefDailyGoalNum.value = String(dailyGoal);

    const restDays = Array.isArray(merged.pace?.restDays) ? merged.pace.restDays.map(Number) : [];
    els.restDayCheckboxes?.forEach((cb) => {
      cb.checked = restDays.includes(Number(cb.getAttribute('data-rest-day')));
    });
    const slots = Array.isArray(merged.pace?.studyTimeSlots) ? merged.pace.studyTimeSlots : [];
    els.studySlotCheckboxes?.forEach((cb) => {
      cb.checked = slots.includes(cb.getAttribute('data-study-slot'));
    });

    renderPerSubjectDifficulty(merged);

    // ===== 语言 =====
    if (els.prefLangContent) els.prefLangContent.value = merged.language?.content || 'zh';
    if (els.prefLangExercises) els.prefLangExercises.value = merged.language?.exercises || 'zh';
    if (els.prefLangCode) els.prefLangCode.value = merged.language?.codeComments || 'zh';

    // ===== AI 风格与内容 =====
    setRadioGroup(els.aiDetailLevelRadios, merged.aiStyle?.lessonDetail || 'standard');
    setRadioGroup(els.aiFeedbackToneRadios, merged.aiStyle?.feedbackTone || 'encouraging');
    const explainStyles = Array.isArray(merged.aiStyle?.explanationStyles) ? merged.aiStyle.explanationStyles : [];
    els.explainStyleCheckboxes?.forEach((cb) => {
      cb.checked = explainStyles.includes(cb.getAttribute('data-explain-style'));
    });
    setRadioGroup(els.aiMathStyleRadios, merged.aiStyle?.mathSymbol || 'latex');
    if (els.exTypeConcept) els.exTypeConcept.value = String(merged.aiStyle?.exerciseTypeMix?.multipleChoice ?? 40);
    if (els.exTypeCalc) els.exTypeCalc.value = String(merged.aiStyle?.exerciseTypeMix?.freeResponse ?? 40);
    if (els.exTypeProof) els.exTypeProof.value = String(merged.aiStyle?.exerciseTypeMix?.code ?? 20);
    updateExTypeSumHint();
    if (els.aiIncludeProofs) els.aiIncludeProofs.checked = !!merged.aiStyle?.includeProofs;
    if (els.aiIncludeHistory) els.aiIncludeHistory.checked = !!merged.aiStyle?.includeHistory;

    // ===== 资料检索 =====
    if (els.retrievalGroundingDefault) els.retrievalGroundingDefault.checked = !!merged.retrieval?.defaultGrounding;
    setRadioGroup(els.retrievalStrictnessRadios, merged.retrieval?.strictness || 'balanced');
    if (els.retrievalCiteDefault) els.retrievalCiteDefault.checked = merged.retrieval?.citeSources !== false;
    const snippets = merged.retrieval?.maxExcerpts ?? 4;
    if (els.retrievalSnippets) els.retrievalSnippets.value = String(snippets);
    if (els.retrievalSnippetsValue) els.retrievalSnippetsValue.textContent = String(snippets);

    // Hybrid RAG embedding
    const emb = merged.retrieval?.embedding || {};
    if (els.embeddingEnabled) els.embeddingEnabled.checked = !!emb.enabled;
    _syncRagEngineCard('rag-card-embedding', 'embedding-status-chip', !!emb.enabled);
    if (els.embeddingBaseUrl) els.embeddingBaseUrl.value = emb.baseUrl || 'https://api.siliconflow.cn/v1';
    if (els.embeddingToken) els.embeddingToken.value = emb.apiToken || '';
    if (els.embeddingModel) els.embeddingModel.value = emb.model || 'BAAI/bge-m3';
    if (els.embeddingDimension) els.embeddingDimension.value = String(emb.dimension ?? 1024);
    const hw = typeof emb.hybridWeight === 'number' ? emb.hybridWeight : 0.5;
    if (els.embeddingHybridWeight) els.embeddingHybridWeight.value = String(hw);
    if (els.embeddingHybridWeightValue) els.embeddingHybridWeightValue.textContent = String(hw);

    // Vision API
    const vis = merged.retrieval?.vision || {};
    if (els.visionEnabled) els.visionEnabled.checked = !!vis.enabled;
    _syncRagEngineCard('rag-card-vision', 'vision-status-chip', !!vis.enabled);
    if (els.visionBaseUrl) els.visionBaseUrl.value = vis.baseUrl || 'https://api.siliconflow.cn/v1';
    if (els.visionToken) els.visionToken.value = vis.apiToken || '';
    if (els.visionModel) els.visionModel.value = vis.model || 'Qwen/Qwen3-VL-8B-Instruct';
    const conc = vis.concurrency ?? 5;
    if (els.visionConcurrency) els.visionConcurrency.value = String(conc);
    if (els.visionConcurrencyValue) els.visionConcurrencyValue.textContent = String(conc);
    if (els.visionDpi) els.visionDpi.value = String(vis.dpi ?? 200);

    // ===== 讲义阅读体验 =====
    setRadioGroup(els.lectureReaderModeRadios, merged.coach?.lecture?.viewerMode || 'lecture-webview');
    setRadioGroup(els.lectureApplyModeRadios, merged.coach?.lecture?.applyMode || 'preview-confirm');
    if (els.lectureSyncSource) els.lectureSyncSource.checked = merged.coach?.lecture?.syncSourceEditor !== false;
    const highlightSec = Math.round((merged.coach?.lecture?.highlightChangesMs ?? 3000) / 1000);
    if (els.lectureHighlightDuration) els.lectureHighlightDuration.value = String(highlightSec);
    if (els.lectureHighlightDurationValue) els.lectureHighlightDurationValue.textContent = `${highlightSec} 秒`;

    // ===== UI 与显示 =====
    const fontSize = merged.ui?.fontSize ?? 13;
    if (els.uiFontSize) els.uiFontSize.value = String(fontSize);
    if (els.uiFontSizeValue) els.uiFontSizeValue.textContent = `${fontSize} px`;
    applyFontScale(fontSize);  // 真正改变字体大小
    setRadioGroup(els.uiDefaultTabRadios, merged.ui?.defaultTab || 'learn');
    if (els.uiTreeDefaultExpand) els.uiTreeDefaultExpand.checked = merged.ui?.expandCourseTree !== false;
    setRadioGroup(els.uiThemeRadios, merged.ui?.theme || 'auto');
    if (els.uiShowEmoji) els.uiShowEmoji.checked = merged.ui?.showEmoji !== false;
    applyShowEmoji(merged.ui?.showEmoji !== false);
  }

  /**
   * P2-1: showEmoji=false 时隐藏 emoji。HTML 里硬编码了大量 emoji，做 CSS 控制
   * 太繁琐；改用 JS 一次性 DOM 替换：把 h3 / button / label 等头部的 emoji 字符
   * 删掉。开启时刷新页面才能恢复（用户不会频繁切换）。
   */
  function applyShowEmoji(show) {
    document.body.classList.toggle('no-emoji', !show);
    if (show) return; // 开着就什么也不做
    const EMOJI_LEAD = /^\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]+\s*/u;
    const EMOJI_INLINE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu;
    document.querySelectorAll('h1, h2, h3, h4, summary, .panel-header h3, button').forEach((el) => {
      // 只处理不含子元素的纯文本节点（避免破坏内联结构）
      const child = el.firstChild;
      if (child && child.nodeType === Node.TEXT_NODE) {
        const stripped = (child.textContent || '').replace(EMOJI_LEAD, '').replace(EMOJI_INLINE, '').trim();
        if (stripped !== child.textContent?.trim()) {
          child.textContent = stripped + (child.textContent?.endsWith(' ') ? ' ' : '');
        }
      }
    });
  }

  /**
   * 应用 fontSize 到整个 webview。基准 13px，按比例 zoom 整个 body。
   * 既影响 UI 控件，也影响渲染的 markdown 内容。
   */
  function applyFontScale(fontSize) {
    const px = Math.max(10, Math.min(28, Number(fontSize) || 13));
    const scale = px / 13;
    document.documentElement.style.setProperty('--cc-font-scale', String(scale));
    // CSS zoom 是 chromium 支持的非标准属性，让所有元素整体缩放
    document.body.style.zoom = String(scale);
  }

  // Ctrl+滚轮 调整字体大小（任何 webview 区域都生效）
  document.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const cur = Number(state.preferences?.ui?.fontSize) || 13;
    const delta = event.deltaY > 0 ? -1 : 1;
    const next = Math.max(10, Math.min(28, cur + delta));
    if (next === cur) return;
    // 同步到 prefs（debounce 保存）
    state.preferences = state.preferences || {};
    state.preferences.ui = state.preferences.ui || {};
    state.preferences.ui.fontSize = next;
    if (els.uiFontSize) els.uiFontSize.value = String(next);
    if (els.uiFontSizeValue) els.uiFontSizeValue.textContent = `${next} px`;
    applyFontScale(next);
    schedulePreferenceSave();
  }, { passive: false });

  function collectPreferences() {
    const current = state.preferences || deepClone(DEFAULT_PREFS);

    const restDays = (els.restDayCheckboxes || [])
      .filter((cb) => cb.checked)
      .map((cb) => Number(cb.getAttribute('data-rest-day')))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const studySlots = (els.studySlotCheckboxes || [])
      .filter((cb) => cb.checked)
      .map((cb) => cb.getAttribute('data-study-slot'))
      .filter(Boolean);
    const explainStyles = (els.explainStyleCheckboxes || [])
      .filter((cb) => cb.checked)
      .map((cb) => cb.getAttribute('data-explain-style'))
      .filter(Boolean);

    return {
      difficulty: {
        global: els.prefDifficulty?.value || current.difficulty?.global || 'basic',
        perSubject: current.difficulty?.perSubject || {},
        exerciseMix: {
          easy: Number(els.mixEasy?.value ?? current.difficulty?.exerciseMix?.easy ?? 30),
          medium: Number(els.mixMedium?.value ?? current.difficulty?.exerciseMix?.medium ?? 50),
          hard: Number(els.mixHard?.value ?? current.difficulty?.exerciseMix?.hard ?? 20),
        },
      },
      pace: {
        dailyGoalMinutes: Number(els.prefDailyGoalNum?.value ?? els.prefDailyGoal?.value ?? current.pace?.dailyGoalMinutes ?? 45),
        exercisesPerSession: Number(els.prefExercises?.value ?? current.pace?.exercisesPerSession ?? 5),
        speed: els.prefSpeed?.value || current.pace?.speed || 'medium',
        reviewEveryNLessons: Number(els.prefReview?.value ?? current.pace?.reviewEveryNLessons ?? 3),
        restDays,
        studyTimeSlots: studySlots,
      },
      language: {
        content: els.prefLangContent?.value || current.language?.content || 'zh',
        exercises: els.prefLangExercises?.value || current.language?.exercises || 'zh',
        codeComments: els.prefLangCode?.value || current.language?.codeComments || 'zh',
      },
      aiStyle: {
        lessonDetail: getRadioGroup(els.aiDetailLevelRadios) || current.aiStyle?.lessonDetail || 'standard',
        feedbackTone: getRadioGroup(els.aiFeedbackToneRadios) || current.aiStyle?.feedbackTone || 'encouraging',
        explanationStyles: explainStyles,
        mathSymbol: getRadioGroup(els.aiMathStyleRadios) || current.aiStyle?.mathSymbol || 'latex',
        exerciseTypeMix: {
          multipleChoice: Number(els.exTypeConcept?.value ?? 40),
          freeResponse: Number(els.exTypeCalc?.value ?? 40),
          code: Number(els.exTypeProof?.value ?? 20),
        },
        includeProofs: !!els.aiIncludeProofs?.checked,
        includeHistory: !!els.aiIncludeHistory?.checked,
      },
      retrieval: {
        defaultGrounding: !!els.retrievalGroundingDefault?.checked,
        strictness: getRadioGroup(els.retrievalStrictnessRadios) || current.retrieval?.strictness || 'balanced',
        citeSources: !!els.retrievalCiteDefault?.checked,
        maxExcerpts: Number(els.retrievalSnippets?.value ?? current.retrieval?.maxExcerpts ?? 4),
        embedding: {
          enabled: !!els.embeddingEnabled?.checked,
          baseUrl: (els.embeddingBaseUrl?.value || '').trim() || (current.retrieval?.embedding?.baseUrl ?? 'https://api.siliconflow.cn/v1'),
          apiToken: (els.embeddingToken?.value || '').trim() || (current.retrieval?.embedding?.apiToken ?? ''),
          model: (els.embeddingModel?.value || '').trim() || (current.retrieval?.embedding?.model ?? 'BAAI/bge-m3'),
          dimension: Number(els.embeddingDimension?.value ?? current.retrieval?.embedding?.dimension ?? 1024),
          hybridWeight: Number(els.embeddingHybridWeight?.value ?? current.retrieval?.embedding?.hybridWeight ?? 0.5),
        },
        vision: {
          enabled: !!els.visionEnabled?.checked,
          baseUrl: (els.visionBaseUrl?.value || '').trim() || (current.retrieval?.vision?.baseUrl ?? 'https://api.siliconflow.cn/v1'),
          apiToken: (els.visionToken?.value || '').trim() || (current.retrieval?.vision?.apiToken ?? ''),
          model: (els.visionModel?.value || '').trim() || (current.retrieval?.vision?.model ?? 'Qwen/Qwen3-VL-8B-Instruct'),
          concurrency: Number(els.visionConcurrency?.value ?? current.retrieval?.vision?.concurrency ?? 5),
          dpi: Number(els.visionDpi?.value ?? current.retrieval?.vision?.dpi ?? 200),
          maxTokens: current.retrieval?.vision?.maxTokens ?? 6000,
        },
      },
      ui: {
        fontSize: Number(els.uiFontSize?.value ?? current.ui?.fontSize ?? 13),
        defaultTab: getRadioGroup(els.uiDefaultTabRadios) || current.ui?.defaultTab || 'learn',
        expandCourseTree: !!els.uiTreeDefaultExpand?.checked,
        showEmoji: !!els.uiShowEmoji?.checked,
        theme: getRadioGroup(els.uiThemeRadios) || current.ui?.theme || 'auto',
      },
      coach: {
        lecture: {
          viewerMode: getRadioGroup(els.lectureReaderModeRadios) || current.coach?.lecture?.viewerMode || 'lecture-webview',
          applyMode: getRadioGroup(els.lectureApplyModeRadios) || current.coach?.lecture?.applyMode || 'preview-confirm',
          syncSourceEditor: !!els.lectureSyncSource?.checked,
          highlightChangesMs: Math.max(1, Number(els.lectureHighlightDuration?.value ?? 3)) * 1000,
        },
      },
    };
  }

  // ===== 偏好自动保存（debounce 300ms） + 保存状态指示 =====
  let prefsSaveTimer = null;
  function _setSaveStatus(state) {
    document.querySelectorAll('.cc-settings-savebar, .cc-save-hint').forEach((el) => {
      el.classList.remove('is-saving', 'is-saved', 'is-error');
      if (state) el.classList.add('is-' + state);
    });
    // 给 hint 文字加新文案（如果 element 是 .cc-save-hint）
    document.querySelectorAll('.cc-save-hint').forEach((el) => {
      el.textContent = state === 'saving' ? '正在保存…'
        : state === 'error' ? '保存失败'
        : '已保存';
    });
  }
  function schedulePreferenceSave() {
    if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
    // 立即显示 "saving"（让用户知道改动被捕获）
    _setSaveStatus('saving');
    prefsSaveTimer = setTimeout(() => {
      prefsSaveTimer = null;
      const preferences = collectPreferences();
      state.preferences = preferences;
      vscode.postMessage({ type: 'savePreferences', preferences });
      // 200ms 后回 "saved"（后端处理快，且 webview 没有保存确认消息，所以乐观更新）
      setTimeout(() => _setSaveStatus('saved'), 200);
    }, 300);
  }

  function resetPreferenceGroup(groupKey) {
    const current = state.preferences ? deepClone(state.preferences) : deepClone(DEFAULT_PREFS);
    if (groupKey === 'pace') {
      current.pace = deepClone(DEFAULT_PREFS.pace);
      // 同时重置 difficulty.exerciseMix（属于"练习难度分布"，与节奏组在 UI 上同组）
      current.difficulty = current.difficulty || deepClone(DEFAULT_PREFS.difficulty);
      current.difficulty.exerciseMix = deepClone(DEFAULT_PREFS.difficulty.exerciseMix);
      current.difficulty.global = DEFAULT_PREFS.difficulty.global;
    } else if (groupKey === 'aiStyle') {
      current.aiStyle = deepClone(DEFAULT_PREFS.aiStyle);
      current.language = deepClone(DEFAULT_PREFS.language);
    } else if (groupKey === 'retrieval') {
      current.retrieval = deepClone(DEFAULT_PREFS.retrieval);
    } else if (groupKey === 'lecture') {
      current.coach = current.coach || deepClone(DEFAULT_PREFS.coach);
      current.coach.lecture = deepClone(DEFAULT_PREFS.coach.lecture);
    } else if (groupKey === 'ui') {
      current.ui = deepClone(DEFAULT_PREFS.ui);
    } else if (groupKey === 'all') {
      Object.assign(current, deepClone(DEFAULT_PREFS));
    }
    state.preferences = current;
    renderPreferences(current);
    vscode.postMessage({ type: 'savePreferences', preferences: current });
    addLog(`已恢复默认设置：${groupKey}`, 'info');
  }

  // ===== AI Profile 列表渲染 =====
  /**
   * v2 设置页：渲染 chip nav + 切换激活 section
   * - 没有 AI Profile / 没有 active profile → 默认打开 "AI Profile" section
   * - 已配置 → 默认打开 "节奏" section（最常用入口）
   * 用户手动切过 chip 之后，state.settingsActiveSection 记忆选择，刷新不重置。
   */
  function renderSettingsNav() {
    const nav = document.getElementById('settings-nav');
    if (!nav) return;
    const allSections = Array.from(document.querySelectorAll('.cc-settings-section'));
    if (!allSections.length) return;

    // 决定默认一级 cluster
    if (!state.settingsActiveCluster) {
      const profiles = Array.isArray(state.aiProfiles) ? state.aiProfiles : [];
      const hasActive = profiles.length > 0 && state.activeProfileId;
      // 没配过 AI 的话默认跳到系统簇让用户先配 Profile；否则学习簇
      state.settingsActiveCluster = hasActive ? 'learn' : 'system';
    }
    // 按当前 cluster 过滤
    const sections = allSections.filter((sec) =>
      (sec.getAttribute('data-cluster') || 'learn') === state.settingsActiveCluster
    );

    // 决定默认 active section（必须在当前 cluster 内）
    const validSectionIds = sections.map((s) => s.getAttribute('data-section'));
    if (!state.settingsActiveSection || !validSectionIds.includes(state.settingsActiveSection)) {
      state.settingsActiveSection = validSectionIds[0] || null;
    }

    // 同步一级 segmented 的 aria-pressed
    document.querySelectorAll('#settings-cluster-nav [data-cluster]').forEach((btn) => {
      const c = btn.getAttribute('data-cluster');
      btn.setAttribute('aria-pressed', c === state.settingsActiveCluster ? 'true' : 'false');
    });

    // 渲染二级 chip（只渲染当前 cluster 内的）
    nav.innerHTML = sections.map((sec) => {
      const id = sec.getAttribute('data-section');
      const label = sec.getAttribute('data-section-title') || id;
      const active = id === state.settingsActiveSection;
      return `<button class="cc-chip" type="button" data-settings-nav="${escapeHtml(id)}" aria-pressed="${active}" title="${escapeHtml(sec.getAttribute('data-section-sub') || '')}">${escapeHtml(label)}</button>`;
    }).join('');

    // 同步 section 的可见性 + active 状态：当前 cluster 外的 section 隐藏
    allSections.forEach((sec) => {
      const id = sec.getAttribute('data-section');
      const inCluster = (sec.getAttribute('data-cluster') || 'learn') === state.settingsActiveCluster;
      sec.style.display = inCluster ? '' : 'none';
      sec.setAttribute('data-active', (inCluster && id === state.settingsActiveSection) ? 'true' : 'false');
    });

    // 绑定 chip click
    nav.querySelectorAll('[data-settings-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const newSection = btn.getAttribute('data-settings-nav');
        // 离开 aiConfig 时自动关闭编辑器子页，避免回来时还停留在编辑态
        if (state.settingsActiveSection === 'aiConfig' && newSection !== 'aiConfig') {
          try { closeAIProfileEditor(); } catch {}
        }
        state.settingsActiveSection = newSection;
        renderSettingsNav();
        persist();
        // 切 section 后清空搜索（语义重置 + 避免 "搜出空" 的迷惑）
        if (els.settingsSearch && els.settingsSearch.value) {
          els.settingsSearch.value = '';
          document.querySelectorAll('.setting-row').forEach((row) => {
            row.classList.remove('hidden');
            row.classList.remove('hl');
          });
        }
      });
    });

    // 一级 cluster segmented 按钮的 click（用 dataset.bound 防重复绑）
    const clusterNav = document.getElementById('settings-cluster-nav');
    if (clusterNav && !clusterNav.dataset.bound) {
      clusterNav.dataset.bound = '1';
      clusterNav.querySelectorAll('[data-cluster]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const c = btn.getAttribute('data-cluster');
          if (!c || c === state.settingsActiveCluster) return;
          state.settingsActiveCluster = c;
          // 切簇时清掉旧 section（让 renderSettingsNav 自动跳到新簇的第一个）
          state.settingsActiveSection = null;
          renderSettingsNav();
          persist();
        });
      });
    }
  }
  // 兼容旧调用点
  function applyDefaultSettingsOpen() {
    renderSettingsNav();
  }

  /**
   * P1-2: 关键按钮根据"前置条件是否满足"显示 disabled 状态。
   * 不只看活跃任务（updateTaskBlockedState 已处理），还看：
   *   - 没 AI profile → 凡是要调 AI 的全 disabled
   *   - 没选学科 → 凡是要 subject 的 disabled
   * tooltip 提示用户为什么不能点
   */
  function applyDisabledStates() {
    const profiles = Array.isArray(state.aiProfiles) ? state.aiProfiles : [];
    const hasActiveAI = profiles.length > 0 && state.activeProfileId;
    const hasSubject = !!state.selectedSubject;

    const setDisabled = (el, why) => {
      if (!el) return;
      if (why) {
        el.setAttribute('disabled', 'true');
        el.setAttribute('title', why);
        el.classList.add('disabled-by-state');
      } else {
        el.removeAttribute('disabled');
        // 不能 removeAttribute('title') 直接清掉用户原本设置的 title — 仅在 disabled-by-state 时改
        if (el.classList.contains('disabled-by-state')) {
          const original = el.dataset.originalTitle;
          if (typeof original === 'string') {
            el.setAttribute('title', original);
          } else {
            el.removeAttribute('title');
          }
        }
        el.classList.remove('disabled-by-state');
      }
    };

    // 需要 AI 的按钮
    [
      els.btnGenerateCourse,
      els.btnDiagnosis,
      els.btnChatRebuildOutline,
      els.btnOutlineRebuildPreview,
    ].forEach((btn) => setDisabled(btn, hasActiveAI ? null : '请先在设置 → AI 配置中心 配置 AI Profile'));

    // 需要选学科的按钮
    [
      els.btnDiagnosis,
      els.btnImportCourseMaterial,
    ].forEach((btn) => setDisabled(btn, hasSubject ? null : '请先选择课程'));

    // 重建向量索引：需要选学科 + embedding 已启用
    if (els.btnReindexVectors) {
      const embeddingOn = state.preferences?.retrieval?.embedding?.enabled === true;
      if (!hasSubject) setDisabled(els.btnReindexVectors, '请先选择课程');
      else if (!embeddingOn) setDisabled(els.btnReindexVectors, '请先启用向量检索');
      else setDisabled(els.btnReindexVectors, null);
    }
  }

  /**
   * P1-1: 首次使用 onboarding 引导。规则：
   * - 用户已主动 dismiss（localStorage 记一次性 flag） → 永不再显示
   * - 已配置 AI + 有课程 + 有讲义 → 隐藏（说明已经上手）
   * - 否则按当前进度高亮 next step
   */
  function applyOnboardingState() {
    if (!els.onboardingCard) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem('cc.onboarding.dismissed') === '1'; } catch {}
    const profiles = Array.isArray(state.aiProfiles) ? state.aiProfiles : [];
    const hasActiveAI = profiles.length > 0 && state.activeProfileId;
    const courses = Array.isArray(state.courses) ? state.courses : [];
    const hasCourse = courses.length > 0;
    const materials = (state.materials?.materials || []).length > 0;
    const hasLesson = courses.some((c) => (c.topics || []).some(
      (t) => (t.lessons || []).some((l) => l.status && l.status !== 'not-started'),
    ));

    // 全部完成 OR 用户 dismiss → 隐藏
    if (dismissed || (hasActiveAI && hasCourse && hasLesson)) {
      els.onboardingCard.classList.add('hidden');
      return;
    }
    // 否则显示，标记完成步骤
    els.onboardingCard.classList.remove('hidden');
    if (els.onboardingStepAi) els.onboardingStepAi.classList.toggle('done', !!hasActiveAI);
    if (els.onboardingStepCourse) els.onboardingStepCourse.classList.toggle('done', !!hasCourse);
    if (els.onboardingStepMaterial) els.onboardingStepMaterial.classList.toggle('done', !!materials);
    if (els.onboardingStepLesson) els.onboardingStepLesson.classList.toggle('done', !!hasLesson);
  }

  /**
   * AI Provider 预设库（前端内置，仅用于预填新建表单，不改变数据结构）。
   * 对照 cc-switch 的 preset 网格交互：选一个预设 → 自动填好 baseUrl/model/context，
   * 用户只需填 name + token。最后一个 "custom" 不预填，走完整手填流程。
   */
  const AI_PROVIDER_PRESETS = [
    { id: 'openai', label: 'OpenAI', icon: '🌐', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', contextWindow: 128000, maxTokens: 4096, hint: '官方 ChatGPT 接口' },
    { id: 'anthropic', label: 'Anthropic', icon: '🅰️', provider: 'anthropic', anthropicBaseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', contextWindow: 200000, maxTokens: 8192, hint: 'Claude 官方 API' },
    { id: 'claude_code_cli', label: 'Claude Code CLI', icon: '💻', provider: 'claude_code_cli', model: 'claude-sonnet-4-5', contextWindow: 200000, maxTokens: 8192, hint: '本机 claude 命令，无需 Token' },
    { id: 'deepseek', label: 'DeepSeek', icon: '🐋', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', contextWindow: 64000, maxTokens: 4096, hint: '深度求索' },
    { id: 'openrouter', label: 'OpenRouter', icon: '🔀', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet', contextWindow: 200000, maxTokens: 4096, hint: '聚合多模型中转' },
    { id: 'siliconflow', label: 'SiliconFlow', icon: '⚡', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', contextWindow: 64000, maxTokens: 4096, hint: '硅基流动' },
    { id: 'custom', label: '自定义', icon: '⚙️', provider: 'openai', hint: '手动填写全部字段' },
  ];

  function providerLabel(provider) {
    if (provider === 'claude_code_cli') return 'Claude Code CLI';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'openai') return 'OpenAI / 兼容';
    return provider || '-';
  }

  function sourceLabel(source) {
    return {
      manual: '手动',
      claude: '.claude',
      codex: '.codex',
      package: '配置包',
    }[source] || source || '-';
  }

  function formatTokenNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '-';
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  function profileEndpoint(profile) {
    if (profile.provider === 'claude_code_cli') return '本机 claude 命令';
    if (profile.provider === 'anthropic') return profile.anthropicBaseUrl || 'https://api.anthropic.com';
    return profile.baseUrl || 'https://api.openai.com/v1';
  }

  function renderAIProfiles() {
    if (!els.aiProfilesList) return;
    const profiles = Array.isArray(state.aiProfiles) ? state.aiProfiles : [];
    if (els.aiProfileCount) {
      const active = profiles.find((p) => p.id === state.activeProfileId);
      els.aiProfileCount.textContent = profiles.length
        ? `${profiles.length} 个配置 · 当前 ${active?.name || '未选择'}`
        : '还没有配置';
    }
    if (!profiles.length) {
      els.aiProfilesList.innerHTML = '<div class="ds-card ai-empty-card"><p class="muted">还没有 AI Profile，先新建一个或从 .codex / .claude 导入。</p></div>';
    } else {
      els.aiProfilesList.innerHTML = profiles.map((profile) => {
        const isActive = profile.id === state.activeProfileId;
        const tokenOk = profile.provider === 'claude_code_cli' || !!profile.apiToken;
        const endpoint = profileEndpoint(profile);
        const source = sourceLabel(profile.source);
        return `
          <article class="ds-card${isActive ? ' ds-card--active ai-profile-card--active' : ''} ai-profile-card" data-profile-id="${escapeHtml(profile.id)}" data-card-action="activate" role="button" tabindex="0" aria-label="激活 ${escapeHtml(profile.name || 'Profile')}">
            <div class="ds-card__header">
              <div class="ds-card__title ai-profile-title">
                <span class="ds-truncate">${escapeHtml(profile.name || '未命名')}</span>
                ${isActive ? '<span class="ds-status-chip ds-status-chip--on"><span class="ds-status-dot"></span>激活中</span>' : ''}
              </div>
              <div class="ds-card__actions">
                <button class="ds-btn ds-btn--icon" type="button" data-action="edit" data-profile-id="${escapeHtml(profile.id)}" title="编辑" aria-label="编辑 Profile">✎</button>
                <button class="ds-btn ds-btn--icon" type="button" data-action="profile-menu" data-profile-id="${escapeHtml(profile.id)}" title="更多操作（复制 / 测试 / 导出 / 删除）" aria-haspopup="true" aria-label="更多操作">⋯</button>
              </div>
            </div>
            <div class="ai-profile-flags">
              <span class="ai-profile-meta__provider">${escapeHtml(providerLabel(profile.provider))}</span>
              <span class="pill ${tokenOk ? 'success' : 'danger'}">${tokenOk ? 'Token OK' : '缺少 Token'}</span>
              <span class="pill">${escapeHtml(source)}</span>
            </div>
            <div class="ai-profile-detail-grid">
              <div>
                <span class="stat-label">Model</span>
                <span class="stat-value mono ds-truncate" title="${escapeHtml(profile.model || '')}">${escapeHtml(profile.model || '-')}</span>
              </div>
              <div>
                <span class="stat-label">Context / Max</span>
                <span class="stat-value mono">${escapeHtml(formatTokenNumber(profile.contextWindow))} / ${escapeHtml(formatTokenNumber(profile.maxTokens))}</span>
              </div>
              <div class="ai-profile-detail-wide">
                <span class="stat-label">Endpoint</span>
                <span class="stat-value mono ds-truncate" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</span>
              </div>
            </div>
            <!-- 测试连通性 / 其他操作的就近反馈区（默认隐藏，测试时显示）-->
            <div class="ds-feedback hidden" data-profile-feedback="${escapeHtml(profile.id)}" role="status" aria-live="polite">
              <span class="ds-feedback__icon"></span>
              <div class="ds-feedback__body"></div>
            </div>
          </article>
        `;
      }).join('');

      // 整卡点击 = 激活（点击编辑/⋯按钮不触发，按钮 handler 会 stopPropagation；这里再加一道兜底）
      els.aiProfilesList.querySelectorAll('[data-card-action="activate"]').forEach((card) => {
        const activateCard = () => {
          const profileId = card.getAttribute('data-profile-id');
          const profile = state.aiProfiles.find((p) => p.id === profileId);
          if (!profile) return;
          if (profile.id === state.activeProfileId) return;
          handleAIProfileAction('activate', profile);
        };
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-action]')) return;
          activateCard();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); activateCard(); }
        });
      });

      els.aiProfilesList.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const action = btn.getAttribute('data-action');
          const profileId = btn.getAttribute('data-profile-id');
          const profile = state.aiProfiles.find((p) => p.id === profileId);
          if (!profile) return;
          if (action === 'profile-menu') {
            _openProfileMenu(btn, profile);
            return;
          }
          handleAIProfileAction(action, profile);
        });
      });
    }

    // 同步 Workspace Override 的 base profile 选项
    if (els.aiWsBaseProfile) {
      const current = state.workspaceAIOverride?.baseProfileId || '';
      els.aiWsBaseProfile.innerHTML = '<option value="">使用全局激活</option>' + profiles.map((p) =>
        `<option value="${escapeHtml(p.id)}"${p.id === current ? ' selected' : ''}>${escapeHtml(p.name || p.id)}</option>`
      ).join('');
    }
  }

  /**
   * Profile 卡片的 ⋯ 菜单：浮在按钮下方的 popover，含 4 个次要操作。
   * 全局只允许一个打开；点其他地方 / Esc 关闭。
   */
  let _profileMenuEl = null;
  function _closeProfileMenu() {
    if (_profileMenuEl) { _profileMenuEl.remove(); _profileMenuEl = null; }
  }
  function _openProfileMenu(anchorBtn, profile) {
    _closeProfileMenu();
    const el = document.createElement('div');
    el.className = 'ds-profile-menu';
    el.innerHTML = [
      '<button type="button" data-act="duplicate">📋 复制 Profile</button>',
      '<button type="button" data-act="test">🔌 测试连通性</button>',
      '<button type="button" data-act="export">📤 导出</button>',
      '<button type="button" data-act="delete" class="danger">🗑 删除</button>',
    ].join('');
    document.body.appendChild(el);
    _profileMenuEl = el;
    // 定位在按钮下方右对齐
    const rect = anchorBtn.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.zIndex = '60';
    // 先放出来再测尺寸做边界裁剪
    const elRect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - elRect.width, window.innerWidth - elRect.width - 8));
    const top = Math.min(rect.bottom + 4, window.innerHeight - elRect.height - 8);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    // 按钮 click
    el.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      _closeProfileMenu();
      handleAIProfileAction(act, profile);
    });
    // 点外部 / Esc 关菜单
    setTimeout(() => {
      const onDoc = (ev) => {
        if (!_profileMenuEl) return;
        if (_profileMenuEl.contains(ev.target)) return;
        _closeProfileMenu();
        document.removeEventListener('mousedown', onDoc);
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (ev) => { if (ev.key === 'Escape') { _closeProfileMenu(); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  function handleAIProfileAction(action, profile) {
    if (action === 'activate') {
      vscode.postMessage({ type: 'activateAIProfile', profileId: profile.id });
      return;
    }
    if (action === 'edit') {
      openAIProfileEditor(profile);
      return;
    }
    if (action === 'duplicate') {
      vscode.postMessage({ type: 'duplicateAIProfile', profileId: profile.id });
      return;
    }
    if (action === 'test') {
      vscode.postMessage({ type: 'testAIProfile', profile });
      addLog(`正在测试 AI Profile：${profile.name}`, 'info');
      // 就近反馈：在对应 profile 卡内渲染 pending 状态（pending 不自动隐藏，等结果回来覆盖）
      state.testingProfileId = profile.id;
      state.testingProfileName = profile.name || 'Profile';
      renderProfileFeedback(profile.id, 'pending', `正在测试 ${profile.name || ''} 的连通性…`);
      return;
    }
    if (action === 'export') {
      // 后端会弹 QuickPick 让用户选择是否含 token
      vscode.postMessage({ type: 'exportAIProfile', profileId: profile.id });
      return;
    }
    if (action === 'delete') {
      // 后端会弹原生 confirm（webview 的 window.confirm 在 VS Code 里不工作）
      vscode.postMessage({ type: 'deleteAIProfile', profileId: profile.id, profileName: profile.name });
      return;
    }
  }

  function normalizeAIProvider(value) {
    if (value === 'claude_code_cli' || value === 'anthropic' || value === 'openai') return value;
    return 'openai';
  }

  function syncAIProfileProviderFields() {
    const provider = normalizeAIProvider(els.aiProfileProvider?.value || 'openai');
    if (els.aiProfileProvider && els.aiProfileProvider.value !== provider) {
      els.aiProfileProvider.value = provider;
    }

    const isClaudeCli = provider === 'claude_code_cli';
    const isAnthropic = provider === 'anthropic';
    const isOpenAI = provider === 'openai';
    document.querySelectorAll('[data-ai-base-url-row]').forEach((row) => {
      row.classList.toggle('hidden', !isOpenAI);
    });
    document.querySelectorAll('[data-ai-anthropic-url-row]').forEach((row) => {
      row.classList.toggle('hidden', !isAnthropic);
    });
    document.querySelectorAll('[data-ai-token-row]').forEach((row) => {
      row.classList.toggle('hidden', isClaudeCli);
    });

    const connectionCard = document.getElementById('ai-profile-connection-card');
    connectionCard?.classList.toggle('hidden', isClaudeCli);
    document.getElementById('ai-profile-wire-api-row')?.classList.toggle('hidden', !isOpenAI);

    if (els.aiProfileBaseUrl) {
      els.aiProfileBaseUrl.placeholder = isOpenAI ? 'https://api.openai.com/v1' : '';
    }
    if (els.aiProfileAnthropicBaseUrl) {
      els.aiProfileAnthropicBaseUrl.placeholder = isAnthropic ? 'https://api.anthropic.com' : '';
    }
    if (els.aiProfileToken) {
      els.aiProfileToken.placeholder = isAnthropic ? 'ANTHROPIC_API_KEY' : 'sk-...';
    }
  }

  function openAIProfileEditor(profile) {
    state.editingProfileId = profile?.id || null;
    // 打开弹窗
    if (els.aiProfileEditor) {
      els.aiProfileEditor.classList.remove('hidden');
      els.aiProfileEditor.setAttribute('aria-hidden', 'false');
    }
    if (els.aiProfileEditorTitle) els.aiProfileEditorTitle.textContent = profile ? `编辑：${profile.name || ''}` : '新建 Profile';
    if (els.aiProfileName) els.aiProfileName.value = profile?.name || '';
    const provider = normalizeAIProvider(profile?.provider || 'openai');
    if (els.aiProfileProvider) els.aiProfileProvider.value = provider;
    if (els.aiProfileBaseUrl) els.aiProfileBaseUrl.value = profile?.baseUrl || (provider === 'openai' ? 'https://api.openai.com/v1' : '');
    if (els.aiProfileAnthropicBaseUrl) els.aiProfileAnthropicBaseUrl.value = profile?.anthropicBaseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : '');
    if (els.aiProfileToken) els.aiProfileToken.value = profile?.apiToken || '';
    if (els.aiProfileModel) els.aiProfileModel.value = profile?.model || '';
    if (els.aiProfileWireApi) els.aiProfileWireApi.value = profile?.wireApi || 'chat_completions';
    if (els.aiProfileContextWindow) els.aiProfileContextWindow.value = profile?.contextWindow ? String(profile.contextWindow) : '';
    if (els.aiProfileMaxTokens) els.aiProfileMaxTokens.value = profile?.maxTokens ? String(profile.maxTokens) : '';
    if (els.aiProfileReasoningEffort) els.aiProfileReasoningEffort.value = profile?.reasoningEffort || '';
    if (els.aiProfileNotes) els.aiProfileNotes.value = profile?.notes || '';
    if (els.aiProfileDraftFeedback) els.aiProfileDraftFeedback.classList.add('hidden');
    syncAIProfileProviderFields();
    // 渲染预设网格，编辑时高亮匹配的预设
    renderAIPresetGrid(profile);
    // 弹窗滚到顶
    requestAnimationFrame(() => {
      const panel = els.aiProfileEditor?.querySelector('.modal-panel');
      if (panel) panel.scrollTop = 0;
    });
  }

  function closeAIProfileEditor() {
    state.editingProfileId = null;
    if (els.aiProfileEditor) {
      els.aiProfileEditor.classList.add('hidden');
      els.aiProfileEditor.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * 渲染 Provider 预设网格（仿 cc-switch 的 preset 选择）。
   * 编辑现有 profile 时，按 provider+baseUrl 匹配高亮；都不匹配则高亮"自定义"。
   * 新建时不高亮任何预设（等用户选）。
   */
  function renderAIPresetGrid(profile) {
    const grid = els.aiPresetGrid;
    if (!grid) return;
    const currentProvider = normalizeAIProvider(profile?.provider);
    const currentBaseUrl = (profile?.baseUrl || '').trim();
    const currentAnthropicUrl = (profile?.anthropicBaseUrl || '').trim();
    let matchedId = '';
    if (profile) {
      matchedId = 'custom';
      for (const p of AI_PROVIDER_PRESETS) {
        if (p.id === 'custom') continue;
        if (p.provider !== currentProvider) continue;
        if (p.provider === 'openai' && p.baseUrl && p.baseUrl === currentBaseUrl) { matchedId = p.id; break; }
        if (p.provider === 'anthropic' && p.anthropicBaseUrl && p.anthropicBaseUrl === currentAnthropicUrl) { matchedId = p.id; break; }
        if (p.provider === 'claude_code_cli') { matchedId = p.id; break; }
      }
    }
    grid.innerHTML = AI_PROVIDER_PRESETS.map((p) => {
      const selected = p.id === matchedId;
      return `
        <button type="button" class="ai-preset-card${selected ? ' selected' : ''}" data-preset-id="${escapeHtml(p.id)}">
          <span class="ai-preset-card__icon" aria-hidden="true">${p.icon || ''}</span>
          <span class="ai-preset-card__label">${escapeHtml(p.label)}</span>
          ${p.hint ? `<span class="ai-preset-card__hint">${escapeHtml(p.hint)}</span>` : ''}
        </button>
      `;
    }).join('');
    grid.querySelectorAll('[data-preset-id]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        selectAIPreset(btn.getAttribute('data-preset-id'));
      });
    });
  }

  /**
   * 选预设 → 预填表单（保留 name/token/notes，覆盖连接与模型字段）。
   * custom 不预填，仅切 provider 为 openai 让用户手填。
   */
  function selectAIPreset(presetId) {
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    els.aiPresetGrid?.querySelectorAll('[data-preset-id]').forEach((btn) => {
      btn.classList.toggle('selected', btn.getAttribute('data-preset-id') === presetId);
    });
    if (preset.id !== 'custom') {
      if (els.aiProfileProvider) els.aiProfileProvider.value = normalizeAIProvider(preset.provider);
      if (preset.baseUrl !== undefined && els.aiProfileBaseUrl) els.aiProfileBaseUrl.value = preset.baseUrl;
      if (preset.anthropicBaseUrl !== undefined && els.aiProfileAnthropicBaseUrl) els.aiProfileAnthropicBaseUrl.value = preset.anthropicBaseUrl;
      if (els.aiProfileModel) els.aiProfileModel.value = preset.model || '';
      if (els.aiProfileContextWindow) els.aiProfileContextWindow.value = preset.contextWindow ? String(preset.contextWindow) : '';
      if (els.aiProfileMaxTokens) els.aiProfileMaxTokens.value = preset.maxTokens ? String(preset.maxTokens) : '';
    }
    syncAIProfileProviderFields();
  }

  function collectAIProfileForm() {
    const provider = normalizeAIProvider(els.aiProfileProvider?.value || 'openai');
    const baseUrl = (els.aiProfileBaseUrl?.value || '').trim();
    const anthropicBaseUrl = (els.aiProfileAnthropicBaseUrl?.value || '').trim();
    const profile = {
      name: (els.aiProfileName?.value || '').trim(),
      provider,
      baseUrl: provider === 'openai' ? (baseUrl || 'https://api.openai.com/v1') : baseUrl,
      anthropicBaseUrl: provider === 'anthropic' ? (anthropicBaseUrl || 'https://api.anthropic.com') : (anthropicBaseUrl || 'https://api.anthropic.com'),
      apiToken: provider === 'claude_code_cli' ? '' : (els.aiProfileToken?.value || ''),
      model: (els.aiProfileModel?.value || '').trim(),
      wireApi: provider === 'openai' ? (els.aiProfileWireApi?.value || 'chat_completions') : 'chat_completions',
      contextWindow: els.aiProfileContextWindow?.value ? Number(els.aiProfileContextWindow.value) : undefined,
      maxTokens: els.aiProfileMaxTokens?.value ? Number(els.aiProfileMaxTokens.value) : undefined,
      reasoningEffort: els.aiProfileReasoningEffort?.value || undefined,
      notes: (els.aiProfileNotes?.value || '').trim() || undefined,
    };
    if (state.editingProfileId) profile.id = state.editingProfileId;
    return profile;
  }

  /** 同步 RAG 引擎卡片的激活态：徽章 on/off + body 显隐（CSS 接管视觉）。 */
  function _syncRagEngineCard(cardId, chipId, enabled) {
    const card = document.getElementById(cardId);
    const chip = document.getElementById(chipId);
    if (card) card.setAttribute('data-engine-on', enabled ? 'true' : 'false');
    if (chip) {
      chip.classList.remove('ds-status-chip--on', 'ds-status-chip--off');
      chip.classList.add(enabled ? 'ds-status-chip--on' : 'ds-status-chip--off');
      const label = chip.querySelector('.ds-status-chip__label');
      if (label) label.textContent = enabled ? '已启用' : '未启用';
    }
  }

  // toggle 实时联动（user 拨动 toggle 立即看到 body 显隐）
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'embedding-enabled') {
      _syncRagEngineCard('rag-card-embedding', 'embedding-status-chip', !!e.target.checked);
    }
    if (e.target && e.target.id === 'vision-enabled') {
      _syncRagEngineCard('rag-card-vision', 'vision-status-chip', !!e.target.checked);
    }
  });

  /**
   * 渲染 AI Profile 卡内的就近反馈（点测试连通性等场景）。
   * profileId 标识哪张卡；state = 'pending'|'success'|'error'；message 显示文字。
   * autoHideMs > 0 会自动隐藏（success/error 用，pending 不用）。
   */
  function renderProfileFeedback(profileId, state, message, autoHideMs) {
    if (!profileId) return;
    const fb = document.querySelector(`[data-profile-feedback="${CSS.escape(profileId)}"]`);
    if (!fb) return;
    fb.classList.remove('hidden', 'ds-feedback--success', 'ds-feedback--error', 'ds-feedback--pending');
    fb.classList.add('ds-feedback--' + state);
    const icon = fb.querySelector('.ds-feedback__icon');
    const body = fb.querySelector('.ds-feedback__body');
    if (icon) {
      icon.innerHTML = '';
      icon.textContent = state === 'success' ? '✓' : state === 'error' ? '✗' : '';
      if (state === 'pending') icon.innerHTML = '<i></i>';
    }
    if (body) body.textContent = message || '';
    // 滚动到可见区，让用户立即看到（profile 卡可能在 viewport 外）
    requestAnimationFrame(() => {
      fb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    if (autoHideMs && autoHideMs > 0) {
      // 取消上一个 timer（同一张卡反复触发时）
      if (fb._hideTimer) clearTimeout(fb._hideTimer);
      fb._hideTimer = setTimeout(() => {
        fb.classList.add('hidden');
        fb._hideTimer = null;
      }, autoHideMs);
    }
  }

  function renderDraftProfileFeedback(state, message) {
    const fb = els.aiProfileDraftFeedback;
    if (!fb) return;
    fb.classList.remove('hidden', 'ds-feedback--success', 'ds-feedback--error', 'ds-feedback--pending');
    fb.classList.add('ds-feedback--' + state);
    const icon = fb.querySelector('.ds-feedback__icon');
    const body = fb.querySelector('.ds-feedback__body');
    if (icon) {
      icon.innerHTML = '';
      icon.textContent = state === 'success' ? '✓' : state === 'error' ? '✗' : '';
      if (state === 'pending') icon.innerHTML = '<i></i>';
    }
    if (body) body.textContent = message || '';
  }

  /** 渲染 Embedding 测试结果到 .ds-feedback 卡（替代原来的内联 span 文本）。 */
  function renderEmbeddingTestFeedback(state, message) {
    const feedback = document.getElementById('embedding-test-feedback');
    if (!feedback) return;
    feedback.classList.remove('hidden', 'ds-feedback--success', 'ds-feedback--error', 'ds-feedback--pending');
    feedback.classList.add('ds-feedback--' + state);
    const icon = feedback.querySelector('.ds-feedback__icon');
    const body = feedback.querySelector('.ds-feedback__body');
    if (icon) {
      icon.innerHTML = '';
      icon.textContent = state === 'success' ? '✓' : state === 'error' ? '✗' : '';
      if (state === 'pending') {
        // 加 3 个 dot-pulse 的 <i>
        icon.innerHTML = '<i></i>';
      }
    }
    if (body) body.textContent = message || (state === 'pending' ? '正在测试连通性…' : '');
    // 滚动到可见区，让用户立即看到（embedding 卡可能在 viewport 外）
    requestAnimationFrame(() => {
      feedback.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function renderWorkspaceAIOverride() {
    const ov = state.workspaceAIOverride || {};
    const overrides = ov.overrides || ov;
    const enabled = !!ov.enabled;
    if (els.aiWsOverrideEnabled) els.aiWsOverrideEnabled.checked = enabled;
    if (els.aiWsBaseProfile) els.aiWsBaseProfile.value = ov.baseProfileId || '';
    if (els.aiWsProvider) els.aiWsProvider.value = overrides.providerOverride || overrides.provider || '';
    if (els.aiWsBaseUrl) els.aiWsBaseUrl.value = overrides.baseUrlOverride || overrides.baseUrl || '';
    if (els.aiWsAnthropicBaseUrl) els.aiWsAnthropicBaseUrl.value = overrides.anthropicBaseUrl || '';
    if (els.aiWsToken) els.aiWsToken.value = overrides.apiTokenOverride || overrides.apiToken || '';
    if (els.aiWsModel) els.aiWsModel.value = overrides.modelOverride || overrides.model || '';
    if (els.aiWsWireApi) els.aiWsWireApi.value = overrides.wireApi || '';
    if (els.aiWsReasoningEffort) els.aiWsReasoningEffort.value = overrides.reasoningEffort || '';
    if (els.aiWsContextWindow) els.aiWsContextWindow.value = overrides.contextWindow ? String(overrides.contextWindow) : '';
    if (els.aiWsMaxTokens) els.aiWsMaxTokens.value = overrides.maxTokens ? String(overrides.maxTokens) : '';
    // 联动 CSS：data-enabled="true" 时 fieldset 内容正常可点；false 时半透明 disabled
    const fieldset = document.getElementById('ai-workspace-override');
    if (fieldset) fieldset.setAttribute('data-enabled', enabled ? 'true' : 'false');
    // 折叠摘要：在 legend 旁显示当前覆盖状态，避免每次都要展开看
    if (els.aiWsSummary) {
      if (!enabled) {
        els.aiWsSummary.textContent = '未启用';
      } else {
        const baseName = ov.baseProfileId
          ? (state.aiProfiles.find((p) => p.id === ov.baseProfileId)?.name || '全局激活')
          : '全局激活';
        const overrideKeys = Object.keys(overrides || {}).filter((k) => overrides[k] !== undefined && overrides[k] !== '');
        els.aiWsSummary.textContent = `启用 · 基于「${baseName}」${overrideKeys.length ? ` · 覆盖 ${overrideKeys.length} 项` : ''}`;
      }
    }
  }

  // toggle 的 change 立即同步禁用态（不等保存）—— 让用户拨动 toggle 就能看到效果
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'ai-ws-override-enabled') {
      const fieldset = document.getElementById('ai-workspace-override');
      if (fieldset) fieldset.setAttribute('data-enabled', e.target.checked ? 'true' : 'false');
    }
  });

  // ===== 数据管理 - 学科选择 =====
  function syncDataSubjectSelect() {
    if (!els.dataSubjectSelect) return;
    const subjects = state.courses.map((c) => c.subject);
    if (!subjects.length) {
      els.dataSubjectSelect.innerHTML = '<option value="">无课程</option>';
      els.dataSubjectSelect.value = '';
      return;
    }
    const current = els.dataSubjectSelect.value || state.selectedSubject || subjects[0];
    els.dataSubjectSelect.innerHTML = subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(subjectLabel(s))}</option>`).join('');
    els.dataSubjectSelect.value = subjects.includes(current) ? current : subjects[0];
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
      if (els.resolvedConfigMeta) els.resolvedConfigMeta.textContent = '-';
      if (els.resolvedConfigProvider) els.resolvedConfigProvider.textContent = '-';
      if (els.resolvedConfigOrigin) els.resolvedConfigOrigin.textContent = '-';
      if (els.resolvedConfigUrl) els.resolvedConfigUrl.textContent = '-';
      if (els.resolvedConfigContext) els.resolvedConfigContext.textContent = '-';
      if (els.resolvedConfigMaxTokens) els.resolvedConfigMaxTokens.textContent = '-';
      if (els.resolvedConfigHistoryBudget) els.resolvedConfigHistoryBudget.textContent = '-';
      if (els.resolvedWarningPills) els.resolvedWarningPills.innerHTML = '';
      els.aiConfigCenter?.classList.remove('has-warnings');
      return;
    }

    const warnings = Array.isArray(config.warnings) ? config.warnings : [];
    if (els.resolvedConfigSource) {
      els.resolvedConfigSource.textContent = config.resolvedFrom === 'workspace' ? '当前生效：项目覆盖' : '当前生效：全局配置';
    }
    els.resolvedConfigName.textContent = config.profileName || config.model || '-';
    const wireApi = config.provider === 'openai' && config.wireApi ? ` · ${config.wireApi}` : '';
    if (els.resolvedConfigMeta) els.resolvedConfigMeta.textContent = `${config.model || '-'}${wireApi}`;
    if (els.resolvedConfigProvider) els.resolvedConfigProvider.textContent = providerLabel(config.provider);
    if (els.resolvedConfigUrl) els.resolvedConfigUrl.textContent = config.effectiveBaseUrl || config.baseUrl || '-';
    if (els.resolvedConfigOrigin) {
      els.resolvedConfigOrigin.textContent = config.resolvedFrom === 'workspace' || workspaceOverride?.enabled ? '项目覆盖' : '全局配置';
    }
    if (els.resolvedConfigContext) els.resolvedConfigContext.textContent = formatTokenNumber(config.contextWindow);
    if (els.resolvedConfigMaxTokens) els.resolvedConfigMaxTokens.textContent = formatTokenNumber(config.maxTokens);
    if (els.resolvedConfigHistoryBudget) els.resolvedConfigHistoryBudget.textContent = formatTokenNumber(config.availableHistoryTokens);
    els.aiConfigCenter?.classList.toggle('has-warnings', warnings.length > 0);

    if (els.resolvedWarningPills) {
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

  function renderOutlineRebuildImpact(impact) {
    if (!els.outlineRebuildImpact) return;

    if (!impact) {
      els.outlineRebuildImpact.innerHTML = '';
      return;
    }

    const cards = [
      { label: '课程标题', value: impact.titleChanged ? `${impact.oldTitle} -> ${impact.newTitle}` : impact.newTitle },
      { label: '主题数量', value: `${impact.oldTopicCount} -> ${impact.newTopicCount}` },
      { label: '替换范围', value: impact.affectedRangeLabel || '整门课程' },
      { label: '参考资料', value: impact.selectedMaterialTitles?.length ? impact.selectedMaterialTitles.join(' / ') : '未选择资料' },
      { label: '用户要求', value: impact.instruction || '未填写额外要求' },
      { label: '将清理内容', value: impact.clearedTopicTitles?.length ? impact.clearedTopicTitles.join(' / ') : '无' },
      { label: '需迁移编号', value: impact.renumberedTopicTitles?.length ? impact.renumberedTopicTitles.join(' / ') : '无' },
    ];

    els.outlineRebuildImpact.innerHTML = cards.map((card) => `
      <div class="impact-card">
        <strong>${escapeHtml(card.label)}</strong>
        <div>${escapeHtml(card.value)}</div>
      </div>
    `).join('');
  }

  function renderOutlineRebuildPreviewTree(outline) {
    if (!els.outlineRebuildPreviewTree) return;

    if (!outline?.topics?.length) {
      els.outlineRebuildPreviewTree.innerHTML = '<p class="muted">预览结果会在这里显示。</p>';
      return;
    }

    els.outlineRebuildPreviewTree.innerHTML = outline.topics.map((topic, topicIndex) => `
      <div class="preview-topic">
        <div class="preview-topic-title">${escapeHtml(formatTopicTitle(topic, topicIndex))}</div>
        <ul>
          ${(topic.lessons || []).map((lesson, lessonIndex) => `
            <li>${escapeHtml(`${topicIndex + 1}-${lessonIndex + 1} ${lesson.title}`)}<span class="muted"> / 难度 ${escapeHtml(String(lesson.difficulty || 1))}</span></li>
          `).join('')}
        </ul>
      </div>
    `).join('');
  }

  function renderOutlineRebuildModal() {
    if (!els.outlineRebuildModal) return;

    const course = state.selectedSubject ? getCourse(state.selectedSubject) : null;
    const isOpen = Boolean(state.rebuildModal.open && course);
    const selection = getOutlineRebuildSelection();
    const preview = state.rebuildModal.preview;
    const selectedMaterials = new Set(state.rebuildModal.selectedMaterialIds || []);
    const availableMaterials = getOutlineRebuildAvailableMaterials();
    const busy = state.activeTaskKeys.size > 0 || !!$('task-legacy');
    const labels = { pending: '待处理', extracted: '已提取', indexed: '已索引', failed: '失败' };

    els.outlineRebuildModal.classList.toggle('hidden', !isOpen);
    els.outlineRebuildModal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

    if (!isOpen) {
      return;
    }

    if (els.outlineRebuildInstruction && els.outlineRebuildInstruction.value !== state.rebuildModal.instruction) {
      els.outlineRebuildInstruction.value = state.rebuildModal.instruction || '';
    }
    if (els.outlineRebuildShowLibrary) {
      els.outlineRebuildShowLibrary.checked = !!state.rebuildModal.showLibrary;
    }

    els.btnOutlineRebuildModeFull?.classList.toggle('active', state.rebuildModal.mode === 'full');
    els.btnOutlineRebuildModePartial?.classList.toggle('active', state.rebuildModal.mode === 'partial');

    if (els.outlineRebuildModeHint) {
      els.outlineRebuildModeHint.textContent = state.rebuildModal.mode === 'full'
        ? '全量模式会清空整门课旧讲义和旧练习，再应用新的课程结构。'
        : '部分模式只替换连续主题选区；未选区内容会尽量保留，但后续编号可能会迁移。';
    }

    els.outlineRebuildSelectionSection?.classList.toggle('hidden', state.rebuildModal.mode !== 'partial');
    if (els.outlineRebuildSelectionStatus) {
      els.outlineRebuildSelectionStatus.textContent = describeOutlineRebuildSelection(course);
    }

    if (els.outlineRebuildTopicList) {
      els.outlineRebuildTopicList.innerHTML = (course?.topics || []).map((topic, topicIndex) => {
        const isSelected = selection && topicIndex >= selection.startIndex && topicIndex <= selection.endIndex;
        const isAnchor = Number.isInteger(state.rebuildModal.selectionAnchor) && topicIndex === state.rebuildModal.selectionAnchor;
        return `
          <button class="selection-item${isSelected ? ' selected' : ''}${isAnchor ? ' anchor' : ''}" type="button" data-outline-topic-index="${topicIndex}">
            <span class="selection-item-main">
              <span class="selection-item-title">${escapeHtml(formatTopicTitle(topic, topicIndex))}</span>
              <span class="selection-item-meta">${escapeHtml(`${(topic.lessons || []).length} 个课时`)}</span>
            </span>
          </button>
        `;
      }).join('') || '<p class="muted">当前课程还没有主题。</p>';

      els.outlineRebuildTopicList.querySelectorAll('[data-outline-topic-index]').forEach((button) => {
        button.addEventListener('click', () => {
          toggleOutlineRebuildTopic(Number(button.getAttribute('data-outline-topic-index')));
        });
      });
    }

    if (els.outlineRebuildMaterialScopeHint) {
      els.outlineRebuildMaterialScopeHint.textContent = state.rebuildModal.showLibrary
        ? '当前展示整个资料库。可跨课程选择多个参考资料。'
        : '当前展示本课程资料。未勾选任何资料时，将只基于课程结构本身重构。';
    }

    if (els.outlineRebuildMaterialList) {
      els.outlineRebuildMaterialList.innerHTML = availableMaterials.map((material) => `
        <button class="selection-item${selectedMaterials.has(material.id) ? ' selected' : ''}" type="button" data-outline-material-id="${escapeHtml(material.id)}">
          <span class="selection-item-main">
            <span class="selection-item-title">${escapeHtml(material.fileName)}</span>
            <span class="selection-item-meta">${escapeHtml(`${subjectLabel(material.subject)} / ${labels[material.status] || material.status}`)}</span>
          </span>
        </button>
      `).join('') || '<p class="muted">当前范围内没有可选资料。</p>';

      els.outlineRebuildMaterialList.querySelectorAll('[data-outline-material-id]').forEach((button) => {
        button.addEventListener('click', () => {
          toggleOutlineRebuildMaterial(button.getAttribute('data-outline-material-id'));
        });
      });
    }

    if (els.outlineRebuildPreviewStatus) {
      els.outlineRebuildPreviewStatus.textContent = state.rebuildModal.loadingPreview
        ? '正在生成预览，请稍候...'
        : state.rebuildModal.applyingPreview
          ? '正在应用重构，请稍候...'
          : preview
            ? `预览已生成：${preview.mode === 'full' ? '全量重构' : '部分重构'} / ${preview.outline.topics.length} 个主题`
            : '还没有预览。修改范围或要求后，先点击“生成预览”。';
    }

    renderOutlineRebuildImpact(preview?.impact || null);
    renderOutlineRebuildPreviewTree(preview?.outline || null);

    if (els.outlineRebuildError) {
      const hasError = Boolean(state.rebuildModal.error);
      els.outlineRebuildError.classList.toggle('hidden', !hasError);
      els.outlineRebuildError.textContent = state.rebuildModal.error || '';
    }

    if (els.btnOutlineRebuildPreview) {
      els.btnOutlineRebuildPreview.disabled = busy || (state.rebuildModal.mode === 'partial' && !selection);
    }
    if (els.btnOutlineRebuildApply) {
      els.btnOutlineRebuildApply.disabled = busy || !preview?.previewId;
    }
  }

  function onCourseSelected() {
    if (state.rebuildModal.open) {
      reconcileOutlineRebuildMaterials();
      if (state.rebuildModal.preview?.subject && state.rebuildModal.preview.subject !== state.selectedSubject) {
        clearOutlineRebuildPreview();
        resetOutlineRebuildSelection();
      }
    }
    renderCourseDropdown();
    renderSelectedCourse();
    renderCourseMaterials();
    renderMaterials();
    requestDiagnosis(false);
    renderChatContext();
    syncMaterialImportTargets();
    syncDataSubjectSelect();
    renderOutlineRebuildModal();
    renderWrongQuestions();
    renderInsights();
    refreshCourseProjectsSection();
    if (state.preferences) {
      renderPerSubjectDifficulty(state.preferences);
    }
    persist();
    requestWrongQuestions();
  }

  function activateTab(tabName) {
    els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
    els.tabContents.forEach((content) => content.classList.toggle('active', content.id === `tab-${tabName}`));
    if (tabName === 'chat') {
      scrollChatToBottom();
    }
  }

  // ===== Projects（嵌在课程面板里，按当前课程的 subject 过滤）=====

  /** 缓存所有项目元数据，rendering 时按 state.selectedSubject 过滤。 */
  state.allProjects = state.allProjects || [];

  /**
   * 扁平统一渲染：每个项目（提案 / 真项目）只显示一张卡。
   *   - 提案未落地 → 简洁提案卡（标题 + ⭐ + 描述 + 推荐技术栈 + 落地按钮）
   *   - 提案已落地 → 完整真项目卡（在标题旁带 ⭐ 难度徽章）
   *   - 手动创建（无提案）→ 完整真项目卡（无 ⭐）
   */
  function renderProjectsList() {
    const el = document.getElementById('projects-list');
    if (!el) return;
    const subject = state.selectedSubject;
    if (!subject) {
      el.innerHTML = '<p class="muted">请先选择课程。</p>';
      return;
    }

    const course = (state.courses || []).find((c) => c.subject === subject);
    const proposals = Array.isArray(course?.projects) ? course.projects : [];
    const realProjects = (state.allProjects || []).filter((m) => m.subject === subject);

    // realizedAs → real project meta 快速查表
    const realProjectById = new Map(realProjects.map((p) => [p.id, p]));
    // 哪些 real project 来自 proposal（不在这个 set 里的就是手动创建）
    const projectsFromProposal = new Set();
    for (const p of proposals) {
      if (p.realizedAs && realProjectById.has(p.realizedAs)) {
        projectsFromProposal.add(p.realizedAs);
      }
    }

    const cards = [];

    // 1) 先渲染提案（未落地 → 简洁卡；已落地 → 完整真项目卡 + ⭐ 徽章）
    for (const p of proposals) {
      const real = p.realizedAs ? realProjectById.get(p.realizedAs) : null;
      if (real) {
        cards.push(buildRealProjectCard(real, p.difficulty));
      } else {
        cards.push(buildProposalCard(p, subject));
      }
    }
    // 2) 再渲染手动创建的真项目（没在 proposal.realizedAs 链上）
    for (const real of realProjects) {
      if (projectsFromProposal.has(real.id)) continue;
      cards.push(buildRealProjectCard(real, null));
    }

    if (cards.length === 0) {
      el.innerHTML = '<p class="muted">还没有项目，点上方"＋ 新项目"创建，或先生成有 tag 的课程拿到 AI 推荐。</p>';
      return;
    }
    el.innerHTML = '';
    for (const card of cards) el.appendChild(card);
  }

  /** 未落地的提案 → 简洁卡（标题 + ⭐ + desc + suggestedTechStack + 落地按钮）。 */
  function buildProposalCard(p, subject) {
    const card = document.createElement('div');
    card.className = 'project-card proposal-pending';
    card.dataset.proposalId = p.id;
    const stars = '⭐'.repeat(Math.max(1, Math.min(5, Number(p.difficulty) || 3)));
    const stackChips = (p.suggestedTechStack || [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => `<span class="pc-stack-chip">${escapeProjHtml(s)}</span>`)
      .join('');
    card.innerHTML = `
      <div class="project-card-header">
        <p class="project-card-title">${escapeProjHtml(p.title || '')}</p>
        <span class="pc-diff" title="AI 评估的实现难度">${stars}</span>
      </div>
      <p class="project-card-desc">${escapeProjHtml(p.description || '')}</p>
      ${stackChips ? `<div class="pc-stack-row">${stackChips}</div>` : ''}
      <div class="project-card-actions">
        <button class="btn primary small" data-act="realize-proposal">落地为项目</button>
      </div>
    `;
    card.querySelector('[data-act="realize-proposal"]').addEventListener('click', () => {
      vscode.postMessage({ type: 'realizeProjectFromProposal', subject, proposalId: p.id });
    });
    return card;
  }

  /** 真项目（已落地或手动创建）→ 完整信息卡。fromProposalDifficulty 给 ⭐ 徽章用。
   *  fromProposal=true 时显示"↩ 回退到提案"按钮（手动创建的不显示）。 */
  function buildRealProjectCard(meta, fromProposalDifficulty) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.dataset.projectId = meta.id;
    const completed = meta.progress?.completedTodos ?? 0;
    const total = meta.progress?.totalTodos ?? 0;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const statusLabel = {
      'spec-pending': '生成中',
      'scaffolded': '已生成',
      'in-progress': '进行中',
      'completed': '已完成',
      'files-cleared': '已清空',
      'archived': '已归档',
    }[meta.status] || meta.status;
    const fromProposal = typeof fromProposalDifficulty === 'number';

    const techStackChips = (meta.techStack || [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => `<span class="pc-stack-chip">${escapeProjHtml(s)}</span>`)
      .join('');
    const projectDirShort = meta.projectDir
      ? meta.projectDir.split(/[/\\]/).slice(-2).join('/')
      : '';
    const starsBadge = typeof fromProposalDifficulty === 'number'
      ? `<span class="pc-diff" title="来自 AI 提案，难度 ${fromProposalDifficulty}/5">${'⭐'.repeat(Math.max(1, Math.min(5, fromProposalDifficulty)))}</span>`
      : '';

    card.innerHTML = `
      <div class="project-card-header">
        <p class="project-card-title">${escapeProjHtml(meta.title)}</p>
        <div class="pc-header-right">
          ${starsBadge}
          <span class="project-status-${meta.status} pc-status">● ${statusLabel}</span>
        </div>
      </div>
      <p class="project-card-desc">${escapeProjHtml(meta.description)}</p>
      ${techStackChips ? `<div class="pc-stack-row">${techStackChips}</div>` : ''}
      <div class="pc-info-row">
        <span class="pc-info-item" title="测试命令"><span class="pc-info-icon">⌨</span> <code>${escapeProjHtml(meta.testCommand || 'npm test')}</code></span>
        <span class="pc-info-item" title="任务进度"><span class="pc-info-icon">✓</span> ${completed} / ${total} todo</span>
      </div>
      ${projectDirShort ? `<div class="pc-info-row pc-dir-row" title="${escapeProjHtml(meta.projectDir)}"><span class="pc-info-icon">📁</span> <code>${escapeProjHtml(projectDirShort)}</code></div>` : ''}
      <div class="project-card-progress">
        <div class="project-card-progress-bar">
          <div class="project-card-progress-fill" style="width: ${pct}%"></div>
        </div>
        <span class="pc-pct">${pct}%</span>
      </div>
      <div class="project-card-actions">
        <button class="btn primary small" data-act="open">在 IDE 打开</button>
        <button class="btn ghost small" data-act="mark-done">标记完成</button>
        <button class="btn ghost small" data-act="clear-files" title="清空代码文件，保留 meta + spec，可以重新生成">🗑 删除项目文件</button>
        ${fromProposal
          ? `<button class="btn ghost small" data-act="revert-proposal" title="完全删除并退回为推荐提案，可以再次落地（用最新生成 prompt）">↩ 回退到提案</button>`
          : ''}
        <button class="btn ghost small" data-act="delete">从列表移除</button>
      </div>
    `;
    card.querySelector('[data-act="open"]').addEventListener('click', () => {
      vscode.postMessage({ type: 'openProject', projectId: meta.id });
    });
    card.querySelector('[data-act="mark-done"]').addEventListener('click', () => {
      vscode.postMessage({
        type: 'updateProjectProgress',
        projectId: meta.id,
        completedTodos: total,
        status: 'completed',
      });
    });
    card.querySelector('[data-act="clear-files"]').addEventListener('click', () => {
      vscode.postMessage({ type: 'clearProjectFiles', projectId: meta.id });
    });
    if (fromProposal) {
      card.querySelector('[data-act="revert-proposal"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'revertProjectToProposal', projectId: meta.id });
      });
    }
    card.querySelector('[data-act="delete"]').addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteProject', projectId: meta.id, purgeFiles: false });
    });
    return card;
  }

  function escapeProjHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 哪些课程类型有"项目"功能？
   * 设计决议：只有"动手做"性质的课程才需要项目训练。
   *   ✓ cs-skill        编程语言 / 框架 / 工具——必然写代码
   *   ✓ cs-theory       算法 / 系统课——可以做实现型项目
   *   ✓ engineering     工程方法 / 系统设计——必须实践
   *   ✗ math-foundation 微积分 / 线代——纸笔为主
   *   ✗ math-advanced   实分析 / 拓扑——纸笔为主
   *   ✗ physics / language / exam-prep / humanities / research — 同理
   */
  const PROJECT_ELIGIBLE_TAGS = new Set(['cs-skill', 'cs-theory', 'engineering']);

  /** 当 selectedSubject / 课程 tags 变化时，刷新项目区显隐 + 拉真项目列表。 */
  function refreshCourseProjectsSection() {
    const sec = document.getElementById('course-projects-section');
    if (!sec) return;
    if (!state.selectedSubject) {
      sec.classList.add('hidden');
      return;
    }
    const course = (state.courses || []).find((c) => c.subject === state.selectedSubject);
    const tags = Array.isArray(course?.tags) ? course.tags : [];
    const eligible = tags.some((t) => PROJECT_ELIGIBLE_TAGS.has(t));
    sec.classList.toggle('hidden', !eligible);
    if (eligible) {
      // 拉真项目列表（异步），回 'projectsList' 后会触发 renderProjectsList 重新合并
      vscode.postMessage({ type: 'listProjects' });
      // 先同步根据 state.courses 里的 outline.projects 渲染一版（已落地的会等 listProjects 回来再合并）
      renderProjectsList();
    }
  }

  // ＋ 新项目按钮：折叠/展开创建表单
  document.getElementById('btn-toggle-project-form')?.addEventListener('click', () => {
    const form = document.getElementById('course-project-form');
    if (!form) return;
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
      document.getElementById('project-prompt')?.focus();
    }
  });

  document.getElementById('btn-cancel-create-project')?.addEventListener('click', () => {
    document.getElementById('course-project-form')?.classList.add('hidden');
    const promptEl = document.getElementById('project-prompt');
    const tsEl = document.getElementById('project-techstack');
    if (promptEl) promptEl.value = '';
    if (tsEl) tsEl.value = '';
  });

  document.getElementById('btn-create-project')?.addEventListener('click', () => {
    if (!state.selectedSubject) {
      showToast('请先选择课程', 'warn');
      return;
    }
    const prompt = (document.getElementById('project-prompt').value || '').trim();
    const techStackHint = (document.getElementById('project-techstack').value || '').trim();
    if (!prompt) {
      showToast('请描述项目想法', 'warn');
      return;
    }
    const course = (state.courses || []).find((c) => c.subject === state.selectedSubject);
    vscode.postMessage({
      type: 'createProject',
      request: {
        subject: state.selectedSubject,
        prompt,
        techStackHint: techStackHint || undefined,
        linkedCourse: course ? { subject: course.subject } : undefined,
      },
    });
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  // Insights Panel 刷新
  document.getElementById('btn-insights-refresh')?.addEventListener('click', () => {
    if (!state.selectedSubject) {
      showToast('请先选择课程', 'warn');
      return;
    }
    vscode.postMessage({ type: 'getCourseProfile', subject: state.selectedSubject });
  });

  // P1-1: Onboarding 按钮
  els.btnOnboardingDismiss?.addEventListener('click', () => {
    try { localStorage.setItem('cc.onboarding.dismissed', '1'); } catch {}
    if (els.onboardingCard) els.onboardingCard.classList.add('hidden');
  });
  els.btnOnboardingGoAi?.addEventListener('click', () => {
    activateTab('settings');
    // 切到 AI 配置中心 section + 滚动到位
    state.settingsActiveSection = 'aiConfig';
    renderSettingsNav();
    const target = document.getElementById('group-ai-config');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  els.ddTrigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    els.ddMenu?.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    els.ddMenu?.classList.add('hidden');
    els.editMenu?.classList.add('hidden');
    els.aiChangeMenu?.classList.add('hidden');
    closeLessonActionMenus();
  });

  els.btnChangeAIConfig?.addEventListener('click', (event) => {
    event.stopPropagation();
    els.aiChangeMenu?.classList.toggle('hidden');
  });

  // 监听所有 [data-ai-import-source] —— 导入下拉菜单里的 .codex / .claude / 配置包
  document.querySelectorAll('[data-ai-import-source]').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      const source = item.getAttribute('data-ai-import-source');
      if (!source) return;
      els.aiChangeMenu?.classList.add('hidden');
      vscode.postMessage({ type: 'importAIProfile', source });
    });
  });

  // Token 字段的 👁 显示 / 隐藏切换
  document.getElementById('btn-toggle-ai-token')?.addEventListener('click', () => {
    const input = document.getElementById('ai-profile-token');
    if (!input) return;
    const visible = input.getAttribute('type') === 'text';
    input.setAttribute('type', visible ? 'password' : 'text');
  });

  els.subjectInput?.addEventListener('input', () => {
    setCreateCourseMode(true);
  });

  /**
   * 渲染创建新课程时的 tag chip 列表。点击 chip = 切换选中。
   * 重 render 时保留之前的选择状态。
   * 启动时会调用一次（不再等 setCreateCourseMode），所以打开扩展就能看到。
   */
  function renderNewCourseTagsChecklist() {
    const el = document.getElementById('new-course-tags-checklist');
    if (!el) return;
    const prevChecked = new Set(
      Array.from(el.querySelectorAll('.tag-chip.checked'))
        .map((chip) => chip.getAttribute('data-course-tag'))
        .filter(Boolean),
    );
    el.innerHTML = COURSE_TAGS.map((t) => {
      const checked = prevChecked.has(t.value);
      return `
        <span class="tag-chip${checked ? ' checked' : ''}" role="button" tabindex="0"
              data-course-tag="${escapeHtml(t.value)}"
              title="${escapeHtml(t.desc)}">${escapeHtml(t.label)}</span>
      `;
    }).join('');
    el.querySelectorAll('.tag-chip').forEach((chip) => {
      const toggle = () => chip.classList.toggle('checked');
      chip.addEventListener('click', toggle);
      chip.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
      });
    });
  }

  els.btnGenerateCourse?.addEventListener('click', () => {
    const subject = getDraftSubject();
    if (!subject) {
      addLog('请先填写课程名称。', 'warn');
      return;
    }
    // 收集 tags（从 chip 的 .checked class 读）
    const tagsEl = document.getElementById('new-course-tags-checklist');
    const tags = Array.from(tagsEl?.querySelectorAll('.tag-chip.checked') || [])
      .map((chip) => chip.getAttribute('data-course-tag'))
      .filter(Boolean);
    // 收集偏重风格 chips
    const emphasisEl = document.getElementById('new-course-emphasis-chips');
    const styleEmphasis = Array.from(emphasisEl?.querySelectorAll('.tag-chip.checked') || [])
      .map((chip) => chip.getAttribute('data-emphasis'))
      .filter(Boolean);
    // 收集课程设置
    const difficulty = (document.getElementById('new-course-difficulty')?.value || '').trim() || undefined;
    const learningGoal = (document.getElementById('new-course-learning-goal')?.value || '').trim() || undefined;
    const existingKnowledge = (document.getElementById('new-course-existing-knowledge')?.value || '').trim() || undefined;
    const outlineSize = (document.getElementById('new-course-outline-size')?.value || '').trim() || undefined;
    const instruction = (document.getElementById('new-course-instruction')?.value || '').trim() || undefined;

    vscode.postMessage({
      type: 'generateCourse',
      subject,
      tags: tags.length ? tags : undefined,
      difficulty,
      learningGoal,
      existingKnowledge,
      outlineSize: outlineSize || undefined,
      styleEmphasis: styleEmphasis.length ? styleEmphasis : undefined,
      instruction,
    });
  });

  // 偏重风格 chip 切换
  (function setupEmphasisChips() {
    const el = document.getElementById('new-course-emphasis-chips');
    if (!el) return;
    el.querySelectorAll('.tag-chip').forEach((chip) => {
      const toggle = () => chip.classList.toggle('checked');
      chip.addEventListener('click', toggle);
      chip.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
      });
    });
  })();

  // ===== 课程大纲 preview / refine / apply / discard 流程 =====
  state.coursePreview = state.coursePreview || null; // { previewId, subject, outline, lastRefineInstruction? }

  function renderCoursePreviewPanel() {
    const panel = document.getElementById('course-preview-panel');
    if (!panel) return;
    const cp = state.coursePreview;
    if (!cp) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    const titleEl = document.getElementById('course-preview-title');
    const metaEl = document.getElementById('course-preview-meta');
    if (titleEl) titleEl.textContent = `预览：${cp.outline.title || '（未命名）'}`;
    if (metaEl) {
      const topicCount = (cp.outline.topics || []).length;
      const lessonCount = (cp.outline.topics || []).reduce((s, t) => s + (t.lessons?.length || 0), 0);
      const projCount = (cp.outline.projects || []).length;
      const projStr = projCount ? ` · 项目 ${projCount}` : '';
      const refineStr = cp.lastRefineInstruction ? ` · 上次修订："${cp.lastRefineInstruction}"` : '';
      metaEl.textContent = `主题 ${topicCount} · 课时 ${lessonCount}${projStr}${refineStr}`;
    }

    // 渲染主题/课时树
    const treeEl = document.getElementById('course-preview-tree');
    if (treeEl) {
      treeEl.innerHTML = (cp.outline.topics || []).map((t, ti) => {
        const lessons = (t.lessons || []).map((l, li) => `
          <li class="cpt-lesson">
            <span class="cpt-lesson-num">${ti + 1}.${li + 1}</span>
            <span class="cpt-lesson-title">${escapeHtml(l.title || '')}</span>
            <span class="cpt-lesson-diff">${'⭐'.repeat(Math.max(1, Math.min(5, Number(l.difficulty) || 1)))}</span>
          </li>
        `).join('');
        return `
          <div class="cpt-topic">
            <div class="cpt-topic-head">
              <span class="cpt-topic-num">${ti + 1}.</span>
              <span class="cpt-topic-title">${escapeHtml(t.title || '')}</span>
            </div>
            <ul class="cpt-lessons">${lessons}</ul>
          </div>
        `;
      }).join('');
    }

    // 渲染项目提案
    const projEl = document.getElementById('course-preview-projects');
    if (projEl) {
      const projects = cp.outline.projects || [];
      if (projects.length === 0) {
        projEl.innerHTML = '';
        projEl.classList.add('hidden');
      } else {
        projEl.classList.remove('hidden');
        projEl.innerHTML = `
          <div class="cpp-section-title">🛠 推荐项目（应用大纲后可一键落地）</div>
          ${projects.map((p) => `
            <div class="cpp-card">
              <div class="cpp-card-head">
                <div class="cpp-card-title">${escapeHtml(p.title || '')}</div>
                <span class="cpp-card-diff">${'⭐'.repeat(Math.max(1, Math.min(5, Number(p.difficulty) || 3)))}</span>
              </div>
              <p class="cpp-card-desc">${escapeHtml(p.description || '')}</p>
              ${(p.suggestedTechStack || []).length ? `<div class="cpp-card-stack">${(p.suggestedTechStack || []).map((s) => `<span class="cpp-card-stack-pill">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
            </div>
          `).join('')}
        `;
      }
    }
  }

  function clearCoursePreview() {
    state.coursePreview = null;
    const refineInput = document.getElementById('course-preview-refine-input');
    if (refineInput) refineInput.value = '';
    renderCoursePreviewPanel();
  }

  // refine 按钮
  document.getElementById('btn-refine-course-preview')?.addEventListener('click', () => {
    if (!state.coursePreview) return;
    const refineInput = document.getElementById('course-preview-refine-input');
    const instruction = (refineInput?.value || '').trim();
    if (!instruction) {
      showToast('请填写修改建议', 'warn');
      refineInput?.focus();
      return;
    }
    vscode.postMessage({
      type: 'refineCoursePreview',
      previewId: state.coursePreview.previewId,
      instruction,
    });
  });

  // apply 按钮
  document.getElementById('btn-apply-course-preview')?.addEventListener('click', () => {
    if (!state.coursePreview) return;
    vscode.postMessage({
      type: 'applyCoursePreview',
      previewId: state.coursePreview.previewId,
    });
  });

  // discard 按钮
  document.getElementById('btn-discard-course-preview')?.addEventListener('click', () => {
    if (!state.coursePreview) return;
    vscode.postMessage({
      type: 'discardCoursePreview',
      previewId: state.coursePreview.previewId,
    });
    clearCoursePreview();
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

  els.btnRefreshWrongQuestions?.addEventListener('click', () => requestWrongQuestions());

  els.btnPracticeWrongQuestions?.addEventListener('click', () => {
    const last = state.lastOpenedLesson;
    if (!state.selectedSubject) { addLog('请先选择课程。', 'warn'); return; }
    if (!last || last.subject !== state.selectedSubject) {
      addLog('请先在课程树中点开任一课时（讲义或练习），再使用错题再练。', 'warn');
      return;
    }
    vscode.postMessage({
      type: 'practiceWrongQuestions',
      subject: state.selectedSubject,
      topicId: last.topicId,
      lessonId: last.lessonId,
      lessonTitle: last.lessonTitle,
      count: 5,
    });
  });

  // 流式难度：出 1 题（自适应）
  document.getElementById('btn-practice-adaptive-next')?.addEventListener('click', () => {
    const last = state.lastOpenedLesson;
    if (!state.selectedSubject) { addLog('请先选择课程。', 'warn'); return; }
    if (!last || last.subject !== state.selectedSubject) {
      addLog('请先在课程树中点开任一课时，再使用自适应出题。', 'warn');
      return;
    }
    vscode.postMessage({
      type: 'practiceAdaptiveNext',
      subject: state.selectedSubject,
      topicId: last.topicId,
      topicTitle: last.topicTitle || '',
      lessonId: last.lessonId,
      lessonTitle: last.lessonTitle,
      baseDifficulty: 3,
    });
  });

  els.btnCloseAnswerSubmitModal?.addEventListener('click', closeAnswerSubmitModal);
  els.btnAnswerSubmitCancel?.addEventListener('click', closeAnswerSubmitModal);
  els.answerSubmitModal?.addEventListener('click', (event) => {
    if (event.target === els.answerSubmitModal) closeAnswerSubmitModal();
  });

  els.btnAnswerSubmitConfirm?.addEventListener('click', () => {
    const ctx = state.answerSubmitContext;
    if (!ctx) { closeAnswerSubmitModal(); return; }
    const submissions = parseAnswerSubmissions(els.answerSubmitTextarea?.value);
    if (submissions.length === 0) {
      if (els.answerSubmitError) {
        els.answerSubmitError.textContent = '没有解析到任何答案。请按"## 第 N 题"格式粘贴。';
        els.answerSubmitError.classList.remove('hidden');
      }
      return;
    }
    vscode.postMessage({
      type: 'submitAllAnswers',
      subject: ctx.subject,
      topicId: ctx.topicId,
      topicTitle: ctx.topicTitle,
      lessonId: ctx.lessonId,
      lessonTitle: ctx.lessonTitle,
      answers: submissions,
    });
    // 提交成功后清掉草稿
    clearAnswerDraft(ctx);
    closeAnswerSubmitModal();
    addLog(`已提交 ${submissions.length} 道答案进入批改队列`, 'info');
  });

  els.btnAnswerSubmitSaveDraft?.addEventListener('click', () => {
    const ctx = state.answerSubmitContext;
    if (!ctx) return;
    const text = els.answerSubmitTextarea?.value || '';
    saveAnswerDraft(ctx, text);
    if (els.answerSubmitDraftStatus) {
      const stamp = new Date().toLocaleTimeString();
      els.answerSubmitDraftStatus.textContent = `✓ 草稿已保存（${stamp}）。下次打开此课时答题模态会自动恢复。`;
      setTimeout(() => {
        if (els.answerSubmitDraftStatus) els.answerSubmitDraftStatus.textContent = '';
      }, 4000);
    }
    addLog(`已保存草稿：${ctx.lessonTitle}`, 'info');
  });

  els.btnAnswerSubmitClearDraft?.addEventListener('click', () => {
    const ctx = state.answerSubmitContext;
    if (!ctx) return;
    clearAnswerDraft(ctx);
    if (els.answerSubmitTextarea) els.answerSubmitTextarea.value = '';
    if (els.answerSubmitDraftStatus) {
      els.answerSubmitDraftStatus.textContent = '✓ 草稿已清空。';
      setTimeout(() => {
        if (els.answerSubmitDraftStatus) els.answerSubmitDraftStatus.textContent = '';
      }, 3000);
    }
  });

  // textarea 输入时 debounce 300ms 自动保存草稿，防止意外丢失
  let _draftAutoSaveTimer = null;
  els.answerSubmitTextarea?.addEventListener('input', () => {
    if (_draftAutoSaveTimer) clearTimeout(_draftAutoSaveTimer);
    _draftAutoSaveTimer = setTimeout(() => {
      const ctx = state.answerSubmitContext;
      if (!ctx) return;
      saveAnswerDraft(ctx, els.answerSubmitTextarea.value || '');
      if (els.answerSubmitDraftStatus) {
        els.answerSubmitDraftStatus.textContent = '✓ 已自动保存草稿';
      }
    }, 800);
  });

  els.btnChatSend?.addEventListener('click', () => {
    const text = (els.chatInput?.value || '').trim();
    if (!text) return;
    appendChat('user', text);
    els.chatInput.value = '';
    const turnId = `turn-${Date.now()}`;
    state.lastChatTurnId = turnId;
    vscode.postMessage({
      type: 'chat',
      message: text,
      subject: state.chatGroundingMode === 'general' ? undefined : state.selectedSubject,
      mode: state.chatGroundingMode,
      materialId: state.chatGroundingMode === 'material' ? state.selectedCourseMaterialId : undefined,
      turnId,
    });
  });

  els.chatInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.btnChatSend?.click();
    }
  });

  els.btnChatRebuildOutline?.addEventListener('click', () => {
    openOutlineRebuildModal();
  });

  els.btnCloseOutlineRebuildModal?.addEventListener('click', () => {
    closeOutlineRebuildModal();
  });

  els.btnOutlineRebuildCancel?.addEventListener('click', () => {
    closeOutlineRebuildModal();
  });

  els.outlineRebuildModal?.addEventListener('click', (event) => {
    if (event.target === els.outlineRebuildModal) {
      closeOutlineRebuildModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.rebuildModal.open) {
      closeOutlineRebuildModal();
    }
    if (event.key === 'Escape' && !els.answerSubmitModal?.classList.contains('hidden')) {
      closeAnswerSubmitModal();
    }
  });

  els.btnOutlineRebuildModeFull?.addEventListener('click', () => {
    state.rebuildModal.mode = 'full';
    resetOutlineRebuildSelection();
    clearOutlineRebuildPreview();
    renderOutlineRebuildModal();
  });

  els.btnOutlineRebuildModePartial?.addEventListener('click', () => {
    state.rebuildModal.mode = 'partial';
    clearOutlineRebuildPreview();
    renderOutlineRebuildModal();
  });

  els.outlineRebuildInstruction?.addEventListener('input', () => {
    state.rebuildModal.instruction = els.outlineRebuildInstruction.value || '';
    clearOutlineRebuildPreview();
    renderOutlineRebuildModal();
  });

  els.outlineRebuildShowLibrary?.addEventListener('change', () => {
    state.rebuildModal.showLibrary = !!els.outlineRebuildShowLibrary.checked;
    reconcileOutlineRebuildMaterials();
    clearOutlineRebuildPreview();
    renderOutlineRebuildModal();
  });

  els.btnOutlineRebuildPreview?.addEventListener('click', () => {
    const course = getCourse(state.selectedSubject);
    if (!course || !state.selectedSubject) {
      addLog('请先选择当前课程。', 'warn');
      return;
    }

    const selection = getOutlineRebuildSelection();
    if (state.rebuildModal.mode === 'partial' && !selection) {
      state.rebuildModal.error = '部分重构必须先选择连续主题区间。';
      renderOutlineRebuildModal();
      return;
    }

    state.rebuildModal.error = '';
    state.rebuildModal.preview = null;
    state.rebuildModal.loadingPreview = true;
    renderOutlineRebuildModal();

    vscode.postMessage({
      type: 'previewRebuildCourseOutline',
      request: {
        subject: state.selectedSubject,
        mode: state.rebuildModal.mode,
        selection,
        instruction: state.rebuildModal.instruction,
        materialIds: state.rebuildModal.selectedMaterialIds || [],
      },
    });
  });

  els.btnOutlineRebuildApply?.addEventListener('click', () => {
    const previewId = state.rebuildModal.preview?.previewId;
    if (!previewId) {
      state.rebuildModal.error = '请先生成预览。';
      renderOutlineRebuildModal();
      return;
    }

    state.rebuildModal.error = '';
    state.rebuildModal.applyingPreview = true;
    renderOutlineRebuildModal();

    vscode.postMessage({
      type: 'applyRebuildCourseOutline',
      request: { previewId },
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

  // ===== 设置页 v2：chip nav 切换 + 搜索 =====
  // 初始渲染（profile 状态加载后会再调一次保证默认 active 选对）
  renderSettingsNav();

  // 搜索：若有结果，临时把所有 section 都设 active，让用户能扫到全部命中
  els.settingsSearch?.addEventListener('input', () => {
    const q = (els.settingsSearch.value || '').trim().toLowerCase();
    document.querySelectorAll('.setting-row').forEach((row) => {
      const text = row.textContent.toLowerCase();
      const match = !q || text.includes(q);
      row.classList.toggle('hidden', !match);
      row.classList.toggle('hl', !!q && match);
    });
    document.querySelectorAll('.cc-settings-section').forEach((sec) => {
      if (q) {
        // 搜索期间全部 section 都展开（让用户能跨 section 扫匹配项）
        sec.setAttribute('data-active', 'true');
      } else {
        sec.setAttribute('data-active', sec.getAttribute('data-section') === state.settingsActiveSection ? 'true' : 'false');
      }
    });
  });

  // ===== "恢复默认"按钮（每组） =====
  els.resetGroupButtons?.forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      const groupKey = btn.getAttribute('data-reset-group');
      if (!groupKey) return;
      // window.confirm 在 vscode webview 里不工作，直接执行
      resetPreferenceGroup(groupKey);
      addLog(`已恢复"${groupKey}"分组默认设置`, 'info');
    });
  });

  // ===== 自动保存绑定：常规控件（change） =====
  function bindAutoSave(el, eventName = 'change') {
    if (!el) return;
    el.addEventListener(eventName, schedulePreferenceSave);
  }

  // preset 档位按钮（练习难度分布 / 练习类型分布）
  bindPresetGroups();

  // 学习节奏与目标
  bindAutoSave(els.prefDifficulty);
  bindAutoSave(els.prefExercises);
  bindAutoSave(els.prefSpeed);
  bindAutoSave(els.prefReview, 'input');
  bindAutoSave(els.mixEasy, 'input');
  bindAutoSave(els.mixMedium, 'input');
  bindAutoSave(els.mixHard, 'input');
  [els.mixEasy, els.mixMedium, els.mixHard].forEach((el) => {
    el?.addEventListener('input', updateMixSumHint);
  });

  if (els.prefDailyGoal && els.prefDailyGoalNum) {
    els.prefDailyGoal.addEventListener('input', () => {
      els.prefDailyGoalNum.value = els.prefDailyGoal.value;
      schedulePreferenceSave();
    });
    els.prefDailyGoalNum.addEventListener('input', () => {
      els.prefDailyGoal.value = els.prefDailyGoalNum.value;
      schedulePreferenceSave();
    });
  }

  els.restDayCheckboxes?.forEach((cb) => bindAutoSave(cb));
  els.studySlotCheckboxes?.forEach((cb) => bindAutoSave(cb));

  // AI 风格与内容
  els.aiDetailLevelRadios?.forEach((r) => bindAutoSave(r));
  els.aiFeedbackToneRadios?.forEach((r) => bindAutoSave(r));
  els.explainStyleCheckboxes?.forEach((cb) => bindAutoSave(cb));
  els.aiMathStyleRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.exTypeConcept, 'input');
  bindAutoSave(els.exTypeCalc, 'input');
  bindAutoSave(els.exTypeProof, 'input');
  [els.exTypeConcept, els.exTypeCalc, els.exTypeProof].forEach((el) => {
    el?.addEventListener('input', updateExTypeSumHint);
  });
  bindAutoSave(els.aiIncludeProofs);
  bindAutoSave(els.aiIncludeHistory);
  bindAutoSave(els.prefLangContent);
  bindAutoSave(els.prefLangExercises);
  bindAutoSave(els.prefLangCode);

  // 资料检索
  bindAutoSave(els.retrievalGroundingDefault);
  els.retrievalStrictnessRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.retrievalCiteDefault);
  if (els.retrievalSnippets) {
    els.retrievalSnippets.addEventListener('input', () => {
      if (els.retrievalSnippetsValue) els.retrievalSnippetsValue.textContent = String(els.retrievalSnippets.value);
      schedulePreferenceSave();
    });
  }

  // Hybrid RAG（向量检索）
  bindAutoSave(els.embeddingEnabled);
  bindAutoSave(els.embeddingBaseUrl, 'change');
  bindAutoSave(els.embeddingToken, 'change');
  bindAutoSave(els.embeddingModel, 'change');
  bindAutoSave(els.embeddingDimension, 'change');
  if (els.embeddingHybridWeight) {
    els.embeddingHybridWeight.addEventListener('input', () => {
      if (els.embeddingHybridWeightValue) els.embeddingHybridWeightValue.textContent = String(els.embeddingHybridWeight.value);
      schedulePreferenceSave();
    });
  }
  if (els.btnTestEmbedding) {
    els.btnTestEmbedding.addEventListener('click', () => {
      if (els.embeddingTestStatus) els.embeddingTestStatus.textContent = '测试中...';
      renderEmbeddingTestFeedback('pending', '正在测试连通性…');
      // 按钮加 busy spinner
      els.btnTestEmbedding.classList.add('is-busy');
      // 收到结果时移除 busy（在 embeddingTestResult handler 处理）
      setTimeout(() => els.btnTestEmbedding?.classList.remove('is-busy'), 30000); // 兜底 30s
      vscode.postMessage({
        type: 'testEmbedding',
        config: {
          baseUrl: (els.embeddingBaseUrl?.value || '').trim(),
          apiToken: (els.embeddingToken?.value || '').trim(),
          model: (els.embeddingModel?.value || 'BAAI/bge-m3').trim(),
          dimension: Number(els.embeddingDimension?.value ?? 1024),
        },
      });
    });
  }
  if (els.btnReindexVectors) {
    els.btnReindexVectors.addEventListener('click', () => {
      const subject = state?.selectedSubject || state?.activeSubject;
      if (!subject) {
        showToast('请先在课程页选定一个学科', 'warn');
        return;
      }
      // confirm() 在 VS Code webview 里不工作；交给后端用 vscode.window.showWarningMessage 弹 modal
      vscode.postMessage({ type: 'reindexAllVectors', subject, requireConfirm: true });
    });
  }
  // 全学科一键重建（升级 v1 → v2 + 建所有未索引）
  document.getElementById('btn-reindex-all-subjects')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'reindexAllSubjectsAllVectors', requireConfirm: true });
  });

  // Vision API 控件
  bindAutoSave(els.visionEnabled);
  bindAutoSave(els.visionBaseUrl, 'change');
  bindAutoSave(els.visionToken, 'change');
  bindAutoSave(els.visionModel, 'change');
  bindAutoSave(els.visionDpi, 'change');
  if (els.visionConcurrency) {
    els.visionConcurrency.addEventListener('input', () => {
      if (els.visionConcurrencyValue) els.visionConcurrencyValue.textContent = String(els.visionConcurrency.value);
      schedulePreferenceSave();
    });
  }

  // 讲义阅读体验
  els.lectureReaderModeRadios?.forEach((r) => bindAutoSave(r));
  els.lectureApplyModeRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.lectureSyncSource);
  if (els.lectureHighlightDuration) {
    els.lectureHighlightDuration.addEventListener('input', () => {
      const v = els.lectureHighlightDuration.value;
      if (els.lectureHighlightDurationValue) els.lectureHighlightDurationValue.textContent = `${v} 秒`;
      schedulePreferenceSave();
    });
  }

  // UI 与显示
  if (els.uiFontSize) {
    els.uiFontSize.addEventListener('input', () => {
      const v = Number(els.uiFontSize.value) || 13;
      if (els.uiFontSizeValue) els.uiFontSizeValue.textContent = `${v} px`;
      applyFontScale(v);  // 拖动 slider 时立即生效
      schedulePreferenceSave();
    });
  }
  els.uiDefaultTabRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.uiTreeDefaultExpand);
  els.uiThemeRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.uiShowEmoji);

  // ===== AI Profile 编辑器交互 =====
  els.aiProfileProvider?.addEventListener('change', syncAIProfileProviderFields);

  els.btnAddAIProfile?.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openAIProfileEditor(null);
  });

  els.btnSaveAIProfile?.addEventListener('click', () => {
    const profile = collectAIProfileForm();
    if (!profile.name) {
      addLog('请填写 Profile 名称。', 'warn');
      return;
    }
    if (!profile.model) {
      addLog('请填写模型名称。', 'warn');
      return;
    }
    vscode.postMessage({ type: 'saveAIProfile', profile });
    closeAIProfileEditor();
    addLog(`已提交保存 Profile：${profile.name}`, 'info');
  });

  els.btnTestAIProfileDraft?.addEventListener('click', () => {
    const profile = collectAIProfileForm();
    if (!profile.name) {
      renderDraftProfileFeedback('error', '请先填写 Profile 名称。');
      return;
    }
    if (!profile.model) {
      renderDraftProfileFeedback('error', '请先填写模型名称。');
      return;
    }
    state.testingProfileId = null;
    state.testingProfileName = null;
    renderDraftProfileFeedback('pending', `正在测试 ${profile.name} 的连通性…`);
    vscode.postMessage({ type: 'testAIProfile', profile });
  });

  els.btnCancelAIProfile?.addEventListener('click', () => {
    closeAIProfileEditor();
  });

  // 点 modal 背景或按 Esc 关闭 AI Profile 弹窗
  els.aiProfileEditor?.addEventListener('click', (event) => {
    if (event.target === els.aiProfileEditor) closeAIProfileEditor();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.aiProfileEditor && !els.aiProfileEditor.classList.contains('hidden')) {
      closeAIProfileEditor();
    }
  });

  // ===== Workspace AI Override =====
  els.btnSaveWsOverride?.addEventListener('click', () => {
    const optionalNumber = (el) => {
      const raw = (el?.value || '').trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const overrides = {
      provider: (els.aiWsProvider?.value || '').trim() || undefined,
      baseUrl: (els.aiWsBaseUrl?.value || '').trim() || undefined,
      anthropicBaseUrl: (els.aiWsAnthropicBaseUrl?.value || '').trim() || undefined,
      apiToken: els.aiWsToken?.value || undefined,
      model: (els.aiWsModel?.value || '').trim() || undefined,
      wireApi: (els.aiWsWireApi?.value || '').trim() || undefined,
      reasoningEffort: (els.aiWsReasoningEffort?.value || '').trim() || undefined,
      contextWindow: optionalNumber(els.aiWsContextWindow),
      maxTokens: optionalNumber(els.aiWsMaxTokens),
    };
    Object.keys(overrides).forEach((key) => {
      if (overrides[key] === undefined || overrides[key] === '') delete overrides[key];
    });
    const override = {
      enabled: !!els.aiWsOverrideEnabled?.checked,
      baseProfileId: els.aiWsBaseProfile?.value || undefined,
      overrides,
    };
    vscode.postMessage({ type: 'saveWorkspaceAIOverride', override });
    addLog('已保存工作区 AI 覆盖设置。', 'info');
  });

  // ===== 数据管理按钮 =====
  function getDataSubject() {
    return els.dataSubjectSelect?.value || state.selectedSubject || null;
  }

  // 数据管理按钮：confirm 走后端原生 vscode.window.showWarningMessage
  els.btnClearWrongQuestions?.addEventListener('click', () => {
    const subject = getDataSubject();
    if (!subject) { addLog('请先选择学科。', 'warn'); return; }
    vscode.postMessage({ type: 'clearWrongQuestions', subject, requireConfirm: true });
  });

  els.btnClearDiagnosis?.addEventListener('click', () => {
    const subject = getDataSubject();
    if (!subject) { addLog('请先选择学科。', 'warn'); return; }
    vscode.postMessage({ type: 'clearDiagnosisHistory', subject, requireConfirm: true });
  });

  els.btnResetCourseProgress?.addEventListener('click', () => {
    const subject = getDataSubject();
    if (!subject) { addLog('请先选择学科。', 'warn'); return; }
    vscode.postMessage({ type: 'resetCourseProgress', subject, requireConfirm: true });
  });

  els.btnExportLearningData?.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportLearningData' });
  });

  els.btnImportLearningData?.addEventListener('click', () => {
    vscode.postMessage({ type: 'importLearningData', requireConfirm: true });
  });

  // ===== 数据目录与高级 =====
  els.btnExportPrefs?.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportPreferences' });
  });

  els.btnImportPrefs?.addEventListener('click', () => {
    vscode.postMessage({ type: 'importPreferences' });
  });

  els.btnResetAllPrefs?.addEventListener('click', () => {
    vscode.postMessage({ type: 'resetAllPreferences', requireConfirm: true });
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
      } else if (action === 'set-course-tags') {
        openCourseTagsModal(course);
      }
      els.editMenu?.classList.add('hidden');
    });
  });

  // ===== 课程教学法 Tag 模态 =====
  let _courseTagsEditTarget = null;

  function openCourseTagsModal(course) {
    if (!course) return;
    _courseTagsEditTarget = course;
    const currentTags = new Set(course.tags || []);
    if (els.courseTagsSubtitle) {
      els.courseTagsSubtitle.textContent = `课程：${course.title || course.subject}。可多选；不同 tag 会让 AI 在讲义结构、出题分布、批改风格上区别对待。`;
    }
    if (els.courseTagsChecklist) {
      els.courseTagsChecklist.innerHTML = COURSE_TAGS.map((t) => {
        const checked = currentTags.has(t.value);
        return `
          <label class="course-tag-row${checked ? ' checked' : ''}">
            <input type="checkbox" data-course-tag="${escapeHtml(t.value)}"${checked ? ' checked' : ''}>
            <div>
              <div class="ct-label">${escapeHtml(t.label)}</div>
              <div class="ct-desc">${escapeHtml(t.desc)}</div>
            </div>
          </label>
        `;
      }).join('');
      // 行点击同步 checkbox + active 状态
      els.courseTagsChecklist.querySelectorAll('.course-tag-row').forEach((row) => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (!cb) return;
        cb.addEventListener('change', () => {
          row.classList.toggle('checked', cb.checked);
        });
      });
    }
    els.courseTagsModal?.classList.remove('hidden');
    els.courseTagsModal?.setAttribute('aria-hidden', 'false');
  }

  function closeCourseTagsModal() {
    _courseTagsEditTarget = null;
    els.courseTagsModal?.classList.add('hidden');
    els.courseTagsModal?.setAttribute('aria-hidden', 'true');
  }

  els.btnCloseCourseTagsModal?.addEventListener('click', closeCourseTagsModal);
  els.btnCancelCourseTags?.addEventListener('click', closeCourseTagsModal);
  els.courseTagsModal?.addEventListener('click', (event) => {
    if (event.target === els.courseTagsModal) closeCourseTagsModal();
  });

  els.btnSaveCourseTags?.addEventListener('click', () => {
    if (!_courseTagsEditTarget) { closeCourseTagsModal(); return; }
    const tags = Array.from(els.courseTagsChecklist?.querySelectorAll('input[type="checkbox"]:checked') || [])
      .map((cb) => cb.getAttribute('data-course-tag'))
      .filter(Boolean);
    vscode.postMessage({
      type: 'setCourseTags',
      subject: _courseTagsEditTarget.subject,
      tags,
    });
    addLog(`提交教学法 tag：${tags.join(' / ') || '（无）'}`, 'info');
    closeCourseTagsModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.courseTagsModal?.classList.contains('hidden')) {
      closeCourseTagsModal();
    }
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
        applyOnboardingState();
        applyDisabledStates();
        break;
      }
      case 'keyPointsLoaded': {
        // 后端响应 loadKeyPoints，缓存进 state 并触发对应 panel 重渲
        state.keyPointsCache[msg.lessonId] = msg.keyPoints || null;
        if (typeof renderKeyPointsPanel === 'function') {
          renderKeyPointsPanel(msg.lessonId);
        }
        break;
      }
      case 'keyPointsGenerated': {
        // AI 一键生成完成 —— 清空该 topic 下所有 lessons 的本地缓存，触发重新 load
        const course = getCourse(msg.subject);
        const topic = course?.topics?.find((t) => t.id === msg.topicId);
        (topic?.lessons || []).forEach((l) => {
          delete state.keyPointsCache[l.id];
          // 如果当前展开着，立刻 reload
          if (state.expandedLessons.has(l.id)) {
            vscode.postMessage({
              type: 'loadKeyPoints',
              subject: msg.subject,
              topicId: msg.topicId,
              lessonId: l.id,
            });
          }
        });
        if (typeof showToast === 'function') {
          showToast(`已生成 ${msg.generated} 个 lesson 的知识点`, 'success');
        }
        break;
      }
      case 'courseGenerated': {
        if (msg.outline) {
          const next = state.courses.filter((course) => course.subject !== msg.outline.subject);
          next.push(msg.outline);
          state.courses = next;
          state.selectedSubject = msg.outline.subject;
        }
        // apply 完成 → 清掉预览面板，回到正常 onCourseSelected 视图
        clearCoursePreview();
        onCourseSelected();
        showToast('课程大纲已应用 ✓', 'success');
        break;
      }
      case 'coursePreview': {
        // AI 生成 / refine 后的预览：缓存到 state，渲染预览面板
        state.coursePreview = {
          previewId: msg.previewId,
          subject: msg.subject,
          outline: msg.outline,
          lastRefineInstruction: msg.lastRefineInstruction,
        };
        renderCoursePreviewPanel();
        // 清空 refine textarea（refine 成功后），让用户可以继续下一轮
        const refineInput = document.getElementById('course-preview-refine-input');
        if (refineInput) refineInput.value = '';
        // 滚到预览面板
        document.getElementById('course-preview-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        break;
      }
      case 'coursePreviewDiscarded': {
        // 后端确认已 drop（前端已经先 clearCoursePreview，这里幂等）
        if (state.coursePreview?.previewId === msg.previewId) {
          clearCoursePreview();
        }
        break;
      }
      case 'materials': {
        state.materials = msg.data || { materials: [] };
        // 把外层 vectorStats（不在 MaterialIndex 里）挂到 state.materials 上供 renderMaterials 用
        state.materials.vectorStats = msg.vectorStats || {};
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
        reconcileOutlineRebuildMaterials();
        syncMaterialImportTargets();
        renderMaterials();
        renderCourseMaterials();
        renderChatContext();
        renderOutlineRebuildModal();
        break;
      }
      case 'materialPreview': {
        state.currentCourseMaterialPreview = msg.data || null;
        state.selectedCourseMaterialId = state.currentCourseMaterialPreview?.materialId || null;
        renderCourseMaterials();
        renderChatContext();
        renderOutlineRebuildModal();
        persist();
        break;
      }
      case 'outlineRebuildPreview': {
        state.rebuildModal.loadingPreview = false;
        state.rebuildModal.applyingPreview = false;
        state.rebuildModal.error = '';
        state.rebuildModal.preview = msg.data || null;
        renderOutlineRebuildModal();
        break;
      }
      case 'outlineRebuildApplied': {
        state.rebuildModal.loadingPreview = false;
        state.rebuildModal.applyingPreview = false;
        state.rebuildModal.error = '';
        state.rebuildModal.preview = null;
        renderOutlineRebuildModal();
        closeOutlineRebuildModal();
        addLog('大纲重构已应用。', 'info');
        break;
      }
      case 'preferences': {
        renderPreferences(msg.data || null);
        break;
      }
      case 'embeddingTestResult': {
        const r = msg.data || {};
        // 清掉测试按钮的 busy spinner
        if (els.btnTestEmbedding) els.btnTestEmbedding.classList.remove('is-busy');
        // 旧 inline span：保留向后兼容（万一别处还用）
        if (els.embeddingTestStatus) {
          const symbol = r.ok ? '✓' : '✗';
          const detail = r.dimension ? ` · ${r.dimension} 维` : '';
          const time = r.latencyMs ? ` (${r.latencyMs}ms)` : '';
          els.embeddingTestStatus.textContent = `${symbol} ${r.message || ''}${detail}${time}`;
          els.embeddingTestStatus.style.color = r.ok ? 'var(--vscode-charts-green, #4ec9b0)' : 'var(--vscode-charts-red, #f48771)';
        }
        // 新 .ds-feedback 卡：饱和色 + 完整信息一行
        const detail = r.dimension ? ` · ${r.dimension} 维` : '';
        const time = r.latencyMs ? ` · ${r.latencyMs}ms` : '';
        renderEmbeddingTestFeedback(
          r.ok ? 'success' : 'error',
          (r.message || (r.ok ? '连通正常' : '测试失败')) + detail + time,
        );
        break;
      }
      case 'vectorReindexComplete': {
        const r = msg.data || {};
        addLog(`向量索引完成：成功 ${r.processed || 0} / 失败 ${r.failed || 0}`, r.ok ? 'info' : 'warn');
        break;
      }
      case 'vectorIndexStats': {
        // 后续可用于在资料卡片上显示"已向量化 N/M 块"
        break;
      }
      case 'diagnosis': {
        renderDiagnosis(msg.data || null);
        break;
      }
      case 'courseProfile': {
        // Insights Panel 数据：缓存 per subject，渲染当前选中
        if (!state.courseProfilesBySubject) state.courseProfilesBySubject = {};
        if (msg.subject && msg.data) {
          state.courseProfilesBySubject[msg.subject] = msg.data;
          if (msg.subject === state.selectedSubject) renderInsights();
        }
        break;
      }
      case 'chatResponse': {
        // 流式版本下，aiStreamEnd 已经把 finalText 渲染好，chatResponse 只负责
        // 持久化 (state.chatMessages.push)。如果当前 turn 没有流式 entry，
        // 回退到非流式：直接 appendChat 一次性渲染。
        if (state.streamingChat && state.streamingChat.turnId === msg.turnId) {
          // 流式已完成，最终态 = msg.content。把消息持久化到 state（appendChat 的
          // save 路径），但不再创建新 DOM（流式 bubble 已经存在）
          const finalText = msg.content || '';
          state.chatMessages.push({ role: 'assistant', content: finalText });
          persist();
          state.streamingChat = null;
        } else {
          appendChat('assistant', msg.content || '');
        }
        break;
      }
      case 'aiStreamDelta': {
        if (msg.channel !== 'chat' || !msg.turnId) break;
        // 第一次 delta：创建 assistant message DOM + 启动节流计时
        if (!state.streamingChat || state.streamingChat.turnId !== msg.turnId) {
          const el = document.createElement('div');
          el.className = 'chat-msg assistant streaming';
          els.chatMessages?.appendChild(el);
          state.streamingChat = {
            turnId: msg.turnId,
            el,
            buf: '',
            lastRenderAt: 0,
            trailingTimer: null,
          };
        }
        const sc = state.streamingChat;
        sc.buf += (msg.delta || '');
        const renderNow = () => {
          if (!sc.el) return;
          sc.el.innerHTML = renderMarkdown(sc.buf);
          renderMath(sc.el);
          // 跟着新内容滚到底
          if (els.chatMessages) els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
        };
        const now = Date.now();
        if (now - sc.lastRenderAt > 50) {
          sc.lastRenderAt = now;
          renderNow();
        } else if (!sc.trailingTimer) {
          sc.trailingTimer = setTimeout(() => {
            if (!state.streamingChat || state.streamingChat.turnId !== msg.turnId) return;
            state.streamingChat.lastRenderAt = Date.now();
            state.streamingChat.trailingTimer = null;
            renderNow();
          }, 60);
        }
        break;
      }
      case 'aiStreamEnd': {
        if (msg.channel !== 'chat' || !msg.turnId) break;
        const sc = state.streamingChat;
        if (!sc || sc.turnId !== msg.turnId) break;
        if (sc.trailingTimer) clearTimeout(sc.trailingTimer);
        const finalText = (typeof msg.finalText === 'string' && msg.finalText) ? msg.finalText : sc.buf;
        sc.el.innerHTML = renderMarkdown(finalText);
        renderMath(sc.el);
        sc.el.classList.remove('streaming');
        // 持久化由后续 chatResponse 处理（finalText 一致）
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
      case 'activateTab': {
        if (msg.tab) {
          activateTab(msg.tab);
        }
        if (msg.focus === 'ai') {
          // 切到 AI Profile section + 滚动
          state.settingsActiveSection = 'aiConfig';
          renderSettingsNav();
          if (els.aiConfigCenter) {
            els.aiConfigCenter.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
        }
        break;
      }
      case 'resolvedAIConfig': {
        state.resolvedAIConfig = msg.data || null;
        state.workspaceAIOverride = msg.workspaceOverride || null;
        renderResolvedAIConfig(msg.data || null, msg.workspaceOverride || null);
        renderWorkspaceAIOverride();
        break;
      }
      case 'aiImportResult': {
        const labelMap = {
          claude: '.claude',
          codex: '.codex',
          package: 'config JSON',
          manual: 'manual',
        };
        const importedFrom = labelMap[msg.data?.importedFrom] || 'config';
        addLog(`已从 ${importedFrom} 导入 AI 配置：${msg.data?.profile?.name || '-'}`, 'info');
        break;
      }
      case 'log': {
        addLog(msg.message, msg.level);
        break;
      }
      // ===== Projects =====
      case 'projectsList': {
        state.allProjects = Array.isArray(msg.data) ? msg.data : [];
        renderProjectsList();
        break;
      }
      case 'projectCreated': {
        showToast('项目已创建：' + (msg.meta?.title || ''), 'success');
        if (Array.isArray(msg.warnings) && msg.warnings.length) {
          msg.warnings.forEach((w) => addLog('[项目] ' + w, 'warn'));
        }
        vscode.postMessage({ type: 'listProjects' });
        // 清空 + 收起创建表单
        const promptEl = document.getElementById('project-prompt');
        const tsEl = document.getElementById('project-techstack');
        if (promptEl) promptEl.value = '';
        if (tsEl) tsEl.value = '';
        document.getElementById('course-project-form')?.classList.add('hidden');
        break;
      }
      case 'projectScaffoldFailed': {
        showToast('生成项目失败：' + (msg.errorMessage || '未知错误'), 'error');
        addLog('[项目] 生成失败：' + (msg.errorMessage || '未知错误'), 'error');
        break;
      }
      case 'projectOpened': {
        showToast('已在新窗口打开项目', 'info');
        break;
      }
      case 'projectProgressUpdated': {
        vscode.postMessage({ type: 'listProjects' });
        showToast('项目进度已更新', 'success');
        break;
      }
      case 'projectDeleted': {
        vscode.postMessage({ type: 'listProjects' });
        showToast('项目已删除', 'info');
        break;
      }
      case 'projectSpec': {
        // 暂存到 state；详情视图未实现，留作后续
        state.projectSpecs = state.projectSpecs || {};
        state.projectSpecs[msg.projectId] = msg.spec;
        break;
      }
      case 'error': {
        if (state.rebuildModal.loadingPreview || state.rebuildModal.applyingPreview) {
          state.rebuildModal.loadingPreview = false;
          state.rebuildModal.applyingPreview = false;
          state.rebuildModal.error = msg.message || '重构请求失败，请稍后重试。';
          renderOutlineRebuildModal();
        }
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
      case 'wrongQuestions': {
        state.wrongQuestions = Array.isArray(msg.data) ? msg.data : [];
        renderWrongQuestions();
        break;
      }
      case 'gradingProgress': {
        addLog(`批改中 ${msg.current}/${msg.total}：${msg.lessonTitle || ''}`, 'info');
        break;
      }
      case 'autoDiagnosisRan': {
        const reasonLabel = {
          'grade-threshold': '完成多次练习',
          'time-elapsed': '距上次诊断已超 24h',
          'first-time': '首次诊断',
          'manual': '手动触发',
        }[msg.reason] || msg.reason || '';
        addLog(`🤖 已自动重新诊断（${reasonLabel}）`, 'info');
        requestDiagnosis(false);
        break;
      }
      case 'groundingSources': {
        const sources = Array.isArray(msg.sources) ? msg.sources : [];
        if (!sources.length || !els.chatMessages) break;
        const lastAssistant = els.chatMessages.querySelector('.chat-msg.assistant:last-child');
        if (!lastAssistant) break;
        if (lastAssistant.querySelector('.chat-grounding-sources')) break;
        const details = document.createElement('details');
        details.className = 'chat-grounding-sources';
        const summary = document.createElement('summary');
        summary.textContent = `参考资料 (${sources.length} 条)`;
        details.appendChild(summary);
        sources.forEach((source) => {
          const item = document.createElement('div');
          item.className = 'chat-grounding-source';
          const header = document.createElement('div');
          header.className = 'chat-grounding-source-header';
          header.textContent = source.sectionLabel
            ? `${source.fileName} · ${source.sectionLabel}`
            : source.fileName;
          const excerpt = document.createElement('div');
          excerpt.className = 'chat-grounding-source-excerpt';
          excerpt.textContent = String(source.excerpt || '').slice(0, 200);
          item.appendChild(header);
          item.appendChild(excerpt);
          details.appendChild(item);
        });
        lastAssistant.appendChild(details);
        break;
      }
      case 'triggerGenerateCourse': {
        activateTab('learn');
        setCreateCourseMode(true);
        break;
      }
      case 'triggerGenerateLesson': {
        activateTab('learn');
        addLog('请在课程树中点击对应课时的"讲义"按钮。', 'info');
        break;
      }
      case 'triggerGenerateExercises': {
        activateTab('learn');
        addLog('请在课程树中展开课时的"…"菜单，选择"练习"。', 'info');
        break;
      }
      case 'triggerGradeAnswer': {
        activateTab('learn');
        addLog('请在课程树中展开课时菜单，选择"答题与批改"。', 'info');
        break;
      }
      case 'triggerDiagnosis': {
        activateTab('learn');
        requestDiagnosis(true);
        break;
      }
      case 'triggerImportMaterial': {
        if (state.selectedSubject) {
          vscode.postMessage({ type: 'importMaterial', subject: state.selectedSubject });
        } else {
          activateTab('materials');
          addLog('请先选择目标课程，再导入资料。', 'info');
        }
        break;
      }
      case 'aiProfilesList': {
        state.aiProfiles = Array.isArray(msg.data) ? msg.data : [];
        state.activeProfileId = msg.activeProfileId || null;
        if (msg.workspaceOverride !== undefined) {
          state.workspaceAIOverride = msg.workspaceOverride;
        }
        renderAIProfiles();
        renderWorkspaceAIOverride();
        // P0-5: 首次/没配置 profile 时，设置页默认打开 "AI 配置中心"
        applyDefaultSettingsOpen();
        // P1-1 & P1-2: AI 配置变化触发 onboarding 状态 + 按钮可用性更新
        applyOnboardingState();
        applyDisabledStates();
        break;
      }
      case 'aiProfileSaved': {
        if (msg.profile) {
          const idx = state.aiProfiles.findIndex((p) => p.id === msg.profile.id);
          if (idx >= 0) state.aiProfiles[idx] = msg.profile;
          else state.aiProfiles.push(msg.profile);
          renderAIProfiles();
        }
        addLog(`AI Profile 已保存：${msg.profile?.name || '-'}`, 'info');
        break;
      }
      case 'aiTestResult': {
        const m = msg.message || (msg.success ? '测试成功' : '测试失败');
        addLog(m, msg.success ? 'info' : 'error');
        // 就近反馈：渲染到对应 profile 卡内的 ds-feedback 区，6s 后自动收起
        if (state.testingProfileId) {
          renderProfileFeedback(
            state.testingProfileId,
            msg.success ? 'success' : 'error',
            m,
            6000,
          );
        } else {
          renderDraftProfileFeedback(msg.success ? 'success' : 'error', m);
        }
        state.testingProfileId = null;
        state.testingProfileName = null;
        break;
      }
      case 'workspaceAIOverride': {
        state.workspaceAIOverride = msg.data || null;
        renderWorkspaceAIOverride();
        break;
      }
      case 'dataOpResult': {
        const op = msg.operation || '操作';
        const ok = !!msg.ok;
        addLog(`${op} ${ok ? '成功' : '失败'}${msg.message ? '：' + msg.message : ''}`, ok ? 'info' : 'error');
        // 数据被清空/导入后刷新课程相关 UI
        if (ok) {
          refreshCoursePanelData(false);
          requestWrongQuestions();
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
  syncDataSubjectSelect();
  renderChatContext();
  renderResolvedAIConfig(null, null);
  renderOutlineRebuildModal();
  renderWrongQuestions();
  renderAIProfiles();
  renderWorkspaceAIOverride();
  updateTaskBlockedState();

  refreshCoursePanelData();
  renderWrongQuestions();
  if (state.selectedSubject) {
    requestWrongQuestions();
  }
  vscode.postMessage({ type: 'getPreferences' });
  vscode.postMessage({ type: 'getDataDir' });
  vscode.postMessage({ type: 'getResolvedAIConfig' });
  vscode.postMessage({ type: 'listAIProfiles' });
  // 创建课程的 tag chip 列表：启动时就 render，避免依赖 setCreateCourseMode 时机。
  // 即使 panel 现在是 hidden，DOM 也已就绪，innerHTML 写完后 chip 全部就位。
  renderNewCourseTagsChecklist();
})();
