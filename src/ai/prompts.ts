import {
  ChatMessage,
  Subject,
  LearningPreferences,
  LatestDiagnosis,
  StudentProfile,
  CourseOutline,
  CourseProfile,
  CourseProfileChapter,
  CourseTag,
  COURSE_TAG_LABELS,
  COURSE_TAG_PLAYBOOK,
  FeedbackStrengthTag,
  FeedbackWeaknessTag,
  subjectLabel,
} from '../types';
import { PromptContextScope } from '../types';
import type { MultimodalChatMessage } from './client';

function preferencesContext(prefs: LearningPreferences | null): string {
  if (!prefs) { return ''; }

  const diffLabel: Record<string, string> = {
    beginner: '入门',
    basic: '基础',
    intermediate: '进阶',
    challenge: '挑战',
  };
  const langLabel: Record<string, string> = {
    zh: '中文',
    en: '英文',
    mixed: '中英混合（术语英文，解释中文）',
  };
  const speedLabel: Record<string, string> = {
    slow: '慢速（多复习）',
    medium: '中速',
    fast: '快速',
  };
  const detailLabel: Record<string, string> = {
    concise: '精简（点到为止，目标 600-1200 字）',
    standard: '标准（详略得当，目标 1500-2500 字）',
    detailed: '详尽（充分展开推导和例子，目标 3000-5000 字）',
  };
  const toneLabel: Record<string, string> = {
    direct: '直接：开门见山，不寒暄，错就是错对就是对',
    encouraging: '鼓励性：对正确部分明确肯定，对错误以建设性方式指出',
    socratic: '苏格拉底式：多用反问引导学生自己发现答案，不要直接给结论',
    push: 'Push 型：把标准定得稍高于学生当前水平，明确指出懒散与回避；用紧迫感和高期望推动学生走出舒适区，但仍尊重事实',
    playful: '有趣型：语气活泼，善用类比、脑洞例子、轻度调侃；可以用 emoji 调节气氛，但不可让玩笑遮盖知识点本身',
  };
  const styleLabelMap: Record<string, string> = {
    'example-first': '例子优先（先给具体场景再抽象）',
    'formula-first': '公式优先（先给精确数学表达再解释）',
    'intuition-first': '直觉优先（先建立感性理解再走形式化）',
    'rigor-first': '严谨证明优先（先给定理证明再讲应用）',
  };
  const mathLabel: Record<string, string> = {
    'english-standard': '使用英文标准数学符号（如 ∀, ∃, ∈, ⊆）',
    'chinese': '使用中文常见符号习惯（集合用「」、推导用"故"、"由此得"）',
  };

  let result = `
学生偏好设置：
- 整体难度：${diffLabel[prefs.difficulty.global] ?? prefs.difficulty.global}
- 练习难度分布：简单 ${prefs.difficulty.exerciseMix.easy}% / 中等 ${prefs.difficulty.exerciseMix.medium}% / 困难 ${prefs.difficulty.exerciseMix.hard}%
- 学习速度：${speedLabel[prefs.pace.speed] ?? prefs.pace.speed}
- 每次练习数量：${prefs.pace.exercisesPerSession} 题
- 每日学习目标：${prefs.pace.dailyGoalMinutes ?? 60} 分钟
- 内容语言：${langLabel[prefs.language.content] ?? prefs.language.content}
- 练习语言：${langLabel[prefs.language.exercises] ?? prefs.language.exercises}
- 代码注释语言：${langLabel[prefs.language.codeComments] ?? prefs.language.codeComments}
`;

  // AI 风格与内容（如果用户配置了）
  if (prefs.aiStyle) {
    const styleParts: string[] = [];
    if (prefs.aiStyle.lessonDetail) {
      styleParts.push(`- 讲义详尽度：${detailLabel[prefs.aiStyle.lessonDetail] ?? prefs.aiStyle.lessonDetail}`);
    }
    if (prefs.aiStyle.feedbackTone) {
      styleParts.push(`- 反馈口吻：${toneLabel[prefs.aiStyle.feedbackTone] ?? prefs.aiStyle.feedbackTone}`);
    }
    if (prefs.aiStyle.explanationStyles && prefs.aiStyle.explanationStyles.length > 0) {
      const styles = prefs.aiStyle.explanationStyles.map((s) => styleLabelMap[s] ?? s).join('；');
      styleParts.push(`- 解释风格偏好：${styles}`);
    }
    if (prefs.aiStyle.mathSymbol) {
      styleParts.push(`- 数学符号习惯：${mathLabel[prefs.aiStyle.mathSymbol] ?? prefs.aiStyle.mathSymbol}`);
    }
    if (prefs.aiStyle.exerciseTypeMix) {
      const m = prefs.aiStyle.exerciseTypeMix;
      styleParts.push(`- 练习类型偏好：选择 ${m.multipleChoice ?? 30}% / 问答 ${m.freeResponse ?? 50}% / 代码 ${m.code ?? 20}%`);
    }
    if (prefs.aiStyle.includeProofs === false) {
      styleParts.push('- 不要在讲义中包含完整证明，给出关键引理与思路即可');
    } else if (prefs.aiStyle.includeProofs) {
      styleParts.push('- 讲义中可以包含必要的证明步骤');
    }
    if (prefs.aiStyle.includeHistory) {
      styleParts.push('- 讲义可适当包含历史背景与人物故事，加深印象');
    }
    if (styleParts.length > 0) {
      result += `\nAI 风格与内容偏好（请严格遵循）：\n${styleParts.join('\n')}\n`;
    }
  }

  return result;
}

function diagnosisContext(diag: LatestDiagnosis | null): string {
  if (!diag) { return ''; }

  let ctx = `\n最新学习诊断（${diag.updatedAt}）：\n整体策略：${diag.overallStrategy}\n`;
  for (const snapshot of diag.subjectSnapshots) {
    ctx += `- ${snapshot.subject}：掌握度 ${snapshot.mastery}% ，趋势 ${snapshot.recentTrend}`;
    if (snapshot.topWeaknesses.length) {
      ctx += `，薄弱点：${snapshot.topWeaknesses.join('、')}`;
    }
    ctx += '\n';
  }
  return ctx;
}

function profileContext(profile: StudentProfile | null): string {
  if (!profile) {
    return '学生：计算机专业大一新生\n';
  }

  const goals = profile.goals.length ? profile.goals.join('、') : '暂无明确目标';
  return `学生：${profile.name}，水平 ${profile.level}，目标：${goals}，已完成 ${profile.totalExercises} 道练习\n`;
}

function courseProfileContext(courseProfile: CourseProfile | null): string {
  if (!courseProfile) {
    return '';
  }

  const lines: string[] = [`\n课程级画像（${courseProfile.courseTitle}）：`];
  if (courseProfile.overall.learnerLevelEstimate) {
    lines.push(`- 课程估计水平：${courseProfile.overall.learnerLevelEstimate}`);
  }
  if (courseProfile.overall.commonWeaknessTags.length) {
    lines.push(`- 常见薄弱点：${courseProfile.overall.commonWeaknessTags.join('、')}`);
  }
  if (courseProfile.overall.commonStrengthTags.length) {
    lines.push(`- 常见优势：${courseProfile.overall.commonStrengthTags.join('、')}`);
  }
  if (courseProfile.overall.preferredExplanationStyle.length) {
    lines.push(`- 偏好讲解风格：${courseProfile.overall.preferredExplanationStyle.join('、')}`);
  }
  if (courseProfile.overall.stablePreferences.length) {
    lines.push(`- 稳定偏好信号：${courseProfile.overall.stablePreferences.join('、')}`);
  }
  if (courseProfile.overall.responseHints.length) {
    lines.push(`- 回答提示：${courseProfile.overall.responseHints.join('；')}`);
  }
  if (courseProfile.overall.generationHints.length) {
    lines.push(`- 生成提示：${courseProfile.overall.generationHints.join('；')}`);
  }

  return `${lines.join('\n')}\n`;
}

function chapterProfileContext(chapterProfile: CourseProfileChapter | null): string {
  if (!chapterProfile) {
    return '';
  }

  const lines: string[] = [`\n当前章节画像：${chapterProfile.title}`];
  lines.push(`- 状态：${chapterProfile.status}`);
  if (chapterProfile.masteryPercent !== null) {
    lines.push(`- 掌握度：${chapterProfile.masteryPercent}%`);
  }
  if (chapterProfile.weaknessTags.length) {
    lines.push(`- 当前章节薄弱点：${chapterProfile.weaknessTags.join('、')}`);
  }
  if (chapterProfile.strengthTags.length) {
    lines.push(`- 当前章节优势：${chapterProfile.strengthTags.join('、')}`);
  }
  if (chapterProfile.misconceptions.length) {
    lines.push(`- 常见误区：${chapterProfile.misconceptions.join('；')}`);
  }
  if (chapterProfile.preferredScaffolding.length) {
    lines.push(`- 讲解脚手架：${chapterProfile.preferredScaffolding.join('；')}`);
  }
  if (chapterProfile.answeringHints.length) {
    lines.push(`- 回答提示：${chapterProfile.answeringHints.join('；')}`);
  }
  // 趋势注入：让 AI 知道学生在好转 / 恶化（不只是当前弱项）
  if (chapterProfile.weaknessTrend && chapterProfile.weaknessTrend.length) {
    const summary = chapterProfile.weaknessTrend
      .map((t) => {
        const pct = (n: number) => Math.round(n * 100) + '%';
        const dir = t.direction === 'improving' ? '改善中 ✓' : t.direction === 'worsening' ? '恶化中 ⚠' : '稳定';
        return `${t.tag}：${pct(t.prevRate)}→${pct(t.currRate)}（${dir}）`;
      })
      .join('；');
    lines.push(`- 弱项趋势：${summary}`);
  }
  if (chapterProfile.recentScores && chapterProfile.recentScores.length >= 2) {
    const scores = chapterProfile.recentScores.slice(-5).join(' / ');
    lines.push(`- 最近 ${chapterProfile.recentScores.length} 次得分：${scores}`);
  }

  return `${lines.join('\n')}\n`;
}

function weaknessTagContext(tags: FeedbackWeaknessTag[]): string {
  return tags.length ? tags.join('、') : '';
}

function strengthTagContext(tags: FeedbackStrengthTag[]): string {
  return tags.length ? tags.join('、') : '';
}

