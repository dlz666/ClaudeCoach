// ===== AI Layer =====
export type APIProvider = 'openai' | 'anthropic' | 'claude_code_cli';
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

// ===== 课程教学法分类 =====

/**
 * 课程标签：标识一门课的"教学法类型"。
 * 一门课可同时挂多个 tag（如算法课同时是 cs-theory + math-foundation）。
 * v1 落地的 tag：cs-skill / cs-theory / math-foundation / language / exam-prep。
 * 其他 5 个先留 stub，UI 可选但 prompt 暂不细化。
 */
export type CourseTag =
  | 'cs-skill'
  | 'cs-theory'
  | 'math-foundation'
  | 'math-advanced'
  | 'physics'
  | 'engineering'
  | 'language'
  | 'exam-prep'
  | 'humanities'
  | 'research';

export const COURSE_TAG_LABELS: Record<CourseTag, string> = {
  'cs-skill': '计算机技能',
  'cs-theory': '计算机系统课',
  'math-foundation': '数学基础',
  'math-advanced': '数学进阶',
  'physics': '物理',
  'engineering': '工程方法',
  'language': '语言学习',
  'exam-prep': '考试备考',
  'humanities': '人文社科',
  'research': '研究/论文',
};

export const COURSE_TAG_DESCRIPTIONS: Record<CourseTag, string> = {
  'cs-skill': '编程语言、框架、工具（如 React、Python、SQL、Git）',
  'cs-theory': '算法、操作系统、数据库、网络等系统课',
  'math-foundation': '微积分、线性代数、概率论、离散数学',
  'math-advanced': '实分析、抽象代数、拓扑、泛函',
  'physics': '力学、电磁、量子、热统',
  'engineering': '系统设计、架构、设计模式、产品思维',
  'language': '英语、二外，重在词汇/语法/听说读写',
  'exam-prep': '考研、托福、CFA、AP 等有固定题型的备考',
  'humanities': '哲学、历史、心理学、社会学',
  'research': '论文阅读、ML 理论、密码学进阶',
};

/** 单个 tag 的"教学范式"，会注入 prompt + 影响出题/简报/SR。 */
export interface CourseTagPlaybook {
  label: string;
  /** 讲义结构骨架，写到 lesson-gen prompt 末尾。 */
  lessonStructure: string;
  /** 默认练习题型分布 hint，覆盖全局 aiStyle.exerciseTypeMix。 */
  defaultExerciseMix?: { multipleChoice: number; freeResponse: number; code: number };
  /** 出题时给 AI 的额外指令。 */
  exerciseHint: string;
  /** 批改风格 hint。 */
  feedbackHint: string;
  /** 每日简报话术模板。 */
  briefStyleHint: string;
  /** 资料检索倾向 hint（让 AI 在 grounding 时优先什么）。 */
  retrievalHint: string;
  /** SR 第一次复习的间隔天数；默认 1。语言类缩短为 1 但后续节奏更密。 */
  srInitialInterval?: number;
  /** SR 间隔序列（覆盖默认 SM-2）。语言类用更密的 1/2/4/8/16。 */
  srIntervalSequence?: number[];
}

