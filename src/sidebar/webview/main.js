(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

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
      active: true,
      loops: { dailyBrief: true, idle: true, sr: true, metacog: true, drift: true },
      notifications: { toastLevel: 'high-only', quietHoursStart: '22:00', quietHoursEnd: '08:00' },
      throttle: { maxToastsPerHour: 3, maxBannersPerHour: 12 },
      doNotDisturbUntil: null,
      idleThresholdMinutes: 8,
      sr: { variantStrategy: 'reuse' },
      dailyBrief: { cacheStrategy: 'per-day' },
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
    aiProfiles: [],
    activeProfileId: null,
    workspaceAIOverride: null,
    learningPlan: null,
    coachSuggestions: [],
    dailyBrief: null,
    doNotDisturbUntil: null,
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
    btnChangeAIConfig: $('btn-change-ai-config'),
    aiChangeMenu: $('ai-change-menu'),
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

    // ===== 主动 Coach =====
    coachEnabled: $('coach-enabled'),
    coachLoopCheckboxes: Array.from(document.querySelectorAll('[data-coach-loop]')),
    coachToastLevelRadios: Array.from(document.querySelectorAll('input[name="coach-toast-level"]')),
    coachDndStart: $('coach-dnd-start'),
    coachDndEnd: $('coach-dnd-end'),
    btnDnd1h: $('btn-dnd-1h'),
    btnDndToday: $('btn-dnd-today'),
    btnDndCustom: $('btn-dnd-custom'),
    coachIdleThreshold: $('coach-idle-threshold'),
    coachIdleThresholdValue: $('coach-idle-threshold-value'),
    coachSrPolicyRadios: Array.from(document.querySelectorAll('input[name="coach-sr-policy"]')),
    coachBriefCacheRadios: Array.from(document.querySelectorAll('input[name="coach-brief-cache"]')),
    coachThrottleHour: $('coach-throttle-hour'),
    coachThrottleDay: $('coach-throttle-day'),

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
    aiProfileEditor: $('ai-profile-editor'),
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
    btnSaveAIProfile: $('btn-save-ai-profile'),
    btnCancelAIProfile: $('btn-cancel-ai-profile'),
    aiWsOverrideEnabled: $('ai-ws-override-enabled'),
    aiWsBaseProfile: $('ai-ws-base-profile'),
    aiWsProvider: $('ai-ws-provider'),
    aiWsBaseUrl: $('ai-ws-base-url'),
    aiWsToken: $('ai-ws-token'),
    aiWsModel: $('ai-ws-model'),
    btnSaveWsOverride: $('btn-save-ws-override'),

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

    // ===== 今日 Coach =====
    coachTodaySection: $('coach-today-section'),
    coachBriefSubtitle: $('coach-brief-subtitle'),
    coachBriefBody: $('coach-brief-body'),
    coachSuggestionsList: $('coach-suggestions-list'),
    btnCoachRefreshBrief: $('btn-coach-refresh-brief'),
    btnCoachDnd: $('btn-coach-dnd'),

    // ===== Onboarding =====
    onboardingCard: $('onboarding-card'),
    onboardingStepAi: $('onboarding-step-ai'),
    onboardingStepCourse: $('onboarding-step-course'),
    onboardingStepMaterial: $('onboarding-step-material'),
    onboardingStepLesson: $('onboarding-step-lesson'),
    btnOnboardingDismiss: $('btn-onboarding-dismiss'),
    btnOnboardingGoAi: $('btn-onboarding-go-ai'),

    // ===== 学习计划 =====
    learningPlanSection: $('learning-plan-section'),
    btnEditPlan: $('btn-edit-plan'),
    planProgressBar: $('plan-progress-bar'),
    planProgressFill: $('plan-progress-fill'),
    planStatus: $('plan-status'),
    planMilestonesList: $('plan-milestones-list'),
    learningPlanModal: $('learning-plan-modal'),
    planSubject: $('plan-subject'),
    planTargetDate: $('plan-target-date'),
    planDailyMinutes: $('plan-daily-minutes'),
    planExtraNotes: $('plan-extra-notes'),
    btnSavePlan: $('btn-save-plan'),
    btnCancelPlan: $('btn-cancel-plan'),
    btnClosePlanModal: $('btn-close-plan-modal'),

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

    const items = state.courses.map((course) => `
      <div class="dropdown-item${course.subject === state.selectedSubject ? ' selected' : ''}" data-subject="${escapeHtml(course.subject)}">
        <span>${escapeHtml(course.title || subjectLabel(course.subject))} ${renderCourseTagBadges(course.tags)}</span>
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
    // 标题旁渲染 tag 徽章
    const tagsHtml = renderCourseTagBadges(course.tags);
    els.courseTitleText.innerHTML = `${escapeHtml(course.title)}${tagsHtml ? ' ' + tagsHtml : ''}`;
    els.courseTree.classList.remove('hidden');

    // 主题/课时 + 课程附带项目提案（outline.projects）
    const topicsHtml = course.topics.map((topic, topicIndex) => `
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

    // 注意：outline.projects 的"推荐项目"**不再**渲染在 course-tree 里。
    // 跟"已创建的项目"合并到独立面板 #course-projects-section 的两个 subsection
    // 见 renderCourseProjectProposals + renderProjectsList。
    els.courseTree.innerHTML = topicsHtml;

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

    // ===== Coach =====
    if (els.coachEnabled) els.coachEnabled.checked = merged.coach?.active !== false;
    const loops = merged.coach?.loops || {};
    const loopKeyMap = { dailyBrief: 'dailyBrief', idleNudge: 'idle', srPrompt: 'sr', metacog: 'metacog', planSync: 'drift' };
    els.coachLoopCheckboxes?.forEach((cb) => {
      const dataKey = cb.getAttribute('data-coach-loop');
      const stateKey = loopKeyMap[dataKey] || dataKey;
      cb.checked = loops[stateKey] !== false;
    });
    setRadioGroup(els.coachToastLevelRadios, merged.coach?.notifications?.toastLevel || 'high-only');
    if (els.coachDndStart) els.coachDndStart.value = merged.coach?.notifications?.quietHoursStart || '22:00';
    if (els.coachDndEnd) els.coachDndEnd.value = merged.coach?.notifications?.quietHoursEnd || '08:00';
    const idleMin = merged.coach?.idleThresholdMinutes ?? 8;
    if (els.coachIdleThreshold) els.coachIdleThreshold.value = String(idleMin);
    if (els.coachIdleThresholdValue) els.coachIdleThresholdValue.textContent = `${idleMin} 分钟`;
    setRadioGroup(els.coachSrPolicyRadios, merged.coach?.sr?.variantStrategy || 'reuse');
    setRadioGroup(els.coachBriefCacheRadios, merged.coach?.dailyBrief?.cacheStrategy || 'per-day');
    if (els.coachThrottleHour) els.coachThrottleHour.value = String(merged.coach?.throttle?.maxToastsPerHour ?? 3);
    if (els.coachThrottleDay) els.coachThrottleDay.value = String(merged.coach?.throttle?.maxBannersPerHour ?? 12);

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

    const loops = current.coach?.loops || {};
    const loopKeyMap = { dailyBrief: 'dailyBrief', idleNudge: 'idle', srPrompt: 'sr', metacog: 'metacog', planSync: 'drift' };
    (els.coachLoopCheckboxes || []).forEach((cb) => {
      const dataKey = cb.getAttribute('data-coach-loop');
      const stateKey = loopKeyMap[dataKey] || dataKey;
      loops[stateKey] = !!cb.checked;
    });

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
        active: !!els.coachEnabled?.checked,
        loops,
        notifications: {
          toastLevel: getRadioGroup(els.coachToastLevelRadios) || current.coach?.notifications?.toastLevel || 'high-only',
          quietHoursStart: els.coachDndStart?.value || current.coach?.notifications?.quietHoursStart || '22:00',
          quietHoursEnd: els.coachDndEnd?.value || current.coach?.notifications?.quietHoursEnd || '08:00',
        },
        throttle: {
          maxToastsPerHour: Number(els.coachThrottleHour?.value ?? current.coach?.throttle?.maxToastsPerHour ?? 3),
          maxBannersPerHour: Number(els.coachThrottleDay?.value ?? current.coach?.throttle?.maxBannersPerHour ?? 12),
        },
        doNotDisturbUntil: state.doNotDisturbUntil ?? current.coach?.doNotDisturbUntil ?? null,
        idleThresholdMinutes: Number(els.coachIdleThreshold?.value ?? current.coach?.idleThresholdMinutes ?? 8),
        sr: {
          variantStrategy: getRadioGroup(els.coachSrPolicyRadios) || current.coach?.sr?.variantStrategy || 'reuse',
        },
        dailyBrief: {
          cacheStrategy: getRadioGroup(els.coachBriefCacheRadios) || current.coach?.dailyBrief?.cacheStrategy || 'per-day',
        },
        lecture: {
          viewerMode: getRadioGroup(els.lectureReaderModeRadios) || current.coach?.lecture?.viewerMode || 'lecture-webview',
          applyMode: getRadioGroup(els.lectureApplyModeRadios) || current.coach?.lecture?.applyMode || 'preview-confirm',
          syncSourceEditor: !!els.lectureSyncSource?.checked,
          highlightChangesMs: Math.max(1, Number(els.lectureHighlightDuration?.value ?? 3)) * 1000,
        },
      },
    };
  }

  // ===== 偏好自动保存（debounce 300ms） =====
  let prefsSaveTimer = null;
  function schedulePreferenceSave() {
    if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
    prefsSaveTimer = setTimeout(() => {
      prefsSaveTimer = null;
      const preferences = collectPreferences();
      state.preferences = preferences;
      vscode.postMessage({ type: 'savePreferences', preferences });
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
    } else if (groupKey === 'coach') {
      current.coach = deepClone(DEFAULT_PREFS.coach);
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
    const sections = Array.from(document.querySelectorAll('.cc-settings-section'));
    if (!sections.length) return;

    // 决定默认 active section
    if (!state.settingsActiveSection) {
      const profiles = Array.isArray(state.aiProfiles) ? state.aiProfiles : [];
      const hasActive = profiles.length > 0 && state.activeProfileId;
      state.settingsActiveSection = hasActive ? 'pace' : 'aiConfig';
    }

    // 渲染 chip
    nav.innerHTML = sections.map((sec) => {
      const id = sec.getAttribute('data-section');
      const label = sec.getAttribute('data-section-title') || id;
      const active = id === state.settingsActiveSection;
      return `<button class="cc-chip" type="button" data-settings-nav="${escapeHtml(id)}" aria-pressed="${active}" title="${escapeHtml(sec.getAttribute('data-section-sub') || '')}">${escapeHtml(label)}</button>`;
    }).join('');

    // 同步 section 的 active 状态
    sections.forEach((sec) => {
      const id = sec.getAttribute('data-section');
      sec.setAttribute('data-active', id === state.settingsActiveSection ? 'true' : 'false');
    });

    // 绑定 chip click
    nav.querySelectorAll('[data-settings-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settingsActiveSection = btn.getAttribute('data-settings-nav');
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

  function renderAIProfiles() {
    if (!els.aiProfilesList) return;
    const profiles = Array.isArray(state.aiProfiles) ? state.aiProfiles : [];
    if (!profiles.length) {
      els.aiProfilesList.innerHTML = '<p class="muted">还没有 AI Profile，点击"新建 Profile"创建一个。</p>';
    } else {
      els.aiProfilesList.innerHTML = profiles.map((profile) => {
        const isActive = profile.id === state.activeProfileId;
        return `
          <div class="ai-profile-card${isActive ? ' active' : ''}" data-profile-id="${escapeHtml(profile.id)}">
            <div class="ai-profile-card-head">
              <strong>${escapeHtml(profile.name || '未命名')}</strong>
              ${isActive ? '<span class="pill ok">激活中</span>' : ''}
            </div>
            <div class="ai-profile-card-meta muted">
              ${escapeHtml(profile.provider || '-')} / ${escapeHtml(profile.model || '-')}
            </div>
            <div class="ai-profile-card-actions">
              <button class="btn small" type="button" data-action="activate" data-profile-id="${escapeHtml(profile.id)}">${isActive ? '已激活' : '激活'}</button>
              <button class="btn small ghost" type="button" data-action="edit" data-profile-id="${escapeHtml(profile.id)}">编辑</button>
              <button class="btn small ghost" type="button" data-action="duplicate" data-profile-id="${escapeHtml(profile.id)}">复制</button>
              <button class="btn small ghost" type="button" data-action="test" data-profile-id="${escapeHtml(profile.id)}">测试</button>
              <button class="btn small ghost" type="button" data-action="export" data-profile-id="${escapeHtml(profile.id)}">导出</button>
              <button class="btn small danger-btn" type="button" data-action="delete" data-profile-id="${escapeHtml(profile.id)}">删除</button>
            </div>
          </div>
        `;
      }).join('');

      els.aiProfilesList.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const action = btn.getAttribute('data-action');
          const profileId = btn.getAttribute('data-profile-id');
          const profile = state.aiProfiles.find((p) => p.id === profileId);
          if (!profile) return;
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

  function openAIProfileEditor(profile) {
    state.editingProfileId = profile?.id || null;
    if (els.aiProfileEditor) els.aiProfileEditor.classList.remove('hidden');
    if (els.aiProfileEditorTitle) els.aiProfileEditorTitle.textContent = profile ? `编辑 Profile：${profile.name || ''}` : '新建 Profile';
    if (els.aiProfileName) els.aiProfileName.value = profile?.name || '';
    if (els.aiProfileProvider) els.aiProfileProvider.value = profile?.provider || 'anthropic';
    if (els.aiProfileBaseUrl) els.aiProfileBaseUrl.value = profile?.baseUrl || '';
    if (els.aiProfileAnthropicBaseUrl) els.aiProfileAnthropicBaseUrl.value = profile?.anthropicBaseUrl || '';
    if (els.aiProfileToken) els.aiProfileToken.value = profile?.apiToken || '';
    if (els.aiProfileModel) els.aiProfileModel.value = profile?.model || '';
    if (els.aiProfileWireApi) els.aiProfileWireApi.value = profile?.wireApi || 'anthropic';
    if (els.aiProfileContextWindow) els.aiProfileContextWindow.value = profile?.contextWindow ? String(profile.contextWindow) : '';
    if (els.aiProfileMaxTokens) els.aiProfileMaxTokens.value = profile?.maxTokens ? String(profile.maxTokens) : '';
    if (els.aiProfileReasoningEffort) els.aiProfileReasoningEffort.value = profile?.reasoningEffort || '';
    if (els.aiProfileNotes) els.aiProfileNotes.value = profile?.notes || '';
    requestAnimationFrame(() => els.aiProfileEditor?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  function closeAIProfileEditor() {
    state.editingProfileId = null;
    if (els.aiProfileEditor) els.aiProfileEditor.classList.add('hidden');
  }

  function collectAIProfileForm() {
    const profile = {
      name: (els.aiProfileName?.value || '').trim(),
      provider: els.aiProfileProvider?.value || 'anthropic',
      baseUrl: (els.aiProfileBaseUrl?.value || '').trim(),
      anthropicBaseUrl: (els.aiProfileAnthropicBaseUrl?.value || '').trim() || undefined,
      apiToken: els.aiProfileToken?.value || '',
      model: (els.aiProfileModel?.value || '').trim(),
      wireApi: els.aiProfileWireApi?.value || 'anthropic',
      contextWindow: els.aiProfileContextWindow?.value ? Number(els.aiProfileContextWindow.value) : undefined,
      maxTokens: els.aiProfileMaxTokens?.value ? Number(els.aiProfileMaxTokens.value) : undefined,
      reasoningEffort: els.aiProfileReasoningEffort?.value || undefined,
      notes: (els.aiProfileNotes?.value || '').trim() || undefined,
    };
    if (state.editingProfileId) profile.id = state.editingProfileId;
    return profile;
  }

  function renderWorkspaceAIOverride() {
    const ov = state.workspaceAIOverride || {};
    if (els.aiWsOverrideEnabled) els.aiWsOverrideEnabled.checked = !!ov.enabled;
    if (els.aiWsProvider) els.aiWsProvider.value = ov.providerOverride || ov.provider || '';
    if (els.aiWsBaseUrl) els.aiWsBaseUrl.value = ov.baseUrlOverride || ov.baseUrl || '';
    if (els.aiWsToken) els.aiWsToken.value = ov.apiTokenOverride || ov.apiToken || '';
    if (els.aiWsModel) els.aiWsModel.value = ov.modelOverride || ov.model || '';
  }

  // ===== 今日 Coach 渲染 =====
  function renderCoachToday() {
    if (!els.coachTodaySection) return;
    els.coachTodaySection.classList.remove('hidden');
    const brief = state.dailyBrief;
    if (!brief) {
      if (els.coachBriefSubtitle) els.coachBriefSubtitle.textContent = '今天还没有简报。';
      if (els.coachBriefBody) els.coachBriefBody.innerHTML = '<p class="muted">点击右上角 ↻ 生成今日建议。</p>';
      return;
    }
    if (els.coachBriefSubtitle) {
      const dateLabel = brief.date || new Date().toLocaleDateString();
      els.coachBriefSubtitle.textContent = `更新于 ${escapeHtml(dateLabel)}`;
    }
    if (els.coachBriefBody) {
      const recap = brief.yesterdayRecap || brief.recap || '';
      const todayList = Array.isArray(brief.todaySuggestions) ? brief.todaySuggestions
                       : Array.isArray(brief.suggestions) ? brief.suggestions : [];
      const recapHtml = recap ? `<div class="coach-recap"><strong>昨日回顾</strong><div>${escapeHtml(recap)}</div></div>` : '';
      const todayHtml = todayList.length
        ? `<div class="coach-today-list"><strong>今日建议</strong><ul>${todayList.map((s) => `<li>${escapeHtml(typeof s === 'string' ? s : (s.title || s.body || ''))}</li>`).join('')}</ul></div>`
        : '';
      els.coachBriefBody.innerHTML = recapHtml + todayHtml || '<p class="muted">今日尚无建议。</p>';
    }
  }

  function renderCoachSuggestions() {
    if (!els.coachSuggestionsList) return;
    const items = Array.isArray(state.coachSuggestions) ? state.coachSuggestions : [];
    if (!items.length) {
      els.coachSuggestionsList.innerHTML = '';
      return;
    }
    els.coachSuggestionsList.innerHTML = items.map((s) => {
      // Evidence trail: payload.evidence 是 { kind, ref, summary, createdAt }[]，可选
      const evidence = (s.payload && Array.isArray(s.payload.evidence)) ? s.payload.evidence : [];
      const evidenceId = `ev-${escapeHtml(s.id)}`;
      const evidenceHtml = evidence.length ? `
        <div class="suggestion-evidence" id="${evidenceId}" hidden>
          <div class="evidence-title">为什么我看到这条建议？</div>
          <ul>
            ${evidence.slice(0, 5).map((e) => `
              <li>
                <strong>[${escapeHtml(e.kind || 'event')}]</strong>
                ${escapeHtml(e.summary || e.ref || '')}
                ${e.createdAt ? `<span class="muted">（${escapeHtml(e.createdAt.slice(0, 10))}）</span>` : ''}
              </li>
            `).join('')}
          </ul>
        </div>
      ` : '';
      const evidenceToggle = evidence.length
        ? `<button class="suggestion-evidence-toggle" type="button" data-toggle-evidence="${evidenceId}" title="展开 / 折叠驱动事件">为什么？</button>`
        : '';
      return `
        <div class="coach-chip urgency-${escapeHtml(s.urgency || 'low')}" data-suggestion-id="${escapeHtml(s.id)}">
          <span class="coach-chip-title">${escapeHtml(s.title || s.body || '')}</span>
          <span class="coach-chip-actions">
            ${evidenceToggle}
            <button class="coach-chip-act" type="button" data-suggestion-action="open" data-suggestion-id="${escapeHtml(s.id)}">查看</button>
            <button class="coach-chip-dismiss" type="button" data-suggestion-action="dismiss" data-suggestion-id="${escapeHtml(s.id)}" title="忽略">✕</button>
          </span>
          ${evidenceHtml}
        </div>
      `;
    }).join('');

    els.coachSuggestionsList.querySelectorAll('[data-suggestion-action]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const suggestionId = btn.getAttribute('data-suggestion-id');
        const action = btn.getAttribute('data-suggestion-action');
        if (action === 'dismiss') {
          vscode.postMessage({ type: 'coachDismissSuggestion', suggestionId });
        } else {
          vscode.postMessage({ type: 'coachAction', suggestionId });
        }
      });
    });
    els.coachSuggestionsList.querySelectorAll('[data-toggle-evidence]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const targetId = btn.getAttribute('data-toggle-evidence');
        if (!targetId) return;
        const target = document.getElementById(targetId);
        if (target) {
          target.hidden = !target.hidden;
        }
      });
    });
  }

  function updateDndButton() {
    if (!els.btnCoachDnd) return;
    const active = state.doNotDisturbUntil && new Date(state.doNotDisturbUntil).getTime() > Date.now();
    els.btnCoachDnd.textContent = active ? '🔔' : '🔕';
    els.btnCoachDnd.title = active
      ? `勿扰至 ${new Date(state.doNotDisturbUntil).toLocaleTimeString()}`
      : '勿扰 1 小时';
  }

  // ===== 学习计划渲染 =====
  function renderLearningPlan() {
    if (!els.learningPlanSection) return;
    if (!state.selectedSubject) {
      els.learningPlanSection.classList.add('hidden');
      return;
    }
    els.learningPlanSection.classList.remove('hidden');
    const plan = state.learningPlan;
    if (!plan) {
      if (els.planStatus) els.planStatus.textContent = '本课程暂无学习计划。点击右上角"编辑计划"创建。';
      if (els.planProgressBar) els.planProgressBar.classList.add('hidden');
      if (els.planMilestonesList) els.planMilestonesList.innerHTML = '';
      return;
    }
    const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
    const total = milestones.length;
    const done = milestones.filter((m) => m.status === 'done').length;
    const percent = total ? Math.round((done / total) * 100) : 0;
    if (els.planProgressBar) els.planProgressBar.classList.remove('hidden');
    if (els.planProgressFill) els.planProgressFill.style.width = `${percent}%`;
    if (els.planStatus) {
      const goal = plan.goal || {};
      els.planStatus.textContent = `目标：${goal.targetEndDate || '?'} / 每日 ${goal.dailyMinutes || '?'} 分钟 / 进度 ${done}/${total}（${percent}%）`;
    }
    if (els.planMilestonesList) {
      const today = new Date();
      els.planMilestonesList.innerHTML = milestones.map((m) => {
        const expectedDate = m.expectedDoneBy ? new Date(m.expectedDoneBy) : null;
        const overdue = m.status !== 'done' && expectedDate && expectedDate < today;
        const cls = overdue ? 'overdue' : m.status;
        const statusLabel = overdue ? '已延期' : (m.status === 'done' ? '完成' : m.status === 'in-progress' ? '进行中' : m.status === 'skipped' ? '跳过' : '待开始');
        return `
          <div class="plan-milestone status-${escapeHtml(cls)}">
            <span class="plan-milestone-title">${escapeHtml(m.topicTitle || m.topicId || '-')}</span>
            <span class="plan-milestone-date muted">${escapeHtml(m.expectedDoneBy || '-')}</span>
            <span class="plan-milestone-status">${escapeHtml(statusLabel)}</span>
          </div>
        `;
      }).join('');
    }
  }

  function openLearningPlanModal() {
    if (!state.selectedSubject) {
      addLog('请先选择课程后再编辑学习计划。', 'warn');
      return;
    }
    if (els.learningPlanModal) {
      els.learningPlanModal.classList.remove('hidden');
      els.learningPlanModal.setAttribute('aria-hidden', 'false');
    }
    const plan = state.learningPlan;
    if (els.planSubject) els.planSubject.value = subjectLabel(state.selectedSubject);
    if (els.planTargetDate) {
      const def = plan?.goal?.targetEndDate || (() => {
        const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10);
      })();
      els.planTargetDate.value = def;
    }
    if (els.planDailyMinutes) els.planDailyMinutes.value = String(plan?.goal?.dailyMinutes || 60);
    if (els.planExtraNotes) els.planExtraNotes.value = plan?.goal?.extraNotes || '';
  }

  function closeLearningPlanModal() {
    if (els.learningPlanModal) {
      els.learningPlanModal.classList.add('hidden');
      els.learningPlanModal.setAttribute('aria-hidden', 'true');
    }
  }

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
      if (els.resolvedConfigProvider) els.resolvedConfigProvider.textContent = '-';
      if (els.resolvedConfigOrigin) els.resolvedConfigOrigin.textContent = '-';
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
    els.resolvedConfigName.textContent = config.model || config.profileName || '-';
    const wireApi = config.wireApi ? ` / ${config.wireApi}` : '';
    els.resolvedConfigMeta.textContent = `${config.provider || '-'}${wireApi}`;
    els.resolvedConfigUrl.textContent = config.effectiveBaseUrl || config.baseUrl || '-';
    if (els.resolvedConfigOrigin) {
      els.resolvedConfigOrigin.textContent = config.resolvedFrom === 'workspace' || workspaceOverride?.enabled ? '项目覆盖' : '全局配置';
    }
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
    renderLearningPlan();
    renderInsights();
    refreshCourseProjectsSection();
    if (state.preferences) {
      renderPerSubjectDifficulty(state.preferences);
    }
    persist();
    requestWrongQuestions();
    if (state.selectedSubject) {
      vscode.postMessage({ type: 'getLearningPlan', subject: state.selectedSubject });
    }
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

  function renderProjectsList() {
    const el = document.getElementById('projects-list');
    if (!el) return;
    const subject = state.selectedSubject;
    if (!subject) {
      el.innerHTML = '<p class="muted">请先选择课程。</p>';
      return;
    }
    const items = (state.allProjects || []).filter((m) => m.subject === subject);
    if (items.length === 0) {
      el.innerHTML = '<p class="muted">还没有项目，点上方"＋ 新项目"创建一个。</p>';
      return;
    }
    el.innerHTML = '';
    for (const meta of items) {
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
        'archived': '已归档',
      }[meta.status] || meta.status;

      const techStackChips = (meta.techStack || [])
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => `<span class="pc-stack-chip">${escapeProjHtml(s)}</span>`)
        .join('');
      const projectDirShort = meta.projectDir
        ? meta.projectDir.split(/[/\\]/).slice(-2).join('/')
        : '';

      card.innerHTML = `
        <div class="project-card-header">
          <p class="project-card-title">${escapeProjHtml(meta.title)}</p>
          <span class="project-status-${meta.status} pc-status">● ${statusLabel}</span>
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
      card.querySelector('[data-act="delete"]').addEventListener('click', () => {
        vscode.postMessage({ type: 'deleteProject', projectId: meta.id, purgeFiles: false });
      });
      el.appendChild(card);
    }
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

  /** 当 selectedSubject / 课程 tags 变化时，刷新课程项目区显隐 + 两个 subsection。 */
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
      renderCourseProjectProposals();              // 📋 推荐 subsection（同步，从 state.courses 里读）
      vscode.postMessage({ type: 'listProjects' }); // ✓ 已创建 subsection（异步，回 'projectsList' 后 render）
    }
  }

  /**
   * 渲染"📋 推荐"subsection。数据源：当前 course.projects（outline 里 AI 附带的提案）。
   * 数据天然在 state.courses 里，不需要后端请求。
   */
  function renderCourseProjectProposals() {
    const wrap = document.getElementById('proj-subsection-proposals');
    const list = document.getElementById('proposals-list');
    if (!wrap || !list) return;
    if (!state.selectedSubject) {
      wrap.hidden = true;
      return;
    }
    const course = (state.courses || []).find((c) => c.subject === state.selectedSubject);
    const proposals = Array.isArray(course?.projects) ? course.projects : [];
    if (proposals.length === 0) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    list.innerHTML = proposals.map((p) => `
      <div class="proposal-card" data-proposal-id="${escapeProjHtml(p.id)}">
        <div class="proposal-card-head">
          <span class="proposal-card-title">${escapeProjHtml(p.title || '')}</span>
          <span class="proposal-card-diff">${'⭐'.repeat(Math.max(1, Math.min(5, Number(p.difficulty) || 3)))}</span>
        </div>
        <p class="proposal-card-desc">${escapeProjHtml(p.description || '')}</p>
        ${(p.suggestedTechStack || []).length
          ? `<div class="proposal-card-stack">${(p.suggestedTechStack || []).map((s) => `<span class="proposal-card-stack-pill">${escapeProjHtml(s)}</span>`).join('')}</div>`
          : ''}
        <div class="proposal-card-actions">
          ${p.realizedAs
            ? `<button class="btn small ghost" disabled>✓ 已落地</button>`
            : `<button class="btn small primary" data-act="realize-proposal" data-subject="${escapeProjHtml(course.subject)}" data-proposal-id="${escapeProjHtml(p.id)}">落地为项目</button>`}
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-act="realize-proposal"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const subject = btn.getAttribute('data-subject');
        const proposalId = btn.getAttribute('data-proposal-id');
        if (!subject || !proposalId) return;
        vscode.postMessage({ type: 'realizeProjectFromProposal', subject, proposalId });
      });
    });
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

  els.aiChangeMenu?.querySelectorAll('[data-ai-import-source]').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      const source = item.getAttribute('data-ai-import-source');
      if (!source) return;
      els.aiChangeMenu?.classList.add('hidden');
      vscode.postMessage({ type: 'importAIProfile', source });
    });
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
    if (event.key === 'Escape' && els.learningPlanModal && !els.learningPlanModal.classList.contains('hidden')) {
      closeLearningPlanModal();
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

  // Coach
  bindAutoSave(els.coachEnabled);
  els.coachLoopCheckboxes?.forEach((cb) => bindAutoSave(cb));
  els.coachToastLevelRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.coachDndStart);
  bindAutoSave(els.coachDndEnd);
  if (els.coachIdleThreshold) {
    els.coachIdleThreshold.addEventListener('input', () => {
      const v = els.coachIdleThreshold.value;
      if (els.coachIdleThresholdValue) els.coachIdleThresholdValue.textContent = `${v} 分钟`;
      schedulePreferenceSave();
    });
  }
  els.coachSrPolicyRadios?.forEach((r) => bindAutoSave(r));
  els.coachBriefCacheRadios?.forEach((r) => bindAutoSave(r));
  bindAutoSave(els.coachThrottleHour, 'input');
  bindAutoSave(els.coachThrottleDay, 'input');

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
    vscode.postMessage({ type: 'saveAIProfile', profile });
    closeAIProfileEditor();
    addLog(`已提交保存 Profile：${profile.name}`, 'info');
  });

  els.btnCancelAIProfile?.addEventListener('click', () => {
    closeAIProfileEditor();
  });

  // ===== Workspace AI Override =====
  els.btnSaveWsOverride?.addEventListener('click', () => {
    const override = {
      enabled: !!els.aiWsOverrideEnabled?.checked,
      baseProfileId: els.aiWsBaseProfile?.value || null,
      providerOverride: (els.aiWsProvider?.value || '').trim() || undefined,
      baseUrlOverride: (els.aiWsBaseUrl?.value || '').trim() || undefined,
      apiTokenOverride: els.aiWsToken?.value || undefined,
      modelOverride: (els.aiWsModel?.value || '').trim() || undefined,
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

  // ===== 今日 Coach 卡片交互 =====
  els.btnCoachRefreshBrief?.addEventListener('click', () => {
    vscode.postMessage({ type: 'getDailyBrief', force: true });
    addLog('正在刷新今日简报...', 'info');
  });

  els.btnCoachDnd?.addEventListener('click', () => {
    const active = state.doNotDisturbUntil && new Date(state.doNotDisturbUntil).getTime() > Date.now();
    if (active) {
      vscode.postMessage({ type: 'setDoNotDisturb', durationMinutes: 0 });
      state.doNotDisturbUntil = null;
    } else {
      vscode.postMessage({ type: 'setDoNotDisturb', durationMinutes: 60 });
      state.doNotDisturbUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    updateDndButton();
  });

  els.btnDnd1h?.addEventListener('click', () => {
    vscode.postMessage({ type: 'setDoNotDisturb', durationMinutes: 60 });
    state.doNotDisturbUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    updateDndButton();
  });

  els.btnDndToday?.addEventListener('click', () => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const minutes = Math.max(1, Math.round((end.getTime() - Date.now()) / 60000));
    vscode.postMessage({ type: 'setDoNotDisturb', durationMinutes: minutes });
    state.doNotDisturbUntil = end.toISOString();
    updateDndButton();
  });

  els.btnDndCustom?.addEventListener('click', () => {
    const raw = window.prompt('设置勿扰时长（分钟）', '120');
    if (!raw) return;
    const minutes = Math.max(1, Math.round(Number(raw) || 0));
    if (!minutes) return;
    vscode.postMessage({ type: 'setDoNotDisturb', durationMinutes: minutes });
    state.doNotDisturbUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    updateDndButton();
  });

  // ===== 学习计划交互 =====
  els.btnEditPlan?.addEventListener('click', openLearningPlanModal);
  els.btnCancelPlan?.addEventListener('click', closeLearningPlanModal);
  els.btnClosePlanModal?.addEventListener('click', closeLearningPlanModal);
  els.learningPlanModal?.addEventListener('click', (event) => {
    if (event.target === els.learningPlanModal) closeLearningPlanModal();
  });

  els.btnSavePlan?.addEventListener('click', () => {
    if (!state.selectedSubject) {
      addLog('请先选择课程。', 'warn');
      return;
    }
    const targetEndDate = els.planTargetDate?.value || '';
    const dailyMinutes = Number(els.planDailyMinutes?.value || 60);
    const extraNotes = (els.planExtraNotes?.value || '').trim();
    if (!targetEndDate) {
      addLog('请填写截止日期。', 'warn');
      return;
    }
    const plan = {
      subject: state.selectedSubject,
      goal: { targetEndDate, dailyMinutes, extraNotes: extraNotes || undefined },
      driftThresholdDays: 2,
    };
    vscode.postMessage({ type: 'setLearningPlan', plan, autoDecompose: true });
    addLog('正在让 AI 拆解学习计划...', 'info');
    closeLearningPlanModal();
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
        if (els.embeddingTestStatus) {
          const symbol = r.ok ? '✓' : '✗';
          const detail = r.dimension ? ` · ${r.dimension} 维` : '';
          const time = r.latencyMs ? ` (${r.latencyMs}ms)` : '';
          els.embeddingTestStatus.textContent = `${symbol} ${r.message || ''}${detail}${time}`;
          els.embeddingTestStatus.style.color = r.ok ? 'var(--vscode-charts-green, #4ec9b0)' : 'var(--vscode-charts-red, #f48771)';
        }
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
        renderResolvedAIConfig(msg.data || null, msg.workspaceOverride || null);
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
        break;
      }
      case 'workspaceAIOverride': {
        state.workspaceAIOverride = msg.data || null;
        renderWorkspaceAIOverride();
        break;
      }
      case 'dailyBrief': {
        state.dailyBrief = msg.data || null;
        renderCoachToday();
        break;
      }
      case 'coachSuggestions': {
        state.coachSuggestions = Array.isArray(msg.data) ? msg.data : [];
        renderCoachSuggestions();
        break;
      }
      case 'activityLog': {
        // 暂时只 console.log，留扩展点
        // eslint-disable-next-line no-console
        console.log('[activityLog]', msg.data);
        break;
      }
      case 'learningPlan': {
        state.learningPlan = msg.data || null;
        renderLearningPlan();
        break;
      }
      case 'doNotDisturbState': {
        state.doNotDisturbUntil = msg.until || null;
        updateDndButton();
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
  renderLearningPlan();
  renderCoachToday();
  renderCoachSuggestions();
  renderAIProfiles();
  renderWorkspaceAIOverride();
  updateDndButton();
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
  vscode.postMessage({ type: 'getDailyBrief' });
  vscode.postMessage({ type: 'getCoachSuggestions' });
  if (state.selectedSubject) {
    vscode.postMessage({ type: 'getLearningPlan', subject: state.selectedSubject });
  }
  // 创建课程的 tag chip 列表：启动时就 render，避免依赖 setCreateCourseMode 时机。
  // 即使 panel 现在是 hidden，DOM 也已就绪，innerHTML 写完后 chip 全部就位。
  renderNewCourseTagsChecklist();
})();