export interface PromptContext {
  profile?: StudentProfile | null;
  preferences?: LearningPreferences | null;
  diagnosis?: LatestDiagnosis | null;
  courseProfile?: CourseProfile | null;
  chapterProfile?: CourseProfileChapter | null;
  profileEvidenceSummary?: string;
  currentCourseTitle?: string;
  courseOutlineSummary?: string;
  materialSummary?: string;
  materialExerciseSummary?: string;
  retrievedExcerpts?: string;
  selectedMaterialTitle?: string;
  scope?: PromptContextScope;
  /** 当前课程的教学法 tag（多选）。决定讲义骨架 / 出题分布 / 批改风格。 */
  courseTags?: CourseTag[];
  /**
   * 创建课程时用户附带的额外说明 / 重点 / 限制（仅 generateCourse 用，
   * 注入到 outline 生成 prompt 末尾作为用户原话）。
   */
  creationInstruction?: string;
  /** 学习目标：完成课程后想能做到什么。 */
  learningGoal?: string;
  /** 已有基础：用户表明自己已会的部分，AI 跳过/精简对应内容。 */
  existingKnowledge?: string;
  /** 大纲规模偏好。ai-decide = 不约束。 */
  outlineSize?: 'ai-decide' | 'quick' | 'half-semester' | 'full-semester';
  /** 偏重风格（多选）：practice=实战 / theory=理论 / drill=题型熟练 / intuition=概念直觉。 */
  styleEmphasis?: Array<'practice' | 'theory' | 'drill' | 'intuition'>;
}

type PromptInjectField =
  | 'profile'
  | 'courseProfile'
  | 'chapterProfile'
  | 'preferences'
  | 'diagnosis'
  | 'diagnosisStrategyOnly'
  | 'profileEvidenceSummary'
  | 'currentCourseTitle'
  | 'courseOutlineSummary'
  | 'selectedMaterialTitle'
  | 'materialSummary'
  | 'materialExerciseSummary'
  | 'retrievedExcerpts'
  | 'courseTags';

function shouldInclude(field: PromptInjectField, scope: PromptContextScope): boolean {
  switch (scope) {
    case 'chat':
      return true;
    case 'lesson-gen':
      // 不注入 diagnosis 全文（只保留一行 overallStrategy 摘要）、不注入 materialExerciseSummary
      if (field === 'diagnosis') { return false; }
      if (field === 'materialExerciseSummary') { return false; }
      return true;
    case 'exercise-gen':
      // 不注入 diagnosis 全文
      if (field === 'diagnosis') { return false; }
      return true;
    case 'grade':
      // profile + chapterProfile + preferences + courseTags + 公式规则
      return field === 'profile'
        || field === 'chapterProfile'
        || field === 'preferences'
        || field === 'courseTags';
    case 'diagnosis':
      // profile + courseProfile + preferences + courseTags + 公式规则
      return field === 'profile'
        || field === 'courseProfile'
        || field === 'preferences'
        || field === 'profileEvidenceSummary'
        || field === 'courseTags';
    case 'outline-gen':
      // profile + preferences + materialSummary + courseTags + 公式规则
      return field === 'profile'
        || field === 'preferences'
        || field === 'currentCourseTitle'
        || field === 'selectedMaterialTitle'
        || field === 'materialSummary'
        || field === 'courseTags';
    case 'lecture-edit':
      // profile + chapterProfile + preferences + courseOutlineSummary + courseTags + 公式规则
      return field === 'profile'
        || field === 'chapterProfile'
        || field === 'preferences'
        || field === 'currentCourseTitle'
        || field === 'courseOutlineSummary'
        || field === 'courseTags';
    case 'project-spec':
      // 生成 TDD 项目骨架：profile + preferences 提示用户水平 / 节奏；
      // 不注入 diagnosis、materialSummary、chapterProfile（项目不锚定章节）
      return field === 'profile'
        || field === 'preferences'
        || field === 'currentCourseTitle';
    default:
      return true;
  }
}

function exercisePersonalizationContext(ctx: PromptContext, difficulty: number, count: number): string {
  const lines: string[] = [
    `练习生成要求：请按学生画像做个性化出题，不要只生成通用模板题。`,
    `目标题量：${count} 题，目标中心难度：${difficulty}/5。`,
    '如果资料中提供了课后习题、章末习题、复习题或例题，请优先参考它们的考点分布、题型结构和表述风格，但必须重新组织题面，不能照抄原题。',
    '题组内部尽量形成梯度：先基础理解，再方法应用，再综合变式；如果题量较少，也至少保持由浅入深。',
  ];

  if (ctx.profile) {
    lines.push(`请结合学生当前水平“${ctx.profile.level}”、学习目标“${ctx.profile.goals.join('、') || '暂无明确目标'}”和已完成练习量 ${ctx.profile.totalExercises} 题，调整题目的脚手架程度、应用场景和综合性。`);
  }

  if (ctx.chapterProfile?.weaknessTags.length) {
    lines.push(`当前章节优先覆盖这些薄弱点：${weaknessTagContext(ctx.chapterProfile.weaknessTags)}。`);
  }

  if (ctx.chapterProfile?.preferredScaffolding.length) {
    lines.push(`请遵循当前章节的脚手架偏好：${ctx.chapterProfile.preferredScaffolding.join('；')}。`);
  }

  if (ctx.preferences) {
    lines.push(`请遵循学生的学习偏好：整体难度 ${ctx.preferences.difficulty.global}，节奏 ${ctx.preferences.pace.speed}，单次练习数量偏好 ${ctx.preferences.pace.exercisesPerSession} 题。`);
    if (ctx.preferences.pace.speed === 'slow') {
      lines.push('由于学生偏好慢速推进，请让至少一半题目更强调分步思考、概念辨析或中间步骤。');
    }
    if (ctx.preferences.difficulty.global === 'challenge' || difficulty >= 4) {
      lines.push('请至少包含 1 道更强调迁移、综合或开放性思考的题目。');
    }
    if (ctx.preferences.difficulty.global === 'beginner' || ctx.preferences.difficulty.global === 'basic') {
      lines.push('请避免题面过度跳步，基础题要清楚覆盖定义、判定条件和基本方法。');
    }
  }

  const weaknesses = ctx.diagnosis?.subjectSnapshots.flatMap(snapshot => snapshot.topWeaknesses).filter(Boolean) ?? [];
  if (weaknesses.length) {
    lines.push(`请优先覆盖这些近期薄弱点：${Array.from(new Set(weaknesses)).slice(0, 5).join('、')}。`);
  }

  return `\n${lines.map(line => `- ${line}`).join('\n')}`;
}

/**
 * 把课程的教学法 tag 注入 prompt：每个 tag 的 lessonStructure / exerciseHint /
 * feedbackHint / retrievalHint 按当前 scope 选择性输出。
 *
 * 多 tag 时合并各自范式（顺序保留），但相同字段会去重。
 * 当 tag 为空时返回空串（让 AI 走通用范式）。
 */
function courseTagContext(tags: CourseTag[] | undefined, scope: PromptContextScope): string {
  if (!tags || tags.length === 0) return '';
  const playbooks = tags.map((tag) => COURSE_TAG_PLAYBOOK[tag]).filter(Boolean);
  if (playbooks.length === 0) return '';

  const labels = tags.map((tag) => COURSE_TAG_LABELS[tag] ?? tag).filter(Boolean);
  const lines: string[] = [];
  lines.push(`\n本课程的教学法分类：${labels.join(' + ')}`);
  lines.push('请严格遵循下面这门课特有的教学范式（覆盖通用范式）：');

  // 按 scope 选择哪些 hint 进 prompt
  const wantStructure = scope === 'lesson-gen' || scope === 'lecture-edit' || scope === 'outline-gen';
  const wantExercise = scope === 'exercise-gen';
  const wantFeedback = scope === 'grade';
  const wantRetrieval = scope === 'lesson-gen' || scope === 'exercise-gen' || scope === 'chat';
  const isChatLikeScope = scope === 'chat' || scope === 'diagnosis';

  if (wantStructure || isChatLikeScope) {
    const structures = Array.from(new Set(playbooks.map((p) => p.lessonStructure))).filter(Boolean);
    structures.forEach((s) => lines.push(`- ${s}`));
  }

  if (wantExercise || isChatLikeScope) {
    const exHints = Array.from(new Set(playbooks.map((p) => p.exerciseHint))).filter(Boolean);
    exHints.forEach((s) => lines.push(`- 出题指引：${s}`));

    // 默认题型分布：取所有 tag 的 defaultExerciseMix 平均（如果有多个）
    const mixes = playbooks.map((p) => p.defaultExerciseMix).filter(Boolean) as Array<NonNullable<typeof playbooks[number]['defaultExerciseMix']>>;
    if (mixes.length > 0) {
      const avg = {
        multipleChoice: Math.round(mixes.reduce((s, m) => s + m.multipleChoice, 0) / mixes.length),
        freeResponse: Math.round(mixes.reduce((s, m) => s + m.freeResponse, 0) / mixes.length),
        code: Math.round(mixes.reduce((s, m) => s + m.code, 0) / mixes.length),
      };
      lines.push(`- 题型分布建议：选择 ${avg.multipleChoice}% / 问答(含证明/翻译/论述) ${avg.freeResponse}% / 代码 ${avg.code}%`);
    }
  }

  if (wantFeedback || isChatLikeScope) {
    const fbHints = Array.from(new Set(playbooks.map((p) => p.feedbackHint))).filter(Boolean);
    fbHints.forEach((s) => lines.push(`- 批改指引：${s}`));
  }

  if (wantRetrieval) {
    const retHints = Array.from(new Set(playbooks.map((p) => p.retrievalHint))).filter(Boolean);
    retHints.forEach((s) => lines.push(`- 资料偏好：${s}`));
  }

  return `${lines.join('\n')}\n`;
}