export const COURSE_TAG_PLAYBOOK: Record<CourseTag, CourseTagPlaybook> = {
  'cs-skill': {
    label: '计算机技能',
    lessonStructure:
      '讲义结构：① 关键概念（≤3 句） → ② 一段可运行的最小代码示例（含必要注释）→ ③ 常见踩坑/反例 → ④ 进阶变体或链接到官方文档',
    defaultExerciseMix: { multipleChoice: 5, freeResponse: 15, code: 80 },
    exerciseHint:
      '出题以"动手编码"为主：给真实场景，要求写代码或调试代码。少出纯概念选择题。如果用户语言偏好允许，提供 starter code 和测试用例。',
    feedbackHint:
      '批改时重点看：能不能跑、是否优雅、是否考虑了边界。错的不只是说"错了"，要指出"在哪一行出错、为什么"。',
    briefStyleHint:
      '日报话术：今天写了 X 道编程题，跑通 Y / 失败 Z。强调"动手量"。',
    retrievalHint:
      '资料检索时优先官方文档、API 参考、changelog；引用时附文档链接。',
    srInitialInterval: 2,
  },
  'cs-theory': {
    label: '计算机系统课',
    lessonStructure:
      '讲义结构：① 直觉/类比 → ② 形式定义 → ③ 算法伪码（带行号注释）→ ④ 复杂度分析（时间+空间）→ ⑤ 一个实现要点或经典优化',
    defaultExerciseMix: { multipleChoice: 30, freeResponse: 40, code: 30 },
    exerciseHint:
      '题型混合：概念辨析（判断/选择）、算法推演（手算 trace）、代码实现（关键步骤）。每道至少标注复杂度。',
    feedbackHint:
      '批改时关注：算法步骤是否正确、复杂度是否最优、是否考虑边界。指出更优解时给出复杂度对比。',
    briefStyleHint:
      '日报话术：今天过了 X 个算法/数据结构，掌握 Y 个复杂度分析。',
    retrievalHint:
      '资料检索时优先经典教材章节（CLRS/SICP）和论文摘要。',
  },
  'math-foundation': {
    label: '数学基础',
    lessonStructure:
      '讲义结构：① 直觉/几何意义（图或类比）→ ② 形式定义（精确符号）→ ③ 主要定理 + 证明大纲 → ④ 至少 2 道由浅到深的计算例题（含完整步骤）→ ⑤ 易错点提醒',
    defaultExerciseMix: { multipleChoice: 15, freeResponse: 60, code: 25 }, // freeResponse 当作"计算+证明"
    exerciseHint:
      '题型偏向"计算+证明"：60% 计算题（分步给中间结果）、25% 证明题（要求严谨步骤）、15% 概念辨析。题面避免无意义口语。',
    feedbackHint:
      '批改时指出：哪一步推导跳了、哪个量纲/符号写错、是否有"会做但写不严谨"。证明题要看清逻辑链每一环。',
    briefStyleHint:
      '日报话术：今天证了 X 个定理 / 完成 Y 道计算 / 卡住 Z 个步骤。',
    retrievalHint:
      '资料检索时优先教材习题集与例题；引用时给出章节号。',
  },
  'math-advanced': {
    label: '数学进阶',
    lessonStructure:
      '讲义结构：① 历史动机/为何引入 → ② 公理/定义 → ③ 主要定理及证明（关键步骤展开）→ ④ 反例/边界讨论 → ⑤ 推广方向',
    defaultExerciseMix: { multipleChoice: 5, freeResponse: 80, code: 15 },
    exerciseHint:
      '70% 证明题（强调严谨）+ 30% 概念辨析（含反例构造）。计算题极少。',
    feedbackHint:
      '批改重点：证明逻辑是否完备、是否漏掉了非平凡情况、记号是否标准。',
    briefStyleHint: '日报话术：今天读了 X 节，证明了 Y 个命题，构造了 Z 个反例。',
    retrievalHint: '资料检索优先经典原著（Rudin/Lang/Hatcher 等）。',
  },
  'physics': {
    label: '物理',
    lessonStructure:
      '讲义结构：① 物理现象 → ② 物理图像/类比 → ③ 数学建模（含量纲）→ ④ 推导公式 → ⑤ 应用/估算/极限情况检验',
    defaultExerciseMix: { multipleChoice: 20, freeResponse: 60, code: 20 },
    exerciseHint:
      '题型：50% 计算题（带量纲核对）、30% 概念图理解（画力图/势能图）、20% 实验/估算。',
    feedbackHint:
      '批改重点：物理图像是否清晰、量纲是否一致、极限情况是否合理（如 v→c）。',
    briefStyleHint: '日报话术：今天理解了 X 个现象的物理图像，跑通 Y 个估算。',
    retrievalHint: '资料优先教材习题 + Feynman Lectures 类经典。',
  },
  'engineering': {
    label: '工程方法',
    lessonStructure:
      '讲义结构：① 真实问题场景 → ② 候选方案 ABC → ③ 取舍矩阵（成本/可维护性/扩展性）→ ④ 真实公司案例参考',
    defaultExerciseMix: { multipleChoice: 10, freeResponse: 80, code: 10 },
    exerciseHint:
      '出开放题：给一个业务场景，要求设计方案 + 取舍说明。不追求"标准答案"，追求"决策路径清晰"。',
    feedbackHint: '批改时看：是否考虑了多个维度、取舍是否清楚、对约束条件是否敏感。',
    briefStyleHint: '日报话术：今天分析了 X 个系统/案例，权衡了 Y 个取舍。',
    retrievalHint: '资料优先工业界文章、System Design 经典著作、公司技术博客。',
  },
  'language': {
    label: '语言学习',
    lessonStructure:
      '讲义结构：① 高频词汇（含例句）→ ② 重点语法点（错例对比）→ ③ 听力/口语段落 → ④ 翻译练习 → ⑤ 自由输出引导',
    defaultExerciseMix: { multipleChoice: 30, freeResponse: 50, code: 0 }, // freeResponse 当作"翻译/写作"
    exerciseHint:
      '题型：30% 词汇填空、30% 语法判断、20% 中外互译、20% 短文自由写作。强调"频次而非难度"。',
    feedbackHint:
      '批改重点：母语干扰错误（如中式英语/日语助词）、地道表达替换、语法精度。',
    briefStyleHint:
      '日报话术：连续打卡 X 天，新词 Y 个，复习 Z 个。强调"连续性"和"节奏感"。',
    retrievalHint: '资料优先例句库、影视字幕、地道表达词典。',
    // 语言类 SR 节奏更密：1/2/4/8/16 天
    srInitialInterval: 1,
    srIntervalSequence: [1, 2, 4, 8, 16, 32],
  },
  'exam-prep': {
    label: '考试备考',
    lessonStructure:
      '讲义结构：① 高频考点定位 → ② 典型题型模板 → ③ 秒杀技巧/排除法 → ④ 历年真题对照 → ⑤ 易错陷阱',
    defaultExerciseMix: { multipleChoice: 60, freeResponse: 35, code: 5 },
    exerciseHint:
      '题型 80% 真题或真题变体 + 20% 考点 review。每题标注真题年份/考次（编造也要标"模拟"）。强调时限。',
    feedbackHint:
      '批改时除了对错，要指出"如果是真题在多长时间内必须做对"和"用什么套路秒杀"。',
    briefStyleHint:
      '日报话术：距考试还有 X 天，今日真题正确率 Y%，弱项 Z。',
    retrievalHint: '资料优先真题集、考纲、历年套卷。',
    // 考试型错题反复刷：1/1/2/4 间隔（前几次密集）
    srIntervalSequence: [1, 1, 2, 4, 8],
  },
  'humanities': {
    label: '人文社科',
    lessonStructure:
      '讲义结构：① 代表人物/学派 → ② 核心命题 → ③ 反对意见与代表性反例 → ④ 关键引文（带出处）→ ⑤ 当代相关性',
    defaultExerciseMix: { multipleChoice: 10, freeResponse: 80, code: 10 },
    exerciseHint:
      '70% 论述题（要求引文支撑）、20% 概念辨析、10% 引文出处。强调"多视角"，避免单一立场。',
    feedbackHint: '批改重点：论据是否扎实、引文是否贴切、是否给出对立观点。',
    briefStyleHint: '日报话术：今天读了 X 个学派/X 篇文献，对 Y 命题有了新理解。',
    retrievalHint: '资料优先经典著作 + 学术评论。',
  },
  'research': {
    label: '研究/论文',
    lessonStructure:
      '讲义结构：① 论文摘要梳理 → ② 方法核心创新 → ③ 实验设计与结果 → ④ 复现要点（数据/代码/超参）→ ⑤ 批判与扩展方向',
    defaultExerciseMix: { multipleChoice: 5, freeResponse: 70, code: 25 },
    exerciseHint:
      '题型：50% 复现（写代码/算公式）、30% 批判性问答、20% 数学推导。鼓励质疑论文。',
    feedbackHint: '批改重点：复现是否到位、批判是否有理、是否能提出 next-step 实验。',
    briefStyleHint: '日报话术：今天读了 X 篇论文，复现了 Y 个实验。',
    retrievalHint: '资料优先 arXiv / 顶会论文 / 知名 lab blog。',
  },
};

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
  /** 教学法分类 tag。一门课可挂多个（如 cs-theory + math-foundation）。 */
  tags?: CourseTag[];
  /**
   * AI 生成大纲时附带的项目提案。仅对动手类课程（cs-skill / cs-theory /
   * engineering）有意义，其他 tag 类型不要求 AI 输出。用户可在 UI 上点击
   * "落地为项目"把提案转成一个真正的 ProjectSpec。
   */
  projects?: CourseProjectProposal[];
}

