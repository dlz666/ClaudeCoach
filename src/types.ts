// ===== AI Layer =====
export type APIProvider = 'openai' | 'anthropic';
export type AIImportSource = 'manual' | 'claude' | 'codex' | 'package';
export type AIWireApi = 'chat_completions' | 'responses';

export interface AIConfig {
  provider: APIProvider;
  baseUrl: string;
  anthropicBaseUrl: string;
  apiToken: string;
  model: string;
  wireApi?: AIWireApi;
  reasoningEffort?: string;
  maxTokens?: number;
  contextWindow: number;
}

export interface AIProfile extends AIConfig {
  id: string;
  name: string;
  notes?: string;
  source: AIImportSource;
  createdAt: string;
  updatedAt: string;
}

export interface AIProfilesState {
  version: number;
  activeProfileId: string;
  profiles: AIProfile[];
}

export interface AIWorkspaceOverride {
  enabled: boolean;
  baseProfileId?: string;
  overrides?: Partial<Pick<AIProfile, 'provider' | 'baseUrl' | 'anthropicBaseUrl' | 'apiToken' | 'model' | 'wireApi' | 'reasoningEffort' | 'contextWindow' | 'maxTokens' | 'notes'>>;
}

export interface ResolvedAIConfig extends AIConfig {
  profileId: string;
  profileName: string;
  profileSource: AIImportSource;
  resolvedFrom: 'global' | 'workspace';
  warnings: string[];
  effectiveBaseUrl: string;
  availableHistoryTokens: number;
}