function buildSystemBase(ctx: PromptContext): string {
  const scope: PromptContextScope = ctx.scope ?? 'chat';
  let sys = '你是一位经验丰富、耐心清晰的大学老师，正在辅导一位计算机专业大一学生。\n';

  if (shouldInclude('profile', scope)) {
    sys += profileContext(ctx.profile ?? null);
  }
  if (shouldInclude('courseProfile', scope)) {
    sys += courseProfileContext(ctx.courseProfile ?? null);
  }
  if (shouldInclude('chapterProfile', scope)) {
    sys += chapterProfileContext(ctx.chapterProfile ?? null);
  }

  // courseTags 在 preferences 之前注入：课程教学范式是"硬约束"，个人偏好是"软调整"。
  // 当两者冲突时（如 cs-skill 默认 80% 代码 vs 用户偏好 30% 代码），用户偏好在
  // preferencesContext 里仍会覆盖（出现在更后面），但 AI 会同时知道两者，能做有意识的取舍。
  if (shouldInclude('courseTags', scope)) {
    sys += courseTagContext(ctx.courseTags, scope);
  }

  if (shouldInclude('preferences', scope)) {
    sys += preferencesContext(ctx.preferences ?? null);
  }

  if (shouldInclude('diagnosis', scope)) {
    sys += diagnosisContext(ctx.diagnosis ?? null);
  } else if (scope === 'lesson-gen' && ctx.diagnosis?.overallStrategy) {
    // lesson-gen 仅保留一行 overallStrategy 摘要
    sys += `\n学习诊断整体策略：${ctx.diagnosis.overallStrategy}\n`;
  }

  if (shouldInclude('profileEvidenceSummary', scope) && ctx.profileEvidenceSummary) {
    sys += `\n近期课程反馈摘要：\n${ctx.profileEvidenceSummary}\n`;
  }

  if (shouldInclude('currentCourseTitle', scope) && ctx.currentCourseTitle) {
    sys += `\n当前选中的课程：${ctx.currentCourseTitle}\n`;
  }

  if (shouldInclude('courseOutlineSummary', scope) && ctx.courseOutlineSummary) {
    sys += `\n当前课程大纲：\n${ctx.courseOutlineSummary}\n`;
  }

  if (shouldInclude('selectedMaterialTitle', scope) && ctx.selectedMaterialTitle) {
    sys += `\n当前锁定资料：${ctx.selectedMaterialTitle}\n`;
  }

  if (shouldInclude('materialSummary', scope) && ctx.materialSummary) {
    sys += `\n资料摘要：\n${ctx.materialSummary}\n`;
  }

  if (shouldInclude('materialExerciseSummary', scope) && ctx.materialExerciseSummary) {
    sys += `\n资料中的参考习题与题型：\n${ctx.materialExerciseSummary}\n`;
  }

  if (shouldInclude('retrievedExcerpts', scope) && ctx.retrievedExcerpts) {
    sys += `\n与当前问题最相关的资料片段：\n${ctx.retrievedExcerpts}\n`;
    sys += '以上资料摘要和资料片段就是你当前已经“看过”的资料库内容。除非用户要求逐字引用原文、读取尚未导入的文件，或者查看外部系统里的新资料，否则不要说你看不到资料库。';
    sys += '\n如果你的回答明显依赖某份资料，请尽量在答案末尾列出“参考资料：文件名”。';
  }

  sys += `\n\n数学公式格式规则（必须严格遵守）：
- 行内公式使用单个美元符号，例如 $x^2+1$，不要在美元符号内侧加空格。
- 独立公式使用双美元符号，并单独占一行，前后各空一行。
- 不要用 $ 包裹中文说明文字，中文直接写在正文里。`;

  sys += '\nHard math formatting rules: single-dollar inline math must open and close on the same physical line. Never output delimiter-adjacent prose such as "记作$" or "$存在"; write prose and math with spaces, e.g. "记作 $S_n=...$" and "$\\lim_{n\\to\\infty}S_n=S$ 存在". Never let list markers, punctuation, or Chinese prose share a dangling single "$". Use $$...$$ only for standalone display equations.';

  return sys;
}

export function courseOutlinePrompt(subject: Subject, ctx: PromptContext): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const scopedCtx: PromptContext = { ...ctx, scope: 'outline-gen' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请为“${subjectName}”生成一个结构化课程大纲。输出纯 JSON，格式如下：
{
  "title": "课程标题",
  "topics": [
    {
      "id": "topic-01",
      "title": "主题名称",
      "lessons": [
        { "id": "lesson-01", "title": "课名", "difficulty": 1 }
      ]
    }
  ]
}
要求：
- 包含 5 到 8 个主题
- 每个主题 3 到 5 节课
- difficulty 从 1 到 5 逐步递进
- 只输出 JSON，不要额外解释`,
    },
    { role: 'user', content: `请为“${subjectName}”生成课程大纲。` },
  ];
}

export function rebuildCourseOutlinePrompt(subject: Subject, currentOutline: CourseOutline, ctx: PromptContext): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const scopedCtx: PromptContext = { ...ctx, scope: 'outline-gen' };
  const currentOutlineJson = JSON.stringify({
    title: currentOutline.title,
    topics: currentOutline.topics.map(topic => ({
      id: topic.id,
      title: topic.title,
      lessons: topic.lessons.map(lesson => ({
        id: lesson.id,
        title: lesson.title,
        difficulty: lesson.difficulty,
      })),
    })),
  }, null, 2);

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请基于当前课程大纲、资料摘要和命中的资料片段，对“${subjectName}”执行一次完整重构。
输出纯 JSON，格式如下：
{
  "title": "课程标题",
  "topics": [
    {
      "id": "topic-01",
      "title": "主题名称",
      "lessons": [
        { "id": "lesson-01", "title": "课名", "difficulty": 1 }
      ]
    }
  ]
}
要求：
- 只输出 JSON，不要额外解释
- 这是一次完全重构，旧大纲、旧讲义、旧练习会被清空后再写入新结构，不需要保留原有 topic id 和 lesson id
- 你可以大胆删除、重排、合并、拆分原有主题和课时，只要新的结构更合理
- 保持结构清晰，主题顺序合理
- difficulty 使用 1 到 5
- 如果资料显示当前大纲缺失关键内容，可以补充；如果内容重复或顺序不合理，可以直接重写`,
    },
    {
      role: 'user',
      content: `当前课程标题：${currentOutline.title}\n\n当前课程大纲 JSON：\n${currentOutlineJson}\n\n请在参考现有课程结构的基础上，输出一份“完全重构后”的新课程大纲 JSON。`,
    },
  ];
}

/** 大纲规模 → 主题数 + 课时数 hint。 */
function outlineSizeRule(size?: PromptContext['outlineSize']): string {
  switch (size) {
    case 'quick':         return '- 短期速览：3 到 5 个主题，每个主题 2 到 3 节课（共约 10 节，聚焦核心）';
    case 'half-semester': return '- 半学期：5 到 8 个主题，每个主题 3 到 4 节课（共约 20 节，主流路径）';
    case 'full-semester': return '- 长学期：8 到 12 个主题，每个主题 4 到 6 节课（共约 40-70 节，详尽覆盖周边）';
    case 'ai-decide':
    default:              return '- 你自己根据学科广度和复杂度判断合适的主题数和课时数，不要硬凑';
  }
}

/** 偏重风格 → 写到 prompt 里的指令片段。 */
function styleEmphasisRule(emphases?: PromptContext['styleEmphasis']): string {
  if (!emphases || emphases.length === 0) return '';
  const map: Record<string, string> = {
    practice: '**实战项目导向**：课时安排倾向"做完才学会"，每个主题至少有一节面向具体场景的应用',
    theory: '**理论严谨**：定义→定理→证明大纲的链条要清晰，不省略关键推导',
    drill: '**题型熟练度**：每个核心概念配套常见题型组，强调反复刷题中固化模式',
    intuition: '**概念直觉**：先用类比 / 图示 / 极端情况建立直觉，再上形式定义',
  };
  return emphases.map((e) => `- 偏重风格：${map[e] || e}`).join('\n');
}

/** 当 tags 含 cs-skill / cs-theory / engineering 时，让 AI 额外输出 projects 字段。 */
function shouldRequestProjects(tags?: CourseTag[]): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some((t) => t === 'cs-skill' || t === 'cs-theory' || t === 'engineering');
}

export function strictCourseOutlinePrompt(subject: Subject, ctx: PromptContext): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const scopedCtx: PromptContext = { ...ctx, scope: 'outline-gen' };
  const includeProjects = shouldRequestProjects(ctx.courseTags);

  const projectsSchemaFragment = includeProjects ? `,
  "projects": [
    {
      "id": "proposal-01",
      "title": "项目名称",
      "description": "1-2 句话：要做什么 + 学完能产出什么",
      "learningGoals": ["完成后能 X", "完成后能 Y"],
      "difficulty": 3,
      "suggestedTechStack": ["TypeScript", "Vitest"]
    }
  ]` : '';
  const projectsRequirements = includeProjects
    ? `- **必须**输出 1 到 3 个 projects 提案。每个提案是一个可以让学生**亲手做**的项目（写代码 / 搭系统 / 实现算法 / 复现论文），不是"读完然后写感想"那种。
- projects 难度梯度：第 1 个 easy（贯穿前期课时），最后一个 medium-hard（综合多个主题）。
- projects 不要拘泥于课程已有 topic，可以引入跨主题综合。
- suggestedTechStack 选项要符合现代主流（2026 年）。`
    : '';

  const userExtras: string[] = [];
  if (ctx.learningGoal) userExtras.push(`学习目标（用户希望完成课程后能做到什么）：${ctx.learningGoal}`);
  if (ctx.existingKnowledge) userExtras.push(`已有基础（**请精简 / 跳过**这些内容）：${ctx.existingKnowledge}`);
  if (ctx.creationInstruction) userExtras.push(`额外要求：${ctx.creationInstruction}`);

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请为“${subjectName}”生成一个结构化课程大纲。输出纯 JSON，格式如下：
{
  "title": "课程标题",
  "topics": [
    {
      "id": "topic-01",
      "title": "主题名称",
      "lessons": [
        { "id": "lesson-01", "title": "课时名称", "difficulty": 1 }
      ]
    }
  ]${projectsSchemaFragment}
}
要求：
${outlineSizeRule(ctx.outlineSize)}
${styleEmphasisRule(ctx.styleEmphasis)}
- 课程标题、主题标题、课时标题以中文为主，但编程语言名、技术框架名（如 React、Python、SQL、HTTP）允许保留英文
- 大纲标题只能写一个短句
- 不要出现公式，不要出现 LaTeX
- 尽量避免阿拉伯数字编号，主题与课时之间用空格或"与"连接
- 标点精简，避免长句
- 标题只表达一个核心概念，保持干练
- 大纲只负责列课程结构，不要在标题里展开解释
- difficulty 使用 1 到 5 逐步递进
${projectsRequirements}
- 只输出 JSON，不要额外解释，不要 markdown 围栏`,
    },
    {
      role: 'user',
      content: userExtras.length
        ? `请为“${subjectName}”生成课程大纲。\n\n${userExtras.join('\n\n')}`
        : `请为“${subjectName}”生成课程大纲`,
    },
  ];
}

/**
 * 基于已生成的 outline 预览 + 用户的自然语言修改建议，重新生成 outline。
 * 用在 preview→refine→confirm 流程：用户对当前 outline 不满意，
 * 给一句话指令（"把第 3 章拆成两章"、"加一节关于 X 的内容"），
 * AI 输出修订后的完整 outline JSON。
 */
export function refineCoursePreviewPrompt(args: {
  subject: Subject;
  currentPreview: CourseOutline;
  refineInstruction: string;
  ctx: PromptContext;
}): ChatMessage[] {
  const { subject, currentPreview, refineInstruction, ctx } = args;
  const subjectName = subjectLabel(subject);
  const scopedCtx: PromptContext = { ...ctx, scope: 'outline-gen' };
  const includeProjects = shouldRequestProjects(ctx.courseTags ?? currentPreview.tags);

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n你正在帮学生迭代修改一份**预览课程大纲**。学生给出修改指令，请输出修订后的完整 outline JSON。

【硬约束】
- 只输出 JSON，没有围栏，没有解释。
- JSON 结构与初次生成一致：title / topics（含 lessons）${includeProjects ? ' / projects' : ''}。
- **保留学生没要求修改的部分原样**（topic / lesson 标题不要无故重写）。
- 修改指令是局部 / 全局视情况而定，请仔细识别。
- difficulty 范围 1-5；id 字段可以保留原 id 或重新分配 topic-NN / lesson-NN。
${includeProjects ? '- projects 数组：若学生没说要改 projects，原样保留；说要加 / 删 / 改，再调。' : ''}`,
    },
    {
      role: 'user',
      content: `当前预览大纲（${subjectName}）：
\`\`\`json
${JSON.stringify(currentPreview, null, 2)}
\`\`\`

请按以下修改指令重新生成完整 outline JSON：
${refineInstruction}`,
    },
  ];
}