export interface CourseProjectProposal {
  /** 课程内稳定 id（如 'proposal-01'），不是 ProjectMeta.id —— 转成真项目时
   * 才会有 ProjectMeta.id；这只是大纲内的占位锚点。 */
  id: string;
  title: string;
  description: string;
  learningGoals: string[];
  /** 1-5。 */
  difficulty: number;
  suggestedTechStack: string[];
  /** 标记是否已经被用户落地为真正的项目（meta.id）；落地后这里写真 id 防重复创建。 */
  realizedAs?: string;
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

// ===== Lesson Key Points =====
/**
 * 单个知识点。扁平存储 + parentId 推算层级（不嵌套 children，方便增删/重排）。
 * 元数据极简：只有 core（重点标记）+ note（自由文本），其他都不要
 * （mastered/kind/difficulty 试过都不实用，要么过期要么 enum 太死）。
 */
export interface KeyPointItem {
  id: string;
  title: string;
  /** 父知识点 id，根级为 null。用于推算缩进层级。 */
  parentId: string | null;
  /** 同 parent 下的排序号（越小越靠前）。 */
  order: number;
  /** ⭐ 重点标记。带 ⭐ 的知识点 → AI 讲义生成时详尽展开。 */
  core?: boolean;
  /** 自由文本备注（≤ 100 字符，单行）。AI 生成讲义时会按 note 处理这条知识点。 */
  note?: string;
}

/** 一个 lesson 对应的知识点清单。1 lesson : 1 keypoints 文件（lessonId 关联）。 */
export interface LessonKeyPoints {
  lessonId: string;
  /** schema 版本号，便于未来加字段做迁移。 */
  version: 1;
  /** AI 首次生成的 ISO 时间戳，nullable（用户手动新建的没有这个）。 */
  generatedAt?: string;
  items: KeyPointItem[];
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
  /**
   * AI 从学生作答里观察到的"风格 / 偏好"信号。
   * 例如答得过简 → 'too-brief'；答案大量正确但缺步骤 → 'needs-steps'。
   * 这些 tag 会聚合进 CourseProfile.overall.stablePreferences，驱动后续讲义
   * 的 preferredScaffolding / generationHints。
   */
  preferenceTags?: RevisionPreferenceTag[];
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
  /**
   * 弱项趋势：对该 chapter 内的 grade 事件按时序拆两半，比较 weaknessTag 出现率。
   * 仅当 chapter.gradeCount >= 4 时才计算（样本太少无意义）。
   * 注入 prompt 后形如 "logic 错误率 80%→30%（改善）" — 让 AI 知道学生在好转/恶化。
   */
  weaknessTrend?: WeaknessTrend[];
  /** 该 chapter 最近若干次 grade 的分数序列（最多 8 条），用于 UI 趋势线显示 */
  recentScores?: number[];
}

export interface WeaknessTrend {
  tag: FeedbackWeaknessTag;
  /** 前半时间窗的出现率 0-1 */
  prevRate: number;
  /** 后半时间窗的出现率 0-1 */
  currRate: number;
  /** 'improving' = curr 比 prev 低（好转）；'worsening' = curr 比 prev 高；'stable' = 差异 < 阈值 */
  direction: 'improving' | 'worsening' | 'stable';
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
export type FeedbackTone = 'direct' | 'encouraging' | 'socratic' | 'push' | 'playful';
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
    /**
     * 向量检索 (Hybrid RAG) 配置。embedding 模型可以与 chat 模型完全独立的
     * baseUrl/token，例如 chat 走 codex 中转，embedding 走硅基流动免费 bge-m3。
     */
    embedding?: {
      enabled?: boolean;
      /** OpenAI 兼容 endpoint，例如 https://api.siliconflow.cn/v1 */
      baseUrl?: string;
      apiToken?: string;
      /** 默认 BAAI/bge-m3（中英 + 跨语言均强、硅基流动免费提供） */
      model?: string;
      /** 向量维度，bge-m3 = 1024，OpenAI 3-small = 1536 */
      dimension?: number;
      /**
       * 关键词 vs 向量的融合权重，0=纯关键词、1=纯向量、0.5=均衡。
       * 实现走 RRF (Reciprocal Rank Fusion)，权重控制向量项的乘子。
       */
      hybridWeight?: number;
    };
    /**
     * Vision API 配置（PDF → markdown 深度提取）。
     * 默认 Qwen3-VL-8B（实测苏德矿微积分 31s/页 + 5 并发 ≈ 6s/页等效）
     * 跟 chat / embedding profile 解耦：可走任何 OpenAI 兼容 vision endpoint
     */
    vision?: {
      enabled?: boolean;
      baseUrl?: string;
      apiToken?: string;
      model?: string;
      /** 并发请求数，默认 5 */
      concurrency?: number;
      /** PDF → PNG 的 dpi，默认 200 */
      dpi?: number;
      /** 单页 max_tokens 默认 6000 */
      maxTokens?: number;
    };
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
  /**
   * 'rewrite'：默认。AI 输出会替换/插入到选区。
   * 'ask'：仅回答问题，不修改讲义；webview 应渲染纯气泡，无"采纳"按钮。
   */
  intent?: 'rewrite' | 'ask';
}

export interface InlineSuggestResult {
  turnId: string;
  status: 'preview' | 'applied' | 'failed';
  suggestion?: string;
  errorMessage?: string;
  /** auto-apply 模式时返回写回后的精确字符 range，便于前端高亮。 */
  appliedRange?: { startLine: number; endLine: number };
  /** 透传 intent，让 webview 决定渲染样式（'ask' 模式不显示"采纳"按钮）。 */
  intent?: 'rewrite' | 'ask';
}

export interface InlineApplyRequest {
  turnId: string;
  filePath: string;
  selectionText: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  /** 用户最终采纳的内容（可能是 AI 直出，也可能用户编辑过）。 */
  finalContent: string;
  /**
   * 调用者声明的意图，后端据此决定写回策略：
   *  - `rewrite`：把选区原文替换为 finalContent（destructive，需要选区精确匹配）。
   *  - `ask` / `idea`：把 finalContent 作为兄弟块**追加到选区所在 block 之后**，
   *    选区原文一字不动（non-destructive）。
   * 缺省时按 selectionText 是否为空回退到旧行为，保持向后兼容。
   */
  intent?: 'rewrite' | 'ask' | 'idea';
}

// ===== Materials =====

/** 资料类型：决定它在不同教学法 tag 下的检索权重。 */
export type MaterialType =
  | 'textbook'        // 教材/参考书
  | 'lecture-notes'   // 课堂笔记 / 讲义
  | 'official-doc'    // 官方文档 / API 参考（cs-skill 偏爱）
  | 'exam-paper'      // 真题 / 模拟卷（exam-prep 偏爱）
  | 'paper'           // 学术论文（research 偏爱）
  | 'cheatsheet'      // 速查表 / 知识点汇总
  | 'video-transcript'// 视频字幕（语言学习常用）
  | 'other';          // 未分类

export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  'textbook': '📚 教材/参考书',
  'lecture-notes': '📝 课堂笔记/讲义',
  'official-doc': '📖 官方文档/API',
  'exam-paper': '📋 真题/模拟卷',
  'paper': '📄 学术论文',
  'cheatsheet': '🗂 速查表/汇总',
  'video-transcript': '🎬 视频字幕',
  'other': '📁 其他',
};