export interface AIImportPreview {
  profile: AIProfile;
  importedFrom: AIImportSource;
  activated: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ===== Subjects =====
export type Subject = string;

export const SUBJECT_LABELS: Record<string, string> = {
  'calculus': '微积分',
  'linear-algebra': '线性代数',
  'discrete-math': '离散数学',
  'react': 'React',
  'programming': '编程基础',
};

export function subjectLabel(subject: Subject): string {
  return SUBJECT_LABELS[subject] ?? subject;
}

// ===== Course Structure =====
export interface CourseOutline {
  id: string;
  subject: Subject;
  title: string;
  topics: TopicOutline[];
  createdAt: string;
}

export interface TopicOutline {
  id: string;
  code?: string;
  chapterNumber?: number;
  slug?: string;
  title: string;
  lessons: LessonMeta[];
}

export interface LessonMeta {
  id: string;
  code?: string;
  chapterNumber?: number;
  lessonNumber?: number;
  slug?: string;
  title: string;
  difficulty: number;
  status: 'not-started' | 'in-progress' | 'completed';
  filePath: string;
}

// ===== Exercises & Grading =====
export interface Exercise {
  id: string;
  lessonId: string;
  prompt: string;
  difficulty: number;
  type: 'free-response' | 'multiple-choice' | 'code';
}

export interface GradeResult {
  exerciseId: string;
  score: number;
  feedback: string;
  strengths: string[];
  weaknesses: string[];
  strengthTags?: FeedbackStrengthTag[];
  weaknessTags?: FeedbackWeaknessTag[];
  confidence?: 'low' | 'medium' | 'high';
  gradedAt: string;
}

export interface TopicSummary {
  topicId: string;
  subject: Subject;
  totalSessions: number;
  averageScore: number;
  scores: number[];
  mistakeTypes: Record<string, number>;
  lastUpdated: string;
}

// ===== Student Profile =====
export interface StudentProfile {
  name: string;
  level: string;
  subjects: Subject[];
  goals: string[];
  startDate: string;
  totalSessions: number;
  totalExercises: number;
}

export type FeedbackWeaknessTag =
  | 'concept'
  | 'syntax'
  | 'logic'
  | 'edge-case'
  | 'complexity'
  | 'debugging'
  | 'other';

export type FeedbackStrengthTag =
  | 'accuracy'
  | 'reasoning'
  | 'clarity'
  | 'structure'
  | 'application'
  | 'other';

export type RevisionPreferenceTag =
  | 'too-abstract'
  | 'needs-steps'
  | 'needs-example'
  | 'too-verbose'
  | 'too-brief'
  | 'notation-confusing'
  | 'pace-too-fast'
  | 'pace-too-slow';

export type CourseFeedbackEventType =
  | 'grade'
  | 'diagnosis'
  | 'lecture-revision'
  | 'answer-revision';

export interface CourseFeedbackEvent {
  id: string;
  type: CourseFeedbackEventType;
  subject: Subject;
  topicId?: string | null;
  lessonId?: string | null;
  createdAt: string;
  summary: string;
  weaknessTags: FeedbackWeaknessTag[];
  strengthTags: FeedbackStrengthTag[];
  preferenceTags?: RevisionPreferenceTag[];
  rawRefs: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface CourseProfileOverall {
  learnerLevelEstimate: string;
  preferredExplanationStyle: string[];
  commonWeaknessTags: FeedbackWeaknessTag[];
  commonStrengthTags: FeedbackStrengthTag[];
  stablePreferences: RevisionPreferenceTag[];
  responseHints: string[];
  generationHints: string[];
}

export interface CourseProfileChapter {
  topicId: string;
  chapterNumber?: number;
  title: string;
  status: LessonMeta['status'];
  masteryPercent: number | null;
  gradeCount: number;
  lastStudiedAt: string | null;
  weaknessTags: FeedbackWeaknessTag[];
  strengthTags: FeedbackStrengthTag[];
  misconceptions: string[];
  preferredScaffolding: string[];
  answeringHints: string[];
}

export interface CourseProfile {
  schemaVersion: number;
  subject: Subject;
  courseTitle: string;
  updatedAt: string;
  overall: CourseProfileOverall;
  chapters: CourseProfileChapter[];
  recentEvents: CourseFeedbackEvent[];
}

// ===== Learning Diagnosis =====
export interface SubjectSnapshot {
  subject: string;
  mastery: number;
  recentTrend: 'improving' | 'stable' | 'declining';
  topStrengths: string[];
  topWeaknesses: string[];
  keyMistakePatterns: string[];
  recommendedFocus: string;
}

export interface LatestDiagnosis {
  updatedAt: string;
  subject?: Subject;
  subjectSnapshots: SubjectSnapshot[];
  overallStrategy: string;
  nextSteps: string[];
}

// ===== Learning Preferences =====

export type LessonDetailLevel = 'concise' | 'standard' | 'detailed';
export type FeedbackTone = 'direct' | 'encouraging' | 'socratic';
export type ExplanationStyle = 'example-first' | 'formula-first' | 'intuition-first' | 'rigor-first';
export type MathSymbolStyle = 'english-standard' | 'chinese';
export type RetrievalStrictness = 'strict' | 'inclusive';
export type LectureViewerMode = 'lecture-webview' | 'native-preview' | 'split-both';
export type LectureApplyMode = 'auto-apply' | 'preview-confirm';
export type ToastLevel = 'always' | 'high-urgency-only' | 'never';
export type SRVariantStrategy = 'ai-variant' | 'repeat-original' | 'ask-each-time';
export type DailyBriefCacheStrategy = 'per-day' | 'always-fresh';
export type DefaultTab = 'learn' | 'chat' | 'materials' | 'settings' | 'logs';
export type StudyTimeSlot = 'morning' | 'afternoon' | 'evening';

export interface LearningPreferences {
  difficulty: {
    global: 'beginner' | 'basic' | 'intermediate' | 'challenge';
    perSubject: Partial<Record<Subject, 'beginner' | 'basic' | 'intermediate' | 'challenge'>>;
    exerciseMix: { easy: number; medium: number; hard: number };
  };
  pace: {
    dailyGoalMinutes: number;
    exercisesPerSession: number;
    speed: 'slow' | 'medium' | 'fast';
    reviewEveryNLessons: number;
    /** 每周第几天为休息日（0=周日 ... 6=周六）。drift 检测时不计入。 */
    restDays?: number[];
    /** 学习时段偏好。Coach 在勾选的时段才主动提醒。 */
    studyTimeSlots?: StudyTimeSlot[];
  };
  language: {
    content: 'zh' | 'en' | 'mixed';
    exercises: 'zh' | 'en' | 'mixed';
    codeComments: 'zh' | 'en';
  };
  /** AI 风格与内容偏好。每一项都会接通到 prompt。 */
  aiStyle?: {
    lessonDetail?: LessonDetailLevel;
    feedbackTone?: FeedbackTone;
    explanationStyles?: ExplanationStyle[];
    mathSymbol?: MathSymbolStyle;
    /** 练习类型权重，三项加和 100。 */
    exerciseTypeMix?: { multipleChoice: number; freeResponse: number; code: number };
    includeProofs?: boolean;
    includeHistory?: boolean;
  };
  /** 资料检索行为。 */
  retrieval?: {
    defaultGrounding?: boolean;
    strictness?: RetrievalStrictness;
    citeSources?: boolean;
    maxExcerpts?: number;
  };
  /** UI 偏好。 */
  ui?: {
    fontSize?: number;
    defaultTab?: DefaultTab;
    expandCourseTree?: boolean;
    showEmoji?: boolean;
    theme?: 'auto' | 'high-contrast';
  };
  /** Coach 主动行为。 */
  coach?: {
    active?: boolean;
    loops?: {
      dailyBrief?: boolean;
      idle?: boolean;
      sr?: boolean;
      metacog?: boolean;
      drift?: boolean;
    };
    notifications?: {
      toastLevel?: ToastLevel;
      quietHoursStart?: string;
      quietHoursEnd?: string;
    };
    throttle?: {
      maxToastsPerHour?: number;
      maxBannersPerHour?: number;
    };
    doNotDisturbUntil?: string | null;
    idleThresholdMinutes?: number;
    sr?: {
      variantStrategy?: SRVariantStrategy;
    };
    dailyBrief?: {
      cacheStrategy?: DailyBriefCacheStrategy;
    };
    lecture?: {
      viewerMode?: LectureViewerMode;
      applyMode?: LectureApplyMode;
      syncSourceEditor?: boolean;
      highlightChangesMs?: number;
    };
  };
}

// ===== Coach: 主动学习核心 schemas =====

/** 学习计划：用户设定的目标 + AI 拆解的每日清单。 */
export interface PlanMilestone {
  topicId: string;
  topicTitle: string;
  expectedDoneBy: string; // ISO date
  status: 'pending' | 'in-progress' | 'done' | 'skipped';
}

export interface LearningPlan {
  schemaVersion: number;
  subject: Subject;
  /** 用户结构化输入 + 可选自由文本说明。 */
  goal: {
    targetEndDate: string;     // ISO
    dailyMinutes: number;
    extraNotes?: string;        // 用户自由补充
  };
  createdAt: string;
  updatedAt: string;
  milestones: PlanMilestone[];
  /** 落后多少天才告警。 */
  driftThresholdDays: number;
  lastDriftCheckAt?: string | null;
}

/** 学习会话：本次打开扩展期间的活动汇总。 */
export interface StudySession {
  id: string;
  startedAt: string;
  endedAt?: string;
  activeMillis: number;
  lessonsTouched: string[];        // lessonId 列表
  exercisesSubmitted: number;
  trigger: 'webview-visible' | 'editor-open' | 'manual';
  lastActivityAt: string;
}

/** 间隔重复队列项。复用 WrongQuestion 作为源头，元数据单存。 */
export interface SpacedRepetitionItem {
  id: string;
  sourceWrongQuestionId: string;
  subject: Subject;
  topicId: string;
  lessonId: string;
  repetitionCount: number;
  easeFactor: number;
  intervalDays: number;
  nextDueAt: string;
  lastReviewedAt?: string | null;
  /** 上次重测的质量（0=完全错，5=完美）。映射自 score。 */
  lastQuality?: number;
}

export interface SpacedRepetitionQueue {
  schemaVersion: number;
  subject: Subject;
  items: SpacedRepetitionItem[];
  updatedAt: string;
}

/** Coach 候选建议。生命周期在 Suggestion 池内管理。 */
export type CoachSuggestionKind =
  | 'daily-brief'
  | 'idle-nudge'
  | 'sr-due'
  | 'metacog-question'
  | 'drift-alert'
  | 'related-lesson'
  | 'streak-up'
  | 'streak-down'
  | 'next-step';

export type CoachSuggestionUrgency = 'low' | 'medium' | 'high';

export interface CoachSuggestionAction {
  label: string;
  command: string;
  args?: Record<string, unknown>;
}

export interface CoachSuggestion {
  id: string;
  kind: CoachSuggestionKind;
  subject?: Subject;
  topicId?: string;
  lessonId?: string;
  createdAt: string;
  expiresAt?: string;
  urgency: CoachSuggestionUrgency;
  title: string;
  body: string;
  actions: CoachSuggestionAction[];
  /** 去重键。同 dedupKey 的旧建议会被新建议替换或合并。 */
  dedupKey: string;
  dispatchedAt?: string | null;
  dismissedAt?: string | null;
  actedAt?: string | null;
}

/** 用户活动事件（轻量）。 */
export type LearnerActivityKind =
  | 'lesson-open'
  | 'lecture-render'
  | 'inline-suggest'
  | 'inline-apply'
  | 'exercise-open'
  | 'exercise-submit'
  | 'webview-visible'
  | 'webview-hidden'
  | 'editor-typing'
  | 'idle-detected'
  | 'coach-suggestion-dispatched'
  | 'coach-suggestion-acted'
  | 'coach-suggestion-dismissed';

export interface LearnerActivityEntry {
  at: string;
  kind: LearnerActivityKind;
  subject?: Subject;
  topicId?: string;
  lessonId?: string;
  meta?: Record<string, unknown>;
}

/** Daily brief 缓存条目。 */
export interface DailyBriefEntry {
  dateKey: string;       // YYYY-MM-DD
  subject?: Subject;
  generatedAt: string;
  yesterdayRecap: string;
  todaySuggestions: string[];
  srDueCount: number;
  planProgress?: {
    completedMilestones: number;
    totalMilestones: number;
    daysAhead: number;   // 正数=领先，负数=落后
  };
}

export interface DailyBriefCache {
  schemaVersion: number;
  entries: DailyBriefEntry[];
}

/** Inline 编辑：webview 与后端之间的消息载荷。 */
export interface InlineSuggestRequest {
  filePath: string;
  selectionText: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  instruction: string;
  applyMode: LectureApplyMode;
  /** 由前端生成的 turn id，用于关联 response。 */
  turnId: string;
}

export interface InlineSuggestResult {
  turnId: string;
  status: 'preview' | 'applied' | 'failed';
  suggestion?: string;
  errorMessage?: string;
  /** auto-apply 模式时返回写回后的精确字符 range，便于前端高亮。 */
  appliedRange?: { startLine: number; endLine: number };
}

export interface InlineApplyRequest {
  turnId: string;
  filePath: string;
  selectionText: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  /** 用户最终采纳的内容（可能是 AI 直出，也可能用户编辑过）。 */
  finalContent: string;
}

// ===== Materials =====
export interface MaterialEntry {
  id: string;
  fileName: string;
  subject: Subject;
  filePath: string;
  textPath: string;
  summaryPath: string;
  storageDir?: string;
  status: 'pending' | 'extracted' | 'indexed' | 'failed';
  addedAt: string;
  updatedAt?: string;
  indexedAt?: string;
  lastError?: string;
}

export interface MaterialIndex {
  materials: MaterialEntry[];
}

export interface MaterialPreview {
  materialId: string;
  title: string;
  content: string;
  format: 'markdown' | 'text';
  sourceLabel: string;
}

export interface MaterialChapterSummary {
  chapterNumber?: string;
  title: string;
  summary: string;
  keyPoints: string[];
  topicMapping: string[];
  sectionNumbers?: string[];
  relatedExerciseTitles?: string[];
}

export interface MaterialSectionMapping {
  chapterNumber?: string;
  chapterTitle?: string;
  sectionNumber?: string;
  sectionTitle: string;
  summary: string;
  keyPoints: string[];
  topicMapping: string[];
  anchorTerms: string[];
  relatedExerciseTitles?: string[];
}

export interface MaterialExerciseMapping {
  chapterNumber?: string;
  chapterTitle?: string;
  sectionNumber?: string;
  sectionTitle?: string;
  title: string;
  exerciseType: string;
  summary: string;
  keyPoints: string[];
  topicMapping: string[];
  anchorTerms: string[];
  relatedSections?: string[];
}

export interface MaterialSummary {
  materialId: string;
  documentType?: 'textbook' | 'notes' | 'mixed' | 'unknown';
  chapters: MaterialChapterSummary[];
  sectionMappings?: MaterialSectionMapping[];
  exerciseMappings?: MaterialExerciseMapping[];
  parserMeta?: {
    source: 'single-pass' | 'textbook-parser' | 'heuristic' | 'hybrid';
    chunkCount: number;
    generatedAt: string;
    truncated?: boolean;
  };
}

export type ChatGroundingMode = 'general' | 'course' | 'material';
export type OutlineRebuildMode = 'full' | 'partial';

export interface OutlineRebuildSelection {
  startIndex: number;
  endIndex: number;
}

export interface OutlineRebuildPreviewRequest {
  subject: Subject;
  mode: OutlineRebuildMode;
  selection?: OutlineRebuildSelection;
  instruction?: string;
  materialIds?: string[];
}

export interface OutlineRebuildApplyRequest {
  previewId: string;
}

export interface OutlineRebuildImpactSummary {
  titleChanged: boolean;
  oldTitle: string;
  newTitle: string;
  oldTopicCount: number;
  newTopicCount: number;
  replacedTopicCount: number;
  replacementTopicCount: number;
  affectedRangeLabel?: string;
  clearedTopicTitles: string[];
  renumberedTopicTitles: string[];
  selectedMaterialTitles: string[];
  instruction?: string;
}

export interface OutlineRebuildPreviewResult {
  previewId: string;
  subject: Subject;
  mode: OutlineRebuildMode;
  outline: CourseOutline;
  impact: OutlineRebuildImpactSummary;
  selection?: OutlineRebuildSelection;
  materialIds: string[];
  materialTitles: string[];
  instruction?: string;
}

// ===== Token Budget =====
export interface TokenBudget {
  modelContextWindow: number;
  reserveForOutput: number;
  fixedPromptTokens: number;
  availableForHistory: number;
}

// ===== Adaptive Learning =====

/** 一道未掌握的练习题，用于错题本 + 后续重出。 */
export interface WrongQuestion {
  id: string;
  exerciseId: string;
  subject: Subject;
  topicId: string;
  topicTitle: string;
  lessonId: string;
  lessonTitle: string;
  prompt: string;
  studentAnswer: string;
  score: number;
  feedback: string;
  weaknesses: string[];
  weaknessTags: FeedbackWeaknessTag[];
  attempts: number;
  firstFailedAt: string;
  lastAttemptedAt: string;
  resolved: boolean;
  resolvedAt?: string;
}

export interface WrongQuestionBook {
  schemaVersion: number;
  subject: Subject;
  questions: WrongQuestion[];
  updatedAt: string;
}

/** 自动诊断触发器状态 + 实时连胜/连败追踪。 */
export interface AdaptiveTriggerState {
  schemaVersion: number;
  subject: Subject;
  gradesSinceLastDiagnosis: number;
  lastDiagnosisAt: string | null;
  lastAutoRunAt: string | null;
  /** 同向连胜/连败计数。当前方向由 streakDirection 决定。 */
  streak?: number;
  streakDirection?: 'up' | 'down' | null;
  /** 上次连胜/连败被推送 suggestion 的时间（避免重复推）。 */
  lastStreakSuggestionAt?: string | null;
  /** 跨课时 weakness tag 出现次数缓存（用于 related-lesson suggestion）。 */
  weaknessTagOccurrences?: Record<string, string[]>; // tag → topicId 列表
}

export type AdaptiveTriggerReason =
  | 'grade-threshold'
  | 'time-elapsed'
  | 'manual'
  | 'first-time';

/** 一次"答题提交"携带的所有信息，用于批改 + 错题本写入。 */
export interface AnswerSubmission {
  exerciseId: string;
  answer: string;
}

// ===== Grounding Sources =====

/** 一段被检索到、并且真正注入 prompt 的资料片段，用于前端来源回显。 */
export interface GroundingSource {
  materialId: string;
  fileName: string;
  excerpt: string;
  score: number;
  sectionLabel?: string;
}

/** prompt 上下文的注入范围。`buildSystemBase` 按这个 scope 裁剪。 */
export type PromptContextScope =
  | 'chat'
  | 'lesson-gen'
  | 'exercise-gen'
  | 'grade'
  | 'diagnosis'
  | 'outline-gen'
  | 'lecture-edit';

// ===== Sidebar Messages =====
export type SidebarCommand =
  | { type: 'generateCourse'; subject: Subject }
  | { type: 'rebuildCourseOutline'; subject: Subject; materialId?: string }
  | { type: 'previewRebuildCourseOutline'; request: OutlineRebuildPreviewRequest }
  | { type: 'applyRebuildCourseOutline'; request: OutlineRebuildApplyRequest }
  | { type: 'generateLesson'; topicId: string; lessonId: string }
  | { type: 'generateExercises'; lessonId: string; count: number }
  | { type: 'openOrGenerateLesson'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string; difficulty: number }
  | { type: 'openLessonContent'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string }
  | { type: 'openOrGenerateExercises'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string; count: number; difficulty: number }
  | { type: 'resetLessonProgress'; subject: Subject; topicId: string; lessonId: string; lessonTitle: string }
  | { type: 'markLessonCompleted'; subject: Subject; topicId: string; lessonId: string; lessonTitle: string }
  | { type: 'submitAnswer'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string; exerciseId: string; answer: string }
  | { type: 'submitAllAnswers'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string; answers: AnswerSubmission[] }
  | { type: 'scanAllExercises' }
  | { type: 'reprocessAllMarkdown' }
  | { type: 'retryMaterial'; materialId: string }
  | { type: 'getWrongQuestions'; subject?: Subject }
  | { type: 'practiceWrongQuestions'; subject: Subject; topicId: string; lessonId: string; lessonTitle: string; count?: number }
  | { type: 'resolveWrongQuestion'; subject: Subject; questionId: string }
  | { type: 'chat'; message: string; subject?: Subject; mode?: ChatGroundingMode; materialId?: string }
  | { type: 'getProgress' }
  | { type: 'getDiagnosis'; subject?: Subject; run?: boolean }
  | { type: 'openFile'; filePath: string }
  | { type: 'previewMaterial'; materialId: string }
  | { type: 'importMaterial'; subject: Subject }
  | { type: 'getPreferences' }
  | { type: 'savePreferences'; preferences: LearningPreferences }
  | { type: 'getCourses' }
  | { type: 'getMaterials' }
  | { type: 'importAIProfile'; source: AIImportSource }
  | { type: 'getResolvedAIConfig' }
  // ===== AI Profile 完整编辑（Phase 2C） =====
  | { type: 'listAIProfiles' }
  | { type: 'saveAIProfile'; profile: Partial<AIProfile> & { name: string; provider: APIProvider; baseUrl: string; anthropicBaseUrl: string; model: string } }
  | { type: 'deleteAIProfile'; profileId: string }
  | { type: 'duplicateAIProfile'; profileId: string }
  | { type: 'activateAIProfile'; profileId: string }
  | { type: 'saveWorkspaceAIOverride'; override: AIWorkspaceOverride }
  | { type: 'testAIProfile'; profile?: Partial<AIProfile> }
  | { type: 'exportAIProfile'; profileId: string; includeToken?: boolean }
  // ===== 数据管理（Phase 2D） =====
  | { type: 'clearWrongQuestions'; subject: Subject }
  | { type: 'clearDiagnosisHistory'; subject: Subject }
  | { type: 'resetCourseProgress'; subject: Subject }
  | { type: 'exportLearningData' }
  | { type: 'importLearningData' }
  // ===== Inline 内联编辑（Phase 1） =====
  | { type: 'openLectureViewer'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string }
  | { type: 'inlineSuggest'; request: InlineSuggestRequest }
  | { type: 'inlineApply'; request: InlineApplyRequest }
  | { type: 'inlineDismiss'; turnId: string }
  // ===== Coach（Phase 2-3） =====
  | { type: 'getDailyBrief'; subject?: Subject; force?: boolean }
  | { type: 'coachAction'; suggestionId: string }
  | { type: 'coachDismissSuggestion'; suggestionId: string }
  | { type: 'setDoNotDisturb'; durationMinutes: number | null }
  | { type: 'getLearningPlan'; subject: Subject }
  | { type: 'setLearningPlan'; plan: Omit<LearningPlan, 'schemaVersion' | 'createdAt' | 'updatedAt' | 'milestones' | 'lastDriftCheckAt'> & { autoDecompose?: boolean } }
  | { type: 'updateLearningPlanMilestones'; subject: Subject; milestones: PlanMilestone[] }
  | { type: 'metacogAnswer'; subject: Subject; topicId: string; lessonId: string; question: string; answer: string }
  | { type: 'getCoachSuggestions' }
  | { type: 'getActivityLog' };

export type SidebarResponse =
  | { type: 'courses'; data: CourseOutline[] }
  | { type: 'outlineRebuildPreview'; data: OutlineRebuildPreviewResult }
  | { type: 'outlineRebuildApplied'; previewId: string; mode: OutlineRebuildMode; outline: CourseOutline }
  | { type: 'courseGenerated'; outline: CourseOutline }
  | { type: 'gradeResult'; result: GradeResult }
  | { type: 'diagnosis'; data: LatestDiagnosis | null }
  | { type: 'preferences'; data: LearningPreferences }
  | { type: 'materials'; data: MaterialIndex }
  | { type: 'materialPreview'; data: MaterialPreview }
  | { type: 'resolvedAIConfig'; data: ResolvedAIConfig; workspaceOverride: AIWorkspaceOverride }
  | { type: 'aiImportResult'; data: AIImportPreview }
  | { type: 'aiTestResult'; success: boolean; message: string }
  | { type: 'wrongQuestions'; subject?: Subject; data: WrongQuestion[] }
  | { type: 'gradingProgress'; current: number; total: number; lessonTitle?: string }
  | { type: 'autoDiagnosisRan'; subject: Subject; reason: AdaptiveTriggerReason }
  | { type: 'groundingSources'; turnId: string; sources: GroundingSource[] }
  // ===== Inline 内联编辑响应 =====
  | { type: 'inlineSuggestResult'; result: InlineSuggestResult }
  | { type: 'inlineApplied'; turnId: string; appliedRange?: { startLine: number; endLine: number } }
  | { type: 'lectureFileChanged'; filePath: string; content: string }
  // ===== Coach 响应 =====
  | { type: 'dailyBrief'; data: DailyBriefEntry }
  | { type: 'coachSuggestions'; data: CoachSuggestion[] }
  | { type: 'activityLog'; data: LearnerActivityEntry[] }
  | { type: 'learningPlan'; subject: Subject; data: LearningPlan | null }
  | { type: 'doNotDisturbState'; until: string | null }
  | { type: 'coachStreakUpdate'; subject: Subject; streak: number; direction: 'up' | 'down' | 'reset' }
  // ===== AI Profile 响应 =====
  | { type: 'aiProfilesList'; data: AIProfile[]; activeProfileId: string }
  // ===== 数据管理响应 =====
  | { type: 'dataOpResult'; operation: string; ok: boolean; message?: string }
  | { type: 'error'; message: string }
  | { type: 'loading'; active: boolean; task?: string }
  | { type: 'log'; message: string; level: 'info' | 'warn' | 'error' };