export function strictRebuildCourseOutlinePrompt(subject: Subject, currentOutline: CourseOutline, ctx: PromptContext): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const scopedCtx: PromptContext = { ...ctx, scope: 'outline-gen' };
  const currentOutlineJson = JSON.stringify({
    title: currentOutline.title,
    topics: currentOutline.topics.map(topic => ({
      id: topic.id,
      title: topic.title,
      lessons: topic.lessons.map(lesson => ({
        id: lesson.id,
        title: lesson.title,
        difficulty: lesson.difficulty,
      })),
    })),
  }, null, 2);

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请基于当前课程大纲 资料摘要和命中的资料片段 对“${subjectName}”执行一次完整重构。输出纯 JSON，格式如下：
{
  "title": "课程标题",
  "topics": [
    {
      "id": "topic-01",
      "title": "主题名称",
      "lessons": [
        { "id": "lesson-01", "title": "课时名称", "difficulty": 1 }
      ]
    }
  ]
}
要求：
- 只输出 JSON 不要额外解释
- 这是一次完全重构 旧大纲 旧讲义 旧练习会被清空后再写入新结构 不需要保留原 topic id 和 lesson id
- 你可以大胆删除 重排 合并 拆分原有主题和课时 只要新的结构更合理
- 保持结构清晰 主题顺序合理
- 如果资料显示当前大纲缺少关键内容 可以补充
- 如果内容重复或顺序不合理 可以直接重构
- 课程标题、主题标题、课时标题以中文为主，但编程语言名、技术框架名（如 React、Python、SQL、HTTP）允许保留英文
- 大纲标题只能写一个短句
- 不要出现公式
- 不要出现 LaTeX
- 尽量避免阿拉伯数字编号，主题与课时之间用空格或“与”连接
- 标点尽量精简，避免长句
- 如果当前大纲里有公式或夹杂多余符号 需要在新大纲中改写成简洁标题
- difficulty 使用 1 到 5`,
    },
    {
      role: 'user',
      content: `当前课程标题：${currentOutline.title}\n\n当前课程大纲 JSON：\n${currentOutlineJson}\n\n请输出一份完全重构后的新课程大纲 JSON`,
    },
  ];
}

export function strictFullRebuildCourseOutlinePrompt(
  subject: Subject,
  currentOutline: CourseOutline,
  ctx: PromptContext,
  instruction?: string,
): ChatMessage[] {
  const messages = strictRebuildCourseOutlinePrompt(subject, currentOutline, ctx);
  const normalizedInstruction = String(instruction ?? '').trim();
  if (!normalizedInstruction) {
    return messages;
  }

  return [
    messages[0],
    {
      role: 'user',
      content: `${messages[1].content}\n\n本次额外要求：${normalizedInstruction}`,
    },
  ];
}

export function strictPartialRebuildCourseOutlinePrompt(
  subject: Subject,
  currentOutline: CourseOutline,
  selection: { startIndex: number; endIndex: number },
  ctx: PromptContext,
  instruction?: string,
): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const selectedTopics = currentOutline.topics
    .slice(selection.startIndex, selection.endIndex + 1)
    .map((topic) => ({
      title: topic.title,
      lessons: topic.lessons.map((lesson) => ({
        title: lesson.title,
        difficulty: lesson.difficulty,
      })),
    }));
  const selectedOutlineJson = JSON.stringify(selectedTopics, null, 2);
  const normalizedInstruction = String(instruction ?? '').trim();
  const scopedCtx: PromptContext = { ...ctx, scope: 'outline-gen' };

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请基于当前课程大纲、资料摘要和命中的资料片段，对“${subjectName}”执行一次部分重构。输出纯 JSON，格式如下：
{
  "topics": [
    {
      "id": "topic-01",
      "title": "主题名称",
      "lessons": [
        { "id": "lesson-01", "title": "课时名称", "difficulty": 1 }
      ]
    }
  ]
}
要求：
- 只输出 JSON，不要额外解释
- 你只负责重写被选中的连续主题区间，不要返回整门课大纲
- 不允许修改课程标题
- 允许合并、拆分、增删被选区内的主题和课时
- 未被选中的前后主题会由本地系统保留并重新拼接
- 主题标题和课时标题保持简洁、以中文为主（编程语言名、技术框架名等术语允许保留英文）、无公式、无 LaTeX
- 标点尽量精简，避免长句
- difficulty 使用 1 到 5`,
    },
    {
      role: 'user',
      content: `当前课程标题：${currentOutline.title}

本次只重构第 ${selection.startIndex + 1} 到第 ${selection.endIndex + 1} 个主题。

被替换选区 JSON：
${selectedOutlineJson}

${normalizedInstruction ? `本次额外要求：${normalizedInstruction}\n\n` : ''}请只输出替换选区的新 topics JSON。`,
    },
  ];
}

export function lessonPrompt(subject: Subject, topicTitle: string, lessonTitle: string, difficulty: number, ctx: PromptContext): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'lesson-gen' };

  // 字数硬约束：lessonDetail 三档真生效
  const detail = ctx.preferences?.aiStyle?.lessonDetail || 'standard';
  const wordTarget =
    detail === 'concise' ? '1000-1500 字（精简，聚焦核心）'
    : detail === 'detailed' ? '4000-6000 字（详尽，含证明、推导、多个例子）'
    : '2000-3000 字（标准，含定义、关键例子、本节小结）';

  // 视觉化建议：按学科 hint 引导 mermaid / DOT / SVG + 通用样式约束 + widget 交互演示
  const visualHint = buildVisualHint(subject) + '\n\n' + VISUAL_STYLE_RULES + '\n' + INTERACTIVE_WIDGET_RULES;

  // Misconception 前置防御：找出与本节相关的常见误区，让 AI 在讲义里主动澄清
  // 同步引入避免循环；require 是 ts-node / commonjs 友好
  const misconceptionsForLesson = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../progress/misconceptionTemplates');
      const lib = mod.loadMisconceptionsForSubject(subject);
      const hits = mod.relevantMisconceptionsForTopic(`${topicTitle} ${lessonTitle}`, lib);
      // 也加入 chapterProfile.misconceptions 已经踩过的（防同样错误重犯）
      const chapter = ctx.chapterProfile;
      const stuckOnIds = new Set<string>();
      (chapter?.misconceptions ?? []).forEach((m) => {
        const idMatch = m.match(/\[误区:([^\]]+)\]/);
        if (idMatch) stuckOnIds.add(idMatch[1]);
      });
      const stuckHits = lib.filter((m: any) => stuckOnIds.has(m.id));
      const merged = [...new Map([...hits, ...stuckHits].map((m: any) => [m.id, m])).values()].slice(0, 4);
      if (!merged.length) return '';
      return mod.formatMisconceptionsForPrompt(merged);
    } catch {
      return '';
    }
  })();

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请用 Markdown 写一篇讲义。