/**
 * 每个 CourseTag 偏好的 MaterialType 权重表。检索时给匹配类型的资料加分。
 * 数值是加权分（直接加到 chunk score 上）。
 */
export const TAG_MATERIAL_TYPE_WEIGHTS: Record<CourseTag, Partial<Record<MaterialType, number>>> = {
  'cs-skill': { 'official-doc': 15, 'cheatsheet': 8, 'lecture-notes': 5, 'textbook': 3 },
  'cs-theory': { 'textbook': 12, 'lecture-notes': 10, 'paper': 6, 'official-doc': 4 },
  'math-foundation': { 'textbook': 15, 'lecture-notes': 10, 'cheatsheet': 5 },
  'math-advanced': { 'textbook': 12, 'paper': 12, 'lecture-notes': 8 },
  'physics': { 'textbook': 12, 'lecture-notes': 10, 'cheatsheet': 5 },
  'engineering': { 'paper': 8, 'official-doc': 8, 'lecture-notes': 6, 'textbook': 5 },
  'language': { 'video-transcript': 12, 'cheatsheet': 10, 'textbook': 6 },
  'exam-prep': { 'exam-paper': 20, 'cheatsheet': 12, 'textbook': 6, 'lecture-notes': 4 },
  'humanities': { 'textbook': 12, 'paper': 10, 'lecture-notes': 6 },
  'research': { 'paper': 18, 'lecture-notes': 6, 'textbook': 4 },
};

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
  /** 资料类型，影响检索时按 tag 加权。可选——旧资料默认 'other'。 */
  materialType?: MaterialType;
  /**
   * 实际用的提取方式（影响下游 textbookParser / _chunkText 选 markdown 还是 plain 路径）。
   * 'vision' → markdown（含 LaTeX 公式）
   * 'pdf-parse' / 'windows-ocr' → plain text
   */
  extractMethod?: 'vision' | 'pdf-parse' | 'windows-ocr';
  /** 可选用户反馈得分（建议 7：检索质量 👍 / 👎），用于推荐升级提取方式 */
  qualityScore?: number;
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

