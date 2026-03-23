// ===== AI Layer =====
export type APIProvider = 'openai' | 'anthropic';
export type AIImportSource = 'manual' | 'claude' | 'codex' | 'package';

export interface AIConfig {
  provider: APIProvider;
  baseUrl: string;
  anthropicBaseUrl: string;
  apiToken: string;
  model: string;
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
  overrides?: Partial<Pick<AIProfile, 'provider' | 'baseUrl' | 'anthropicBaseUrl' | 'apiToken' | 'model' | 'contextWindow' | 'maxTokens' | 'notes'>>;
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
  };
  language: {
    content: 'zh' | 'en' | 'mixed';
    exercises: 'zh' | 'en' | 'mixed';
    codeComments: 'zh' | 'en';
  };
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

// ===== Token Budget =====
export interface TokenBudget {
  modelContextWindow: number;
  reserveForOutput: number;
  fixedPromptTokens: number;
  availableForHistory: number;
}

// ===== Sidebar Messages =====
export type SidebarCommand =
  | { type: 'generateCourse'; subject: Subject }
  | { type: 'rebuildCourseOutline'; subject: Subject; materialId?: string }
  | { type: 'generateLesson'; topicId: string; lessonId: string }
  | { type: 'generateExercises'; lessonId: string; count: number }
  | { type: 'openOrGenerateLesson'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string; difficulty: number }
  | { type: 'openLessonContent'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string }
  | { type: 'openOrGenerateExercises'; subject: Subject; topicId: string; topicTitle: string; lessonId: string; lessonTitle: string; count: number; difficulty: number }
  | { type: 'resetLessonProgress'; subject: Subject; topicId: string; lessonId: string; lessonTitle: string }
  | { type: 'markLessonCompleted'; subject: Subject; topicId: string; lessonId: string; lessonTitle: string }
  | { type: 'submitAnswer'; exerciseId: string; answer: string }
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
  | { type: 'getAIProfiles' }
  | { type: 'saveAIProfile'; profile: Partial<AIProfile> & Pick<AIProfile, 'name' | 'provider' | 'baseUrl' | 'anthropicBaseUrl' | 'apiToken' | 'model' | 'contextWindow' | 'maxTokens' | 'source'> }
  | { type: 'deleteAIProfile'; profileId: string }
  | { type: 'duplicateAIProfile'; profileId: string }
  | { type: 'activateAIProfile'; profileId: string }
  | { type: 'getResolvedAIConfig' }
  | { type: 'saveWorkspaceAIOverride'; override: AIWorkspaceOverride }
  | { type: 'importAIProfile'; source: AIImportSource }
  | { type: 'exportAIProfile'; profileId: string; includeToken?: boolean }
  | { type: 'testAIProfile'; profile?: Partial<AIProfile> };

export type SidebarResponse =
  | { type: 'courses'; data: CourseOutline[] }
  | { type: 'courseGenerated'; outline: CourseOutline }
  | { type: 'gradeResult'; result: GradeResult }
  | { type: 'diagnosis'; data: LatestDiagnosis | null }
  | { type: 'preferences'; data: LearningPreferences }
  | { type: 'materials'; data: MaterialIndex }
  | { type: 'materialPreview'; data: MaterialPreview }
  | { type: 'aiProfiles'; data: AIProfilesState }
  | { type: 'resolvedAIConfig'; data: ResolvedAIConfig; workspaceOverride: AIWorkspaceOverride }
  | { type: 'aiImportResult'; data: AIImportPreview }
  | { type: 'aiTestResult'; success: boolean; message: string }
  | { type: 'error'; message: string }
  | { type: 'loading'; active: boolean; task?: string }
  | { type: 'log'; message: string; level: 'info' | 'warn' | 'error' };