【硬性结构】
1. 顶部：\`<details open><summary>📌 1 分钟回顾</summary>...</details>\` 块
   · 4-7 条 bullet，每条不超 30 字
   · 含核心概念中英术语并置（如 "向量空间 vector space"）
   · 这是用户复习时的"扫一眼版"，必须独立可读
2. 正文："为什么学这个"开场（具体动机 / 应用场景 / 类比）→ 渐进讲解 → 例题 → 反例 / 易错
3. 在 2-3 个关键节点插入 \`> 想一想：...\` 引用块（1-2 行问题，让读者暂停）
4. 结尾："本节小结"用 5 句话；可选加 \`<details><summary>🔬 深入阅读（可选）</summary>...</details>\` 放高阶补充
5. 不要末尾加"练习预告"段（练习由独立流程触发）

【字数】目标 ${wordTarget}。

【视觉化】${visualHint}
${misconceptionsForLesson ? `\n【常见误区前置防御】下面是这一节学生常踩的误区，请在讲义中**主动**澄清（用 "误区警示 / 易错点" 这样的小节标记，避免学生踩坑）：\n${misconceptionsForLesson}\n` : ''}

【可视化建议占位（重要 — 让讲义"知道哪里该有图"）】
你**不需要**自己画所有图。在以下两种场景，插入一个"建议占位块"让用户后续一键触发：
1. **学术插图建议**：某概念有公认的标准示意图（如 Transformer 架构、TCP 三次握手、CPU 流水线、内存层次、Cache 组相联结构、感受野、Backprop 计算图等），但你画不出业界顶级质量
2. **交互演示建议**：某算法/概念用"步进+高亮"演示比静态图好（如 Dijkstra、BFS/DFS、滑动窗口、LRU 替换、归并排序）

**格式（直接写 raw HTML，**不要包代码围栏**，必须独立成块，前后空行）**：

<div class="cc-suggest" data-kind="image" data-query="搜索描述">
💡 建议：在这里加一张"<具体描述>"的示意图
</div>

或：

<div class="cc-suggest" data-kind="widget" data-query="互动演示描述">
💡 建议：在这里加一个"<具体描述>"的互动演示
</div>

**\`data-kind\`** 只有 \`image\` 或 \`widget\` 两种。**\`data-query\`** 是 1-2 句具体描述（不是 quotation，是给 Claude 搜图或生成 widget 的 query）。

**⚠️ 绝不要把这个 \`<div class="cc-suggest">\` 包在 \`\`\`text 或任何代码围栏里**——它必须作为 raw HTML 直接出现在 markdown 中，前后空行让 markdown-it 当 html_block 解析。包了围栏就会变成代码块字面量，前端识别不了，用户看到的是一个奇怪的代码块。

**何时用 image vs widget**：
- **image**：静态结构图、概念示意图、架构总览（如 Transformer 整体架构、CPU 流水线、内存层次结构）。这类用真实教学资源（教材插图、Jay Alammar 等）比 AI 重画好得多。
- **widget**：算法过程演示、参数可视化、状态变化（如 Self-Attention 的 Q·K^T 矩阵计算、Dijkstra 单步演示、softmax 温度调节、可调 head 数的 attention pattern）。**只要有"下一步 / 重置 / 拖滑块" 价值的就用 widget**。
- **优先 widget**：算法 / 数据结构 / DP / 注意力计算 / 流水线 / 调度等"过程性"内容 → 几乎必用 widget。

**插入数量限制**：每节讲义最多 2-3 个 cc-suggest 块，不要每段都塞。优先放在"概念抽象 / 算法过程 / 架构图" 这种**只靠文字读不懂**的地方。算法主题至少 1 个 widget 占位。

**正面例子**（在 Transformer 那节，注意是 raw HTML 直接写在讲义里，没有围栏）：

<div class="cc-suggest" data-kind="image" data-query="Transformer 完整架构图 含 encoder decoder multi-head attention layer norm">
💡 建议：在这里加一张 Transformer 完整架构图（论文 Figure 1 风格，标注 encoder / decoder / attention / FFN）
</div>

<div class="cc-suggest" data-kind="widget" data-query="Self-Attention 计算过程演示 Q K^T softmax 矩阵相乘可视化 4 个 token 步进 高亮">
💡 建议：在这里加一个 Self-Attention 计算过程的可视化（4 个 token，按步骤展示 Q·K^T → softmax → 乘 V）
</div>

**反例**（千万不要这么写）：

\`\`\`text  ← ❌ 错：包了围栏，会变代码块
<div class="cc-suggest" ...>...</div>
\`\`\`

【公式与推导】
- 多步推导每一步独立展示，不要把太多推导挤进一个公式块
- 块级公式用 \`$$...$$\`、内联用 \`$...$\`
- 难度等级：${difficulty}/5

【inline 引用】
- 关键论断（定义 / 定理 / 重要事实）后用 \`[来源 #N]\` 标注（N = 资料片段编号）
- 每段最多 1-2 处，不要每句都引
- 不要在末尾加大段"参考资料"——inline 引用就够

【写作口吻】
- 这是独立的教材页面，不是聊天对话
- ❌ 不要写"我下一条可以..."、"如果你愿意，我可以..."、"接下来我会..."、"作为 AI"、"我建议你"
- ✅ 用第二人称"你"或不指定主语，像优秀网课讲师那样直接讲
- ✅ 末尾"本节小结" 5 句话即收，不寒暄、不导航`,
    },
    { role: 'user', content: `请为"${subjectLabel(subject)}"课程中"${topicTitle}"主题下的"${lessonTitle}"编写讲义。` },
  ];
}

/**
 * 通用样式约束：保证 mermaid / DOT 在 webview 的深浅主题下文字都清晰可见。
 */
const VISUAL_STYLE_RULES = [
  '⚠ **Mermaid 节点标签里凡是含 `[` `]` `(` `)` `{` `}` `<` `>` `|` `"` 等特殊字符 → 必须用引号包起来**：',
  '  例：`A[dist[s]=0]` ❌ 会报语法错；正确写法 `A["dist[s]=0"]` ✅',
  '  例：`E{w(u,v)<x?}` ❌；正确 `E{"w(u,v)<x?"}` ✅',
  '  例：`B[更新 dist[v]]` ❌；正确 `B["更新 dist[v]"]` ✅',
  '⚠ **Mermaid 内部不要写 `style A fill:#xxx,color:#yyy` 或 `classDef` 设颜色** —— webview 已经统一注入 themeVariables 适配主题。手动设色容易让文字变浅灰色不可读。',
  '⚠ **DOT 内部不要写 `color="#xxx"` / `fontcolor="#xxx"` / `bgcolor="#xxx"`** 给节点/边整体上色 —— webview CSS 会把黑色描边/文字统一替换成主题前景色。只在你"要突出某条边/节点"时用 `color=red` / `color=blue` 这种命名色（语义清晰，CSS 不会覆盖）。',
  '⚠ 别在代码块外再加 markdown 标题或 `**强调**` 包住整段，会破坏 fence 识别。',
].join('\n');

/**
 * 互动式 widget 使用指南：什么场景用 ```widget 而不是 dot/mermaid。
 */
const INTERACTIVE_WIDGET_RULES = [
  '',
  '【交互式演示】 webview 支持 ```widget 代码块，里面写完整 HTML+CSS+JS，渲染成沙箱 iframe 的可交互演示（按钮、动画、状态切换）。',
  '',
  '**什么时候用 widget**：',
  '- 算法步进演示：Dijkstra / BFS / DFS / Floyd / 排序 → 有"下一步 / 重置 / 自动播放"按钮，每步高亮当前节点 + 更新数据表',
  '- 数据结构操作：BST 插入/删除/旋转、堆调整、Trie 查找、链表反转 → 用户点按钮看每一步',
  '- 网络协议交互：TCP 三次握手 / TLS handshake → 时序图带"下一步"',
  '- 函数图像：用 Canvas / SVG 画 y=sin(x)、ReLU、softmax，加滑块调参',
  '- 任何需要"鼠标点 / 滑块拖 / 输入框改" 才能体现概念的场景',
  '',
  '**不要用 widget 的情况**：',
  '- 静态结构图 → ```dot 或 ```mermaid 即可，不必上 iframe',
  '- 单张图表 → SVG / Vega-Lite 更轻',
  '- 数学公式 → KaTeX 已支持',
  '',
  '**widget 块写法严格约束**（违反任一条都会渲染失败 / 白屏）：',
  '1. 纯 vanilla HTML+CSS+JS，**不要 import / require / 加 <script src>** 任何外部库 —— iframe CSP 已禁网络，所有外链都 die',
  '2. 不要 `fetch` / `XMLHttpRequest` / `WebSocket` —— 同上',
  '3. SVG 必须显式 `<svg width="600" height="300" viewBox="0 0 600 300">` 三个属性都给齐，否则部分浏览器渲染 0×0 不可见',
  '4. **模板字符串插值必须紧贴**：写 `${var}` 不是 `$ {var}`。中间空格会让插值失效（变成字面量字符串），所有 querySelector / data-key 都对不上号 → 看起来"渲染成功但内容空"',
  '5. JS 里如果有字符串包含 `</script>`，**一定写成 `<\\/script>`**，否则会提前关 script 标签把后面内容当成 HTML',
  '6. CSS 里如果字符串包含 `</style>`，写成 `<\\/style>`',
  '7. **颜色 CSS 变量 + 必须保证对比度**：可用 var(--bg) var(--fg) var(--accent) var(--accent-fg) var(--border) var(--input-bg) var(--input-fg) var(--muted) var(--panel-bg)。**但绝对不能 SVG 节点 fill 用容器背景同色变量**：',
  '   - ❌ `.graph-shell { background: var(--input-bg) }` + `.node circle { fill: var(--input-bg) }` → 节点融进背景看起来"图是空的"（用户最常踩这个坑）',
  '   - ✅ SVG 节点 fill 用 `var(--accent)` 或 `var(--fg)`（前景色），stroke 用 `var(--border)` / `var(--accent-fg)`',
  '   - ✅ SVG 边 stroke 用 `var(--fg)` 或 `var(--accent)`；不要用 `var(--border)` 因为 border 颜色对暗背景对比度太低',
  '8. 不要写死 width: 1000px 这种 → 用户侧栏可能很窄，组件要响应式',
  '9. **绝对不要内联 `// 注释`**：AI 常把多个语句压一行，`// xxx` 会把同一行后面的所有代码吃掉变 syntax error。要写注释**用 `/* xxx */` 块注释**，或者注释独占一行。',
  '10. **每个语句独占一行**，不要 `a; b; c;` 压一行。代码再啰嗦也比单行难调试强。',
  '11. **不要把整段 JS 包在 try/catch 里** —— 这会吞掉真实的逻辑 bug 让 widget 看起来"渲染成功但内容是空的"。让错误抛出，iframe bridge 的 error 监听器会显示醒目红色覆盖层，反而方便排查',
  '12. **写完代码自己脑中跑一遍**：',
  '   - 数据数组（nodes, edges, items）有没有真的填好元素？',
  '   - reset()/init() 有没有真的填充 steps / state？步骤数大于 0？',
  '   - render() 第一次调用时数据是不是已经 ready？',
  '   - SVG 节点循环是不是真的会产生 children？',
  '13. **保持简单**：能用 200 行做出来就别写 500 行。多功能 ≠ 好 widget；可工作 + 教学清晰才是好 widget',
  '',
  '**完整可运行模板示例**（Dijkstra 单步演示，**已测试可直接渲染**）：',
  '',
  '```widget',
  '<style>',
  '.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }',
  '.row button + button { margin-left: 4px; }',
  '.panel { padding: 12px; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 8px; margin-top: 12px; }',
  '.node circle { fill: var(--panel-bg); stroke: var(--border); stroke-width: 2; transition: all 200ms ease; }',
  '.node.visited circle { fill: var(--accent); stroke: var(--accent); }',
  '.node.frontier circle { fill: color-mix(in srgb, var(--accent) 30%, transparent); stroke: var(--accent); stroke-dasharray: 4 2; }',
  '.node text { font-size: 14px; font-weight: 600; fill: var(--fg); text-anchor: middle; dominant-baseline: middle; }',
  '.node.visited text { fill: var(--accent-fg); }',
  '.edge { stroke: var(--muted); stroke-width: 1.5; fill: none; }',
  '.edge.active { stroke: var(--accent); stroke-width: 3; }',
  '.edge-label { font-size: 11px; fill: var(--fg); }',
  '</style>',
  '<svg id="graph" width="600" height="240" viewBox="0 0 600 240"></svg>',
  '<div class="panel">',
  '  <table id="state"><thead><tr><th>节点</th><th>距离</th><th>前驱</th><th>状态</th></tr></thead><tbody></tbody></table>',
  '</div>',
  '<div class="row">',
  '  <button id="btn-next">下一步</button>',
  '  <button id="btn-reset" class="ghost">重置</button>',
  '  <span style="opacity:0.6;font-size:11.5px">步骤 <span id="step">0</span></span>',
  '</div>',
  '<script>',
  '// 数据：5 个节点 + 6 条边。**写完检查这两个数组真的有元素**',
  'const nodes = [',
  '  {id:"S", x:60,  y:120}, {id:"A", x:200, y:60},  {id:"B", x:200, y:180},',
  '  {id:"C", x:380, y:120}, {id:"T", x:540, y:120}',
  '];',
  'const edges = [',
  '  {a:"S",b:"A",w:2}, {a:"S",b:"B",w:5}, {a:"A",b:"C",w:3},',
  '  {a:"B",b:"C",w:1}, {a:"C",b:"T",w:4}, {a:"A",b:"T",w:10}',
  '];',
  '',
  'let state, step;',
  'function reset(){ state={dist:{},prev:{},done:{}}; nodes.forEach(n=>{state.dist[n.id]=Infinity; state.prev[n.id]=null;}); state.dist["S"]=0; step=0; render(); }',
  'function next(){',
  '  let u=null, best=Infinity;',
  '  for (const n of nodes) if (!state.done[n.id] && state.dist[n.id]<best) { best=state.dist[n.id]; u=n.id; }',
  '  if (u==null) return;',
  '  state.done[u]=true;',
  '  for (const e of edges) {',
  '    let v=null; if (e.a===u) v=e.b; else if (e.b===u) v=e.a;',
  '    if (v && !state.done[v]) { const alt = state.dist[u]+e.w; if (alt<state.dist[v]) { state.dist[v]=alt; state.prev[v]=u; } }',
  '  }',
  '  step++; render();',
  '}',
  'function render(){',
  '  const svg = document.getElementById("graph");',
  '  let h = "";',
  '  for (const e of edges) {',
  '    const a=nodes.find(n=>n.id===e.a), b=nodes.find(n=>n.id===e.b);',
  '    h += `<path class="edge" d="M${a.x} ${a.y} L${b.x} ${b.y}"/>`;',
  '    h += `<text class="edge-label" x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-6}">${e.w}<\\/text>`;',
  '  }',
  '  for (const n of nodes) {',
  '    const cls = state.done[n.id] ? "visited" : (state.dist[n.id]<Infinity ? "frontier" : "");',
  '    h += `<g class="node ${cls}"><circle cx="${n.x}" cy="${n.y}" r="22"/><text x="${n.x}" y="${n.y}">${n.id}<\\/text><\\/g>`;',
  '  }',
  '  svg.innerHTML = h;',
  '  const tbody = document.querySelector("#state tbody");',
  '  tbody.innerHTML = nodes.map(n=>`<tr><td>${n.id}<\\/td><td>${state.dist[n.id]===Infinity?"∞":state.dist[n.id]}<\\/td><td>${state.prev[n.id]||"-"}<\\/td><td>${state.done[n.id]?"✓ 已确定":""}<\\/td><\\/tr>`).join("");',
  '  document.getElementById("step").textContent = step;',
  '}',
  '',
  'document.getElementById("btn-next").onclick = next;',
  'document.getElementById("btn-reset").onclick = reset;',
  'reset();',
  '</script>',
  '```',
  '',
  '注意上例：',
  '- SVG 写了完整 width/height/viewBox 三件套',
  '- JS 里 `</text>` `</g>` `</tr>` 等闭合都写成 `<\\/...>` 防止字符串被提前截断',
  '- **不**包 try/catch —— 让任何错误显眼地抛出',
  '- 数据数组 nodes / edges 直接定义 + 立刻 reset() 触发首次渲染',
  '- 全程 ~50 行 JS，每个函数都简单可验证。**别贪多搞 200 行 playback + 调速 + 5 种状态**，复杂等于 bug 等于白屏',
].join('\n');