// ===== Projects (TDD-style learning project) =====
//
// 设计哲学：AI 写**测试 + 骨架**，user 写**核心实现**。
// 流程：
//   1. AI 生成 spec → 写到磁盘成完整可跑的 project 目录
//      - boilerplate（package.json / 配置 / 入口文件）
//      - test 骨架（test cases，body 是 placeholder 或 TODO 注释）
//      - user stub 文件（带类型签名 + TODO 注释的空函数）
//      - README + TODO.md（说明：你的任务、怎么跑测试、验收标准）
//   2. user 在 IDE 自己写 stub 文件里的实现
//   3. user 自己跑 testCommand，看 pass/fail，自己迭代
//   4. user 卡住 → 跑回 ClaudeCoach 侧边栏问 AI
// 不做：spawn `claude -p` agent / 自动写代码 / 自动跑测试 / resume checkpoint。

/** 项目所属学科。`cs` / `engineering` / `frontier-research` / 或任意自定义 string。 */
export type ProjectSubject = string;

/** 一个 project 在生命周期中的状态。 */
export type ProjectStatus =
  | 'spec-pending'    // AI 还在生成 spec
  | 'scaffolded'      // 文件已写到磁盘，user 可以打开 IDE 开干
  | 'in-progress'     // user 报告了至少一次进展
  | 'completed'       // user 标记已完成
  | 'files-cleared'   // 项目文件已被用户清空（仅保留 .coach-meta + .coach-spec），等待重新生成
  | 'archived';       // 归档不再追踪

/** 单个文件在 project 里的角色。决定 user 看到它时该怎么对待。 */
export type ProjectFileRole =
  | 'boilerplate'     // AI 写完整内容，user 不该改（package.json / 配置文件 / 入口）
  | 'test-skeleton'   // AI 写测试骨架（test name + describe），body 是 `it.todo()` 或 placeholder
  | 'user-stub'       // AI 写函数签名 + TODO 注释，user 来填实现
  | 'doc';            // README / TODO.md / 学习目标文档

/** AI 在生成 spec 阶段，每个文件的"密度"标注。 */
export type ProjectStubDensity =
  | 'thin'    // 仅签名 + 一行 TODO
  | 'medium'  // 签名 + TODO 列表注释 + import 占位
  | 'thick';  // medium + 关键 API 注释提示 + 步骤拆分