/**
 * 可视化路由原则（webview 已集成的渲染器）：
 *   - ```mermaid    流程 / 时序 / 状态机 / mindmap / quadrant / sankey / ER
 *   - ```dot        二叉树 / 平衡树 / B 树 / Trie / 链表 / 哈希链 / 图算法 /
 *                   网络拓扑 / AST / 控制流 / 多 cluster 架构图
 *                   ⭐ 任何"精确结构图"优先 DOT —— LLM 写得好且 GraphViz 排版最准
 *   - 公式：KaTeX：行内 $...$、块 $$...$$
 *   - 自定义示意（受力 / 电路 / 几何 / 网络拓扑示意）→ 原生 <svg viewBox="..."> 块，
 *     stroke="currentColor" 自动跟主题
 *
 * 按学科建议：
 */
function buildVisualHint(subject: Subject): string {
  const s = (subject || '').toLowerCase();
  if (/algebra|代数|矩阵|linear|calculus|微积分|topology|geometry/.test(s)) {
    return [
      '当涉及结构关系（如子空间包含、向量分解）→ 用 mermaid graph 或 ```dot 画概念图',
      '当涉及几何对象 → 直接写 <svg viewBox="..."> 块（stroke="currentColor" 适配主题）',
      '矩阵直接用 \\(\\begin{bmatrix}...\\end{bmatrix}\\) LaTeX',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/data\s*struct|algo|算法|数据结构/.test(s)) {
    return [
      '⭐ 二叉树 / AVL / 红黑树 / B 树 / Trie / 链表 / 哈希链 → ```dot 代码块（GraphViz 排树最准），用 node [shape=circle/box]，根据需要 rankdir=TB',
      '⭐ 图算法（DFS/BFS/Dijkstra/最短路）→ ```dot 代码块，可加 color=red 标记当前边/节点',
      '算法控制流 → ```mermaid flowchart',
      '调用栈 / 递归展开 → ```mermaid flowchart 或 markdown 编号列表',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/network|计算机网络|tcp|http|协议/.test(s)) {
    return [
      '⭐ 网络拓扑（路由器/交换机/主机连接）→ ```dot 代码块，subgraph cluster 划分 LAN',
      '⭐ 协议交互（TCP 三次握手 / TLS / HTTP）→ ```mermaid sequenceDiagram',
      '协议栈层级 → markdown 表格 或 ```dot rankdir=TB',
      'TCP 状态机 / NAT 类型 → ```mermaid stateDiagram 或 ```dot',
      '路由算法（Dijkstra/距离矢量）→ ```dot，边上写 label=cost',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/operating|os|computer|系统/.test(s)) {
    return [
      '系统调用 / 中断流程 → ```mermaid flowchart 或 sequenceDiagram',
      '进程状态机 → ```mermaid stateDiagram',
      '内存布局 / 页表结构 → ```dot（精确的多框图）',
      '调度算法 → markdown 表格 + ```mermaid gantt',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/llm|transformer|deep\s*learn|machine\s*learn|神经网络|大模型|nlp/.test(s)) {
    return [
      '⭐ 模型架构（Transformer block / 注意力层）→ ```dot 代码块，subgraph cluster 划分模块',
      '⭐ 计算图（前向/反向）/ 张量流 → ```dot',
      'Tokenizer 树 / BPE merge → ```dot',
      '训练流程 / 数据 pipeline → ```mermaid flowchart',
      'Attention 矩阵 / 概率分布 → markdown 表格（小规模）',
      '损失曲线趋势 → 简单 ASCII 走势图',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/discrete|离散|logic|逻辑|graph|图论|组合/.test(s)) {
    return [
      '关系 / 真值表 → markdown 表格',
      '⭐ 图论结构（节点+边、路径、连通分量）→ ```dot 代码块',
      '推理链 → ```mermaid flowchart 或编号列表',
    ].map((s) => '- ' + s).join('\n');
  }
  return [
    '核心概念有"结构关系"时：树 / 图 / 拓扑 → ```dot；流程 / 时序 → ```mermaid',
    '自定义示意图（几何、受力、电路）→ 原生 <svg viewBox="..."> 块',
    '没必要硬塞图，讲义本身写清楚比放图重要',
  ].map((x) => '- ' + x).join('\n');
}


export function exercisePrompt(subject: Subject, lessonTitle: string, count: number, difficulty: number, ctx: PromptContext): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'exercise-gen' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + exercisePersonalizationContext(ctx, difficulty, count) + `\n请生成练习题。输出纯 JSON 数组，格式如下：
[
  {
    "id": "ex-01",
    "prompt": "题目内容",
    "type": "free-response",
    "difficulty": ${difficulty}
  }
]
要求：
- type 可选：free-response、multiple-choice、code
- 生成 ${count} 道题
- 难度围绕 ${difficulty}/5
- 如果资料中的参考习题有明确章节映射、题型风格或考点分布，请优先借鉴这些信息重新命题，不要复制原题
- 题目要明显贴合学生当前水平、学习目标、学习偏好和最近薄弱点
- 如果生成选择题，不要把所有题都做成选择题；尽量保证题型有区分度
- 如果生成代码题，只在当前学科或资料内容明显适合代码表达时使用
- 只输出 JSON`,
    },
    {
      role: 'user',
      content: `请为“${subjectLabel(subject)}”的“${lessonTitle}”生成 ${count} 道练习题。

请特别注意：
- 参考资料中的课后习题、章末习题、例题或复习题风格，但不要照抄
- 如果学生有明显薄弱点，优先让题目覆盖这些内容
- 让题组既能检查基本掌握，也能检查方法迁移`,
    },
  ];
}

export function gradePrompt(exercisePromptText: string, studentAnswer: string, ctx: PromptContext): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'grade' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请批改学生答案。输出纯 JSON，格式如下：
{
  "score": 85,
  "feedback": "详细反馈（Markdown）",
  "strengths": ["优点1"],
  "weaknesses": ["不足1"],
  "strengthTags": ["clarity"],
  "weaknessTags": ["concept"],
  "preferenceTags": ["needs-steps"],
  "confidence": "medium"
}
要求：
- 分数范围 0 到 100
- 反馈具体、可执行
- strengthTags 只能从 accuracy reasoning clarity structure application other 中选择
- weaknessTags 只能从 concept syntax logic edge-case complexity debugging other 中选择
- preferenceTags（重要！用来沉淀学生的"学习风格信号"，直接影响后续讲义生成）：
  · 只从 [too-abstract, needs-steps, needs-example, too-verbose, too-brief, notation-confusing, pace-too-fast, pace-too-slow] 中选择 0-3 个
  · 推断信号：
    - 学生答案过短 / 跳步骤 → 'too-brief' 或 'needs-steps'
    - 学生用大量符号但不解释 → 'notation-confusing'
    - 答得对但啰嗦 → 'too-verbose'
    - 答案显示概念混淆 → 'too-abstract' 或 'needs-example'
    - 学生留空 / "不会" → 'pace-too-fast'（可能讲义太快了）
  · 没有明显信号就给空数组 []，不要编造
- confidence 只能是 low medium high
- strengths 和 weaknesses 保持简洁，便于后续沉淀到课程 profile
- 只输出 JSON`,
    },
    { role: 'user', content: `题目：${exercisePromptText}\n\n学生答案：${studentAnswer}` },
  ];
}

export function diagnosisPrompt(
  subject: Subject,
  topicSummaries: string,
  recentGrades: string,
  ctx: PromptContext
): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'diagnosis' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请分析学生当前的学习情况，输出纯 JSON，格式如下：
{
  "subjectSnapshots": [
    {
      "subject": "学科名",
      "mastery": 75,
      "recentTrend": "improving",
      "topStrengths": ["强项1"],
      "topWeaknesses": ["弱项1"],
      "keyMistakePatterns": ["错误模式1"],
      "recommendedFocus": "建议重点"
    }
  ],
  "overallStrategy": "整体学习策略建议",
  "nextSteps": ["下一步建议"]
}
要求：
- 基于数据识别概念漏洞和错误模式
- 只输出 JSON`,
    },
    { role: 'user', content: `各主题统计摘要：\n${topicSummaries}\n\n最近批改记录：\n${recentGrades}` },
  ];
}

export function materialIndexPrompt(text: string, subject: Subject): ChatMessage[] {
  // 扩大扫描范围 + 抽样三段式（开头 / 中段 / 末段），避免目录不在前 15K 字时漏识别章节
  const head = text.slice(0, 18000);
  const totalLen = text.length;
  const middle = totalLen > 30000 ? '\n\n[ ...中段抽样... ]\n\n' + text.slice(Math.floor(totalLen / 2) - 3000, Math.floor(totalLen / 2) + 3000) : '';
  const tail = totalLen > 24000 ? '\n\n[ ...末段抽样... ]\n\n' + text.slice(-6000) : '';
  const sampledText = head + middle + tail;

  return [
    {
      role: 'system',
      content: `你是一位教学资料分析专家。请分析以下课程资料文本，提取**所有**章节结构化信息。

【重点】不要只看开头！教材可能没有显式目录页，章节标题分散在正文里——
需要扫描整段文本，识别所有形如"第 N 章"、"Chapter N"、"§N"、
markdown "## " 标题、章节编号 "N.M" 等模式的章节起始。

输出纯 JSON：
{
  "chapters": [
    {
      "chapterNumber": "1" 或 "第一章" 等原文形式（**必填**，便于后续匹配）,
      "title": "章节标题",
      "summary": "200-300 字摘要",
      "keyPoints": ["知识点1", "知识点2"],
      "topicMapping": ["可能对应的课程主题 ID 或标题"]
    }
  ]
}

【硬要求】
- chapters 数组应至少 5 条（除非教材确实只有 1-3 章；那种情况罕见）。
  如果你只识别出 1-2 章，**重新扫描文本**，特别注意正文中间的章节标题（不只是开头目录）
- 章节按出现顺序排列
- chapterNumber 保留教材原文形式（"第八章" / "8" / "Chapter 8" 都可），便于后续匹配
- 只输出 JSON`,
    },
    { role: 'user', content: `学科：${subjectLabel(subject)}\n\n资料内容（含开头 / 中段 / 末段抽样）：\n${sampledText}` },
  ];
}

export function textbookChunkParsePrompt(
  text: string,
  subject: Subject,
  options?: { chunkIndex?: number; totalChunks?: number }
): ChatMessage[] {
  const chunkIndex = options?.chunkIndex ?? 1;
  const totalChunks = options?.totalChunks ?? 1;

  return [
    {
      role: 'system',
      content: `你是一位教材结构化解析专家，擅长处理 OCR 抽取后的教材文本。你的任务是从单个文本片段中抽取“章号、节号、主题内容、课后习题映射”。

输出纯 JSON，严格使用下面的结构：
{
  "documentType": "textbook" | "notes" | "mixed" | "unknown",
  "chapters": [
    {
      "chapterNumber": "1",
      "title": "章节标题",
      "summary": "这一章在当前片段中涵盖的内容摘要",
      "keyPoints": ["知识点1", "知识点2"],
      "topicMapping": ["可能对应的课程主题"],
      "sectionNumbers": ["1.1", "1.2"],
      "relatedExerciseTitles": ["习题1.1"]
    }
  ],
  "sectionMappings": [
    {
      "chapterNumber": "1",
      "chapterTitle": "章节标题",
      "sectionNumber": "1.1",
      "sectionTitle": "小节标题",
      "summary": "本节内容摘要",
      "keyPoints": ["知识点1", "知识点2"],
      "topicMapping": ["可能对应的课程主题"],
      "anchorTerms": ["便于后续定位原文的关键词或短语"],
      "relatedExerciseTitles": ["习题1.1", "章末练习"]
    }
  ],
  "exerciseMappings": [
    {
      "chapterNumber": "1",
      "chapterTitle": "章节标题",
      "sectionNumber": "1.1",
      "sectionTitle": "小节标题",
      "title": "习题1.1",
      "exerciseType": "课后习题",
      "summary": "这一组习题主要考查什么",
      "keyPoints": ["考点1", "考点2"],
      "topicMapping": ["可能对应的课程主题"],
      "anchorTerms": ["原文中的习题标题或关键词"],
      "relatedSections": ["1.1 小节标题", "1.2 小节标题"]
    }
  ]
}

规则：
- 只抽取当前片段里能确认的信息，不要编造未出现的章节。
- 章号、节号尽量保留教材原格式，例如 "第1章"、"1"、"1.2"、"§1.2" 都可以，但要稳定。
- 如果 OCR 文本不完整，可以结合上下文做谨慎推断；一旦推断，请只在 summary 中自然表达，不要添加解释字段。
- 对课后习题、章末习题、复习题、综合练习、例题要尽量做映射，重点说明它们主要对应哪些节或知识点。
- "anchorTerms" 应该短、可搜索，便于后续在原始 OCR 文本中定位。
- 每个数组控制精简：keyPoints / topicMapping / anchorTerms 最多 5 项。
- 只输出 JSON，不要输出 Markdown，不要解释。`,
    },
    {
      role: 'user',
      content: `学科：${subjectLabel(subject)}
当前片段：${chunkIndex}/${totalChunks}

教材 OCR / 提取文本片段：
${text.slice(0, 12000)}`,
    },
  ];
}

export function chatPrompt(userMessage: string, history: ChatMessage[], ctx: PromptContext): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'chat' };
  const system: ChatMessage = {
    role: 'system',
    content: buildSystemBase(scopedCtx) + `\n你现在是学生的 AI 学习助手，可以回答学习相关的任何问题。
要求：
- 优先基于当前课程大纲、资料摘要和命中的资料片段回答
- 如果答案里包含推断，请明确说明“这是根据现有资料做的推断”
- 如果资料不足以支持一个确定结论，要明确说出缺口
- 如果使用了某份资料，尽量在答案末尾写出“参考资料：文件名”
- 语气清晰、耐心、鼓励，必要时使用 LaTeX 和代码示例`,
  };
  return [system, ...history, { role: 'user', content: userMessage }];
}

export function reviseMarkdownPrompt(
  instruction: string,
  currentContent: string,
  targetLabel: string,
  ctx: PromptContext
): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'lecture-edit' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n你正在直接修改一份现有的课程讲义 Markdown 文件，系统会把你的输出直接写回磁盘。
要求：
- 必须根据用户反馈修改“当前 Markdown 内容”
- 输出完整的修订后 Markdown，不要只输出片段
- 保留与本次要求无关的有效内容，除非用户明确要求删除、合并、重构
- 如果用户要求补充内容，请补到合适的位置，而不是简单附在文末
- 如果用户要求重构结构，可以调整标题层级和段落顺序，但保持内容连贯
- 只输出最终 Markdown，不要解释，不要写“已修改”，不要使用 Markdown 代码块包裹`,
    },
    {
      role: 'user',
      content: `目标讲义：${targetLabel}

用户反馈：
${instruction}

当前 Markdown 内容：
${currentContent}

请直接输出修订后的完整 Markdown。`,
    },
  ];
}

export function reviseMarkdownPatchPrompt(
  instruction: string,
  targetLabel: string,
  documentOutline: string,
  relevantSections: string,
  ctx: PromptContext
): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'lecture-edit' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\nYou are editing an existing lecture markdown file. To keep the response small and fast, do not rewrite the whole document unless absolutely necessary. Return pure JSON only in this schema:
{
  "action": "replace_section" | "insert_after_section" | "insert_before_section" | "append_document",
  "targetHeading": "exact heading line from DOCUMENT OUTLINE, empty when action is append_document",
  "content": "markdown fragment"
}

Rules:
- Choose exactly one action.
- Prefer the smallest possible edit.
- When action is replace_section, content must include the full replacement section including its heading line.
- When action is insert_after_section or insert_before_section, content must be only the fragment to insert.
- targetHeading must exactly match one heading line from DOCUMENT OUTLINE when the action is section-based.
- Do not wrap JSON in code fences.
- Do not include explanations outside the JSON.`,
    },
    {
      role: 'user',
      content: `Target lecture: ${targetLabel}

User request:
${instruction}

Document outline:
${documentOutline}

Relevant sections:
${relevantSections}

Return JSON only.`,
    },
  ];
}

// ===== Inline Editing (Phase 1A) =====

/**
 * Trim a long markdown document into a budget for prompt injection while keeping
 * both the head and the tail visible. We keep the first half and the last half so
 * the model still sees the document beginning + ending; middle is collapsed.
 */
function clampInlineDocument(documentContext: string, budget = 8000): string {
  if (!documentContext) {
    return '';
  }
  if (documentContext.length <= budget) {
    return documentContext;
  }
  const halfBudget = Math.floor((budget - 40) / 2);
  const head = documentContext.slice(0, halfBudget);
  const tail = documentContext.slice(documentContext.length - halfBudget);
  return `${head}\n\n[...省略 ${documentContext.length - head.length - tail.length} 字...]\n\n${tail}`;
}

const INLINE_OUTPUT_RULES = `
你正在直接修改一份课程讲义 Markdown 文件，输出会被精确写回到原文档的某个位置。
硬性规则：
- 只输出新的 markdown 片段本身，不要复述原选区或上下文。
- 不要返回“好的、我已修改”这类元话或说明。
- 保留 LaTeX 公式格式：行内用 $...$、独立用 $$...$$，并且单个 $ 不能跨行。
- 如果原文里有代码块，保留同样的语言标识（例如 \`\`\`python）。
- 不要用 markdown 代码围栏整体包裹整段输出，除非用户明确要求生成代码块。
- 输出必须可以直接拼接进 Markdown 文档，不要加额外的前导/尾随空白。`;

/**
 * Insert mode: produce a new markdown fragment that should be appended after the
 * cursor / selection. The model sees the whole lecture for context but should NOT
 * rewrite the existing surrounding text.
 */