/** AI 生成的一个完整 project 规约（写盘前的中间数据）。 */
export interface ProjectSpec {
  /** 项目标题，e.g. "Implement minimal SSM in PyTorch" */
  title: string;
  /** 1-2 句话描述：要学什么 + 最终成果。 */
  description: string;
  /** 学习目标（user 完成后能 demo 出来的能力）。 */
  learningGoals: string[];
  /** 前置知识。AI 应该谨慎判断 user 是否具备。 */
  prerequisites: string[];
  /** 用到的技术栈，e.g. ["TypeScript", "Vitest", "React 19"]。 */
  techStack: string[];
  /** 运行测试的 shell 命令，e.g. "npm test"。user 在自己终端跑。 */
  testCommand: string;
  /** 完整的文件列表（含 boilerplate / test 骨架 / user stub / doc）。 */
  files: ProjectFileSpec[];
  /** user 要做的事，按顺序列出。 */
  todos: ProjectTodo[];
  /** Markdown 描述：怎么验证完成（运行什么、看到什么算 pass）。 */
  testStrategy: string;
}

export interface ProjectFileSpec {
  /** 相对项目根的路径，e.g. "src/hooks/useCounter.ts" */
  path: string;
  /** 角色，决定 user 看到时怎么对待。 */
  role: ProjectFileRole;
  /** 完整文件内容（boilerplate / test 骨架 / user stub 都是完整的可跑代码）。 */
  content: string;
  /** 仅 user-stub 用：stub 密度。 */
  stubDensity?: ProjectStubDensity;
}

export interface ProjectTodo {
  id: string;                       // "todo-1", "todo-2"
  description: string;              // user 看到的描述
  targetFile: string;               // "src/hooks/useCounter.ts"
  /** 用什么测试 verify，e.g. "tests/useCounter.test.ts 的 'should increment' case 应 pass"。 */
  checkCriteria?: string;
  /** AI 标注的实现难度，1-5。 */
  difficulty?: number;
}

/** 持久化到 `.coach-meta.json` 的 project 元数据（不含 spec 全文）。 */
export interface ProjectMeta {
  id: string;
  subject: ProjectSubject;
  title: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;                // ISO timestamp
  updatedAt: string;                // ISO timestamp
  /** 绝对路径：user 项目目录所在位置。可在 `~/ClaudeCoach/workspaces/<wsId>/projects/<subject>/<id>/` */
  projectDir: string;
  testCommand: string;
  techStack: string[];
  /** AI 生成的 spec 是否还能找到（spec.json 在 projectDir 里）。 */
  hasSpec: boolean;
  /** 可选：关联到课程主题。 */
  linkedCourse?: {
    subject: Subject;
    topicId?: string;
    lessonId?: string;
  };
  /** user 的进度自报告：完成了多少 todo / 总 todo 数。 */
  progress?: {
    completedTodos: number;
    totalTodos: number;
    lastUpdated: string;
  };
}

/** 生成 project 的入参（user 在 UI 里填的）。 */
export interface CreateProjectRequest {
  subject: ProjectSubject;
  /** user 输入的"我想做什么"，AI 据此出 spec。 */
  prompt: string;
  /** 可选：tech stack 偏好（"React 19"、"Python 3.12"），不填 AI 自己选。 */
  techStackHint?: string;
  /** 可选：关联到课程主题。 */
  linkedCourse?: ProjectMeta['linkedCourse'];
  /** 项目目录名（user 可改，否则用 sanitize(title)）。 */
  dirName?: string;
}

/** spec 生成 + 文件 scaffold 的结果。 */
export interface ProjectScaffoldResult {
  ok: boolean;
  meta?: ProjectMeta;
  spec?: ProjectSpec;
  errorMessage?: string;
  warnings?: string[];
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
  /**
   * 召回通道：'keyword'=仅关键词命中、'vector'=仅向量相似、'both'=双命中。
   * Hybrid 模式下可选，纯关键词模式下保持 undefined。
   */
  retrievedBy?: 'keyword' | 'vector' | 'both';
  /** 向量相似度（cosine），仅 vector / both 时存在。 */
  vectorScore?: number;
  /** 关键词 IDF 分，仅 keyword / both 时存在。 */
  keywordScore?: number;
}

/** prompt 上下文的注入范围。`buildSystemBase` 按这个 scope 裁剪。 */
export type PromptContextScope =
  | 'chat'
  | 'lesson-gen'
  | 'exercise-gen'
  | 'grade'
  | 'diagnosis'
  | 'outline-gen'
  | 'lecture-edit'
  | 'project-spec';

// ===== Sidebar Messages =====
export type SidebarCommand =
  | {
      /** 生成课程**预览**（不写盘）。返回 'coursePreview' 响应。用户可以继续 refine
       * 或 apply。这条 message 名沿用，但语义从"立即生成并保存"变成"先出预览"。 */
      type: 'generateCourse';
      subject: Subject;
      tags?: CourseTag[];
      difficulty?: 'beginner' | 'basic' | 'intermediate' | 'challenge';
      /** 学习目标：完成课程后想能做到什么（key field）。 */
      learningGoal?: string;
      /** 已有基础：用户表明的"我已经会的部分"，AI 会跳过。 */
      existingKnowledge?: string;
      /** 大纲规模偏好：决定 topic / lesson 颗粒度。 */
      outlineSize?: 'ai-decide' | 'quick' | 'half-semester' | 'full-semester';
      /** 偏重风格（可多选）：影响讲义结构、出题分布、复习节奏。 */
      styleEmphasis?: Array<'practice' | 'theory' | 'drill' | 'intuition'>;
      /** 兜底：自然语言额外说明 / 限制。 */
      instruction?: string;
    }
  /** 基于上一份预览 + 用户的自然语言修改建议，重新生成预览。 */
  | { type: 'refineCoursePreview'; previewId: string; instruction: string }
  /** 把缓存的预览写盘成正式课程大纲。 */
  | { type: 'applyCoursePreview'; previewId: string }
  /** 丢弃缓存的预览（用户关掉 UI / 取消生成）。 */
  | { type: 'discardCoursePreview'; previewId: string }
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
  | { type: 'importMaterial'; subject: Subject; materialType?: MaterialType }
  | { type: 'setMaterialType'; materialId: string; materialType: MaterialType }
  | { type: 'getPreferences' }
  | { type: 'savePreferences'; preferences: LearningPreferences }
  | { type: 'getCourses' }
  | { type: 'setCourseTags'; subject: Subject; tags: CourseTag[] }
  | { type: 'getMaterials' }
  | { type: 'importAIProfile'; source: AIImportSource }
  | { type: 'getResolvedAIConfig' }
  // ===== AI Profile 完整编辑（Phase 2C） =====
  | { type: 'listAIProfiles' }
  | { type: 'saveAIProfile'; profile: Partial<AIProfile> & { name: string; provider: APIProvider; baseUrl: string; anthropicBaseUrl: string; model: string } }
  | { type: 'duplicateAIProfile'; profileId: string }
  | { type: 'activateAIProfile'; profileId: string }
  | { type: 'saveWorkspaceAIOverride'; override: AIWorkspaceOverride }
  | { type: 'testAIProfile'; profile?: Partial<AIProfile> }
  | { type: 'exportAIProfile'; profileId: string; includeToken?: boolean }
  // ===== 数据管理（Phase 2D） =====
  | { type: 'clearWrongQuestions'; subject: Subject; requireConfirm?: boolean }
  | { type: 'clearDiagnosisHistory'; subject: Subject; requireConfirm?: boolean }
  | { type: 'resetCourseProgress'; subject: Subject; requireConfirm?: boolean }
  | { type: 'exportLearningData' }
  | { type: 'importLearningData'; requireConfirm?: boolean }
  | { type: 'resetAllPreferences'; requireConfirm?: boolean }
  | { type: 'exportPreferences' }
  | { type: 'importPreferences' }
  | { type: 'deleteAIProfile'; profileId: string; profileName?: string }
  // ===== Hybrid RAG（向量检索） =====
  | { type: 'testEmbedding'; config: { baseUrl: string; apiToken: string; model: string; dimension?: number } }
  | { type: 'reindexAllVectors'; subject: Subject; requireConfirm?: boolean }
  | { type: 'reindexSingleMaterial'; subject: Subject; materialId: string }
  | { type: 'reindexAllSubjectsAllVectors'; requireConfirm?: boolean }
  | { type: 'reparseMaterialSummary'; subject: Subject; materialId: string }
  | { type: 'reextractMaterialVision'; subject: Subject; materialId: string }
  | { type: 'getVectorIndexStats'; subject: Subject }
  // ===== Adaptive Insights =====
  | { type: 'getCourseProfile'; subject: Subject }
  // 流式难度：基于刚做完几道题的表现，再出一道单题
  | {
      type: 'practiceAdaptiveNext';
      subject: Subject;
      topicId: string;
      lessonId: string;
      lessonTitle: string;
      topicTitle: string;
      baseDifficulty: number;
    }
  // ===== Inline 内联编辑（Phase 1） =====
  | { type: 'openLectureViewer'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string }
  | { type: 'inlineSuggest'; request: InlineSuggestRequest }
  | { type: 'inlineApply'; request: InlineApplyRequest }
  | { type: 'inlineDismiss'; turnId: string }
  // ===== Projects (TDD-style learning project) =====
  | { type: 'createProject'; request: CreateProjectRequest }
  | { type: 'listProjects'; subject?: ProjectSubject }
  | { type: 'openProject'; projectId: string }
  | { type: 'deleteProject'; projectId: string; purgeFiles?: boolean }
  | { type: 'updateProjectProgress'; projectId: string; completedTodos: number; status?: ProjectStatus }
  | { type: 'getProjectSpec'; projectId: string }
  /** 把大纲里的 CourseProjectProposal 落地为真项目（auto-fill 项目生成）。 */
  | { type: 'realizeProjectFromProposal'; subject: Subject; proposalId: string }
  /** 清空项目目录里的所有代码文件，**保留** .coach-meta + .coach-spec + 列表条目。
   * 用于"我想重新生成代码"场景，不删 meta 是为了保留 desc / techStack / 进度等元数据。 */
  | { type: 'clearProjectFiles'; projectId: string }
  /** 把一个**从提案落地而来**的真项目完全退回提案阶段：删项目目录 + 删 meta +
   * 清掉 proposal.realizedAs，让提案卡片重新出现可供再次"落地为项目"。 */
  | { type: 'revertProjectToProposal'; projectId: string };