export function inlineInsertPrompt(args: {
  documentContext: string;
  cursorContext: string;
  selectionText: string;
  instruction: string;
  ctx: PromptContext;
}): ChatMessage[] {
  const { documentContext, cursorContext, selectionText, instruction, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'lecture-edit' };
  const trimmedSelection = selectionText.trim();

  const userParts: string[] = [
    `用户指令：${instruction}`,
    '',
    '完整讲义（已截取，前后保留）：',
    '"""',
    clampInlineDocument(documentContext),
    '"""',
    '',
    '光标附近的上下文窗口（约 ±20 行）：',
    '"""',
    cursorContext || '（无）',
    '"""',
  ];

  if (trimmedSelection) {
    userParts.push(
      '',
      '当前选中的文本（你的输出会插入到选区末尾，不要重复这段）：',
      '"""',
      trimmedSelection,
      '"""'
    );
  }

  userParts.push(
    '',
    '请直接输出要插入的 markdown 片段。不要返回原始上下文，不要解释。'
  );

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + INLINE_OUTPUT_RULES + `

任务模式：在指定位置“追加插入”一段新内容。
- 你只产生新的 markdown 片段，不要重写已经存在的段落。
- 新内容应该和上文风格、术语、记号保持一致。
- 如果用户没要求，不要新增大标题；优先用小标题或自然段。`,
    },
    {
      role: 'user',
      content: userParts.join('\n'),
    },
  ];
}

/**
 * Rewrite mode: replace the user's selected text with a revised version, given
 * full document context for coherence.
 */
export function inlineRewritePrompt(args: {
  documentContext: string;
  selectionText: string;
  instruction: string;
  ctx: PromptContext;
}): ChatMessage[] {
  const { documentContext, selectionText, instruction, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'lecture-edit' };

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + INLINE_OUTPUT_RULES + `

任务模式：重写用户选中的那一段文字。
- 输出会“替换”掉原选区文本，所以请输出完整的替换段。
- 保留原段意图与重要事实，按用户指令调整表达、节奏、深度或例子。
- 如果原选区是带标题的小节，保留同样层级的标题；如果只是一段段落，不要凭空加标题。`,
    },
    {
      role: 'user',
      content: [
        `用户指令：${instruction}`,
        '',
        '完整讲义（用于参考整体语境，已截取）：',
        '"""',
        clampInlineDocument(documentContext),
        '"""',
        '',
        '需要重写的选中文本（必须给出整段替换，不要复述原文）：',
        '"""',
        selectionText,
        '"""',
        '',
        '请直接输出重写后的 markdown，不要解释。',
      ].join('\n'),
    },
  ];
}

// ===== Project (TDD-style learning project) =====

/**
 * 生成一个完整的 project spec：
 *   - boilerplate（package.json / 配置文件 / 入口）
 *   - test 骨架（it.todo / describe + 占位 body，AI 描述要测什么，user 来填或扩展）
 *   - user stub 文件（函数签名 + TODO 注释 + 必要的 import 占位）
 *   - README + TODO（学习目标、运行测试方式、验收标准）
 *
 * 约定：
 *   - AI 决定每个 user-stub 文件的"密度"（thin/medium/thick），看复杂度
 *   - 测试骨架走 "B 选项"：测试名 + describe，body 是 `it.todo('...')` 或带注释的 placeholder
 *   - 不写 user 应该实现的核心逻辑
 *   - 输出严格 JSON，符合 ProjectSpec interface
 */
export function projectSpecPrompt(args: {
  subject: string;
  userPrompt: string;
  techStackHint?: string;
  linkedCourseTitle?: string;
  linkedTopicTitle?: string;
  ctx: PromptContext;
}): ChatMessage[] {
  const { subject, userPrompt, techStackHint, linkedCourseTitle, linkedTopicTitle, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'project-spec' };

  const contextLines: string[] = [
    `用户想要学习的领域：${subject}`,
    `用户的项目想法（原话）：${userPrompt}`,
  ];
  if (techStackHint) {
    contextLines.push(`用户的技术栈偏好：${techStackHint}`);
  }
  if (linkedCourseTitle) {
    contextLines.push(`关联课程：${linkedCourseTitle}${linkedTopicTitle ? ` / ${linkedTopicTitle}` : ''}`);
  }

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `

你是 TDD 式学习项目的设计者。设计哲学 = **UCB CS61B 的项目风格**：
  - Project 1（Deque）：让学生**从零写**一个真正的双端队列
  - Project 2（Gitlet）：一个能跑的迷你 git
  - Project 3（BYOW）：一个能玩的 2D tile-based 游戏
共同特征：**一个有意义的端到端交付物 + 一套具体可跑的测试当规约 + 完全自由的内部实现**。

【核心原则——硬性，不可违反】
1. **项目 = 一个聚焦的、能用的交付物**。3-8 个文件，不要 15+ 微模块。
2. **测试就是规约**：每条测试都是**具体可跑的断言**，含真实输入 / 真实期望输出。学生看测试就知道函数该怎么 work。
3. **Stub 文件只有 signature + 一句行为描述**。**严禁**把算法步骤写成 step-by-step TODO 注释（"# TODO 1: 检查 X / # TODO 2: 计算 Y / # TODO 3: 滑动"），那是把答案直接给学生，毁掉学习 agency。
4. **README 描述 WHAT + WHY + 验收**，不是 HOW；不写"step 1: 创建文件夹"这种废话。

【文件 role 定义】
1. \`boilerplate\`：完整写好不动：package.json / pyproject.toml / 配置文件 / 测试 runner setup
2. \`test-skeleton\`（**保留名字但语义已变**）：**具体可跑的测试**，每条都有真实 assert。覆盖 happy path + 边界 + 错误处理。学生不动测试，只让它们 pass。
   ✓ 好的测试样例：
   \`\`\`python
   def test_chunk_basic():
       assert chunk_tokens([1,2,3,4,5,6,7,8], window_size=4, overlap=2) == [[1,2,3,4],[3,4,5,6],[5,6,7,8]]
   def test_chunk_keeps_short_tail():
       assert chunk_tokens([1,2,3,4,5], window_size=4, overlap=2) == [[1,2,3,4],[3,4,5]]
   def test_chunk_invalid_window():
       with pytest.raises(ValueError):
           chunk_tokens([1,2,3], window_size=0, overlap=0)
   \`\`\`
   ✗ **绝对禁止**：\`it.todo(...)\` / \`pytest.skip(...)\` / \`expect(true).toBe(false)\` / 任何占位 assert / "// TODO: import X then..." 注释。
3. \`user-stub\`：**仅有签名 + 一句行为描述 + raise NotImplementedError / throw**。
   ✓ 好的 stub 样例：
   \`\`\`python
   def chunk_tokens(token_ids: list[int], window_size: int, overlap: int) -> list[list[int]]:
       """Split token_ids into overlapping windows. See tests for exact behavior."""
       raise NotImplementedError
   \`\`\`
   \`\`\`ts
   /** A double-ended queue with O(1) amortized push/pop on both ends.
    *  See tests/ArrayDeque.test.ts for the full behavioral spec. */
   export class ArrayDeque<T> {
     // implement me — see tests
   }
   \`\`\`
   ✗ **绝对禁止**（这些会让验证直接 reject，spec 被打回让你重做）：
   - 任何 \`// TODO\`、\`# TODO\`、\`/* TODO\` 注释（无论有没有编号、有没有冒号）
   - 任何 \`// Hint:\`、\`# Hint:\` 注释
   - 任何把算法步骤拼出来的引导（"先做 X 再做 Y"、"用 useState 管理 count"、
     "用 set.has() 检查"、"步骤 1 / 步骤 2"等）
   - 多行实现思路注释列表
   **学生需要的所有引导，都放到 TODO.md / README.md 文件里**（role: 'doc'），
   **不要污染源码文件**。Stub 函数 body 里**只允许**：throw / raise + （可选）一行 docstring 描述函数做什么。
   学生应**读测试反推行为，自己拆步骤，自己设计算法**。Stub 的存在仅仅是让代码能编译，**不是教程**。
4. \`doc\`：README.md，user 进项目第一眼看的内容。结构：
   - 这个项目要做什么（产品视角）
   - 完成后你能学到什么 capability
   - 怎么验证完成：跑 \`testCommand\`，所有测试通过
   - 不要写 step-by-step 实现指南

【输出严格 JSON，schema 如下】
\`\`\`json
{
  "title": "string，项目标题，简短，e.g. 'Implement minimal React useCounter hook'",
  "description": "string，1-2 句话：学什么 + 最终产物",
  "learningGoals": ["string", ...], // 3-5 条
  "prerequisites": ["string", ...], // 0-3 条
  "techStack": ["string", ...],     // 用到的库/语言/工具
  "testCommand": "string，e.g. 'npm test'",
  "files": [
    {
      "path": "相对路径，e.g. 'src/hooks/useCounter.ts'",
      "role": "boilerplate" | "test-skeleton" | "user-stub" | "doc",
      "content": "完整文件内容",
      "stubDensity": "thin" | "medium" | "thick"  // 仅 role=user-stub 时给
    }
  ],
  "todos": [
    {
      "id": "todo-1",
      "description": "string，user 看的描述",
      "targetFile": "相对路径",
      "checkCriteria": "string，怎么算 pass",
      "difficulty": 1-5
    }
  ],
  "testStrategy": "markdown 字符串，说明：跑什么命令 / 看什么 / 哪些测试该 pass / 排查思路"
}
\`\`\`

【约束】
- files 总数 **3-8 个**，聚焦核心交付物，不要发散成 15+ 微模块。
- todos **3-6 个**，每个是 **high-level 里程碑**（"实现 X 功能让 Y 测试组通过"），**不是**算法 step。
- **techStack 必须非空，2-5 项**，每项是具体技术（"TypeScript"、"Vitest"、"React 19"），不是"前端"这种模糊词。
- **绝对禁止测试占位**：\`.todo\` / \`it.skip\` / 假 assert / placeholder body。每个测试都必须能真跑、有真断言。
- **绝对禁止 stub 里写算法步骤** TODO 注释 / import 暗示 / API 用法提示。stub 是让代码编译，不是教程。
- 不要用已废弃技术（CRA / TSLint / Bower 等）；优先 2026 年主流。
- 难度判断：基于 user_prompt 表达的水平 + 学习目标合理性。
- **只输出 JSON**，不要 markdown 围栏，不要解释。`,
    },
    {
      role: 'user',
      content: contextLines.join('\n') + '\n\n请生成 ProjectSpec JSON。',
    },
  ];
}