export type SidebarResponse =
  | { type: 'courses'; data: CourseOutline[] }
  | { type: 'outlineRebuildPreview'; data: OutlineRebuildPreviewResult }
  | { type: 'outlineRebuildApplied'; previewId: string; mode: OutlineRebuildMode; outline: CourseOutline }
  | { type: 'courseGenerated'; outline: CourseOutline }
  /** 预览版课程大纲（未写盘）。带 previewId 供后续 refine / apply / discard。 */
  | {
      type: 'coursePreview';
      previewId: string;
      subject: Subject;
      outline: CourseOutline;
      /** 给前端：上一次用户给的修改指令（如果是 refine 产物）。 */
      lastRefineInstruction?: string;
      warnings?: string[];
    }
  | { type: 'coursePreviewDiscarded'; previewId: string }
  | { type: 'gradeResult'; result: GradeResult }
  | { type: 'diagnosis'; data: LatestDiagnosis | null }
  | { type: 'preferences'; data: LearningPreferences }
  | {
      type: 'materials';
      data: MaterialIndex;
      /** 可选：每份资料的向量索引状态，用于资料卡片显示 */
      vectorStats?: Record<string, {
        exists: boolean;
        chunks: number;
        chapters?: number;
        version?: number;
        model?: string;
        dimension?: number;
      }>;
    }
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
  // ===== AI 流式输出（chatCompletion onDelta 暴露给前端）=====
  // 用 turnId 关联到具体的 inline turn / chat message / 其它后续扩展通道。
  // channel 让前端知道这条 delta 该往哪个组件追加（讲义气泡 / 侧栏对话 / 大纲预览等）。
  | { type: 'aiStreamDelta'; turnId: string; channel: 'lecture' | 'chat' | 'outline'; delta: string }
  | { type: 'aiStreamEnd'; turnId: string; channel: 'lecture' | 'chat' | 'outline'; finalText?: string; error?: string }
  // ===== AI Profile 响应 =====
  | { type: 'aiProfilesList'; data: AIProfile[]; activeProfileId: string }
  // ===== 数据管理响应 =====
  | { type: 'dataOpResult'; operation: string; ok: boolean; message?: string }
  // ===== Hybrid RAG 响应 =====
  | {
      type: 'embeddingTestResult';
      data: { ok: boolean; message: string; dimension?: number; latencyMs?: number };
    }
  | {
      type: 'vectorReindexComplete';
      data: { ok: boolean; processed: number; failed: number };
    }
  | {
      type: 'vectorIndexStats';
      data: {
        subject: Subject;
        stats: Array<{
          materialId: string;
          fileName: string;
          exists: boolean;
          chunks: number;
          model?: string;
          dimension?: number;
          updatedAt?: string;
        }>;
      };
    }
  // Insights Panel：精简版 courseProfile（去掉 recentEvents）
  | {
      type: 'courseProfile';
      subject: Subject;
      data: {
        subject: Subject;
        courseTitle: string;
        updatedAt: string;
        overall: CourseProfileOverall;
        chapters: Array<Pick<
          CourseProfileChapter,
          'topicId' | 'chapterNumber' | 'title' | 'status' | 'masteryPercent' |
          'gradeCount' | 'weaknessTags' | 'strengthTags' | 'weaknessTrend' | 'recentScores'
        >>;
      };
    }
  // ===== Project 模块响应 =====
  | { type: 'projectsList'; subject?: ProjectSubject; data: ProjectMeta[] }
  | { type: 'projectCreated'; meta: ProjectMeta; spec: ProjectSpec; warnings?: string[] }
  | { type: 'projectScaffoldFailed'; errorMessage: string }
  | { type: 'projectSpec'; projectId: string; spec: ProjectSpec | null }
  | { type: 'projectOpened'; projectId: string; projectDir: string }
  | { type: 'projectProgressUpdated'; meta: ProjectMeta }
  | { type: 'projectDeleted'; projectId: string }
  | { type: 'error'; message: string }
  | { type: 'loading'; active: boolean; task?: string }
  | { type: 'log'; message: string; level: 'info' | 'warn' | 'error' };
