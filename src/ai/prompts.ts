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
  ExamPaperAnalysis,
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

export function strictCourseOutlinePrompt(subject: Subject, ctx: PromptContext): ChatMessage[] {
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
        { "id": "lesson-01", "title": "课时名称", "difficulty": 1 }
      ]
    }
  ]
}
要求：
- 包含 5 到 8 个主题
- 每个主题 3 到 5 节课
- 课程标题、主题标题、课时标题以中文为主，但编程语言名、技术框架名（如 React、Python、SQL、HTTP）允许保留英文
- 大纲标题只能写一个短句
- 不要出现公式
- 不要出现 LaTeX
- 尽量避免阿拉伯数字编号，主题与课时之间用空格或“与”连接
- 标点尽量精简，避免长句
- 标题只表达一个核心概念 保持干练
- 大纲只负责列课程结构 不要在标题里展开解释
- difficulty 使用 1 到 5 逐步递进
- 只输出 JSON 不要额外解释`,
    },
    {
      role: 'user',
      content: `请为“${subjectName}”生成课程大纲`,
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

  // 视觉化建议：按学科 hint 引导 mermaid / ASCII
  const visualHint = buildVisualHint(subject);

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
 * 按学科建议合适的视觉化方式：
 * - 数学/物理 → ASCII 投影 + 公式块为主，mermaid 用于概念依赖图
 * - 算法/CS → mermaid flowchart / sequenceDiagram 优先
 * - 离散/逻辑 → mermaid graph (LR/TB)
 * - 其他 → 看情况
 */
function buildVisualHint(subject: Subject): string {
  const s = (subject || '').toLowerCase();
  if (/algebra|代数|矩阵|linear|calculus|微积分|topology|geometry/.test(s)) {
    return [
      '当涉及结构关系（如子空间包含、向量分解）→ 用 mermaid graph 画概念图',
      '当涉及几何对象 → 用三反引号 text 块画 ASCII 投影示意',
      '矩阵直接用 \\(\\begin{bmatrix}...\\end{bmatrix}\\) LaTeX',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/data\s*struct|algo|算法|数据结构|operating|os|computer|网络/.test(s)) {
    return [
      '算法流程 → mermaid flowchart',
      '类/对象交互 → mermaid sequenceDiagram',
      '状态机 / 协议 → mermaid stateDiagram',
      '链表 / 树 / 图 结构 → ASCII art（节点 + 箭头）',
    ].map((s) => '- ' + s).join('\n');
  }
  if (/discrete|离散|logic|逻辑|graph|图论|组合/.test(s)) {
    return [
      '关系 / 真值表 → markdown 表格',
      '图论结构 → mermaid graph LR / TB',
      '推理链 → mermaid flowchart 或编号列表',
    ].map((s) => '- ' + s).join('\n');
  }
  return '- 当核心概念有"结构关系"时，加 mermaid 图（graph / flowchart / sequenceDiagram / stateDiagram 任选）\n- 没必要硬塞图，讲义本身写清楚比放图重要';
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

// =====================================================================
// 备考模式（Exam Prep）
// =====================================================================

/**
 * 试卷分析：拆出 sections / questions / knowledgeFrequency / toneAndDifficulty。
 * 输入是 OCR/抽取后的试卷文本，已截断到 ~12000 字。
 */
export function examPaperAnalysisPrompt(paperText: string, ctx: PromptContext): ChatMessage[] {
  const scopedCtx: PromptContext = { ...ctx, scope: 'exercise-gen' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n你是一位经验丰富的命题分析专家。请分析下面这份真题/模拟卷，输出严格 JSON：
{
  "documentType": "past-paper" | "mock-exam" | "practice-set" | "unknown",
  "sections": [
    {
      "title": "一、选择题（每题 5 分）",
      "questions": [
        {
          "number": "1",
          "type": "choice" | "fill" | "free" | "proof" | "code" | "short" | "unknown",
          "estimatedDifficulty": 3,
          "knowledgePoints": ["矩阵秩", "线性方程组解的判定"],
          "estimatedScore": 5,
          "rawSnippet": "原文片段，最多 200 字"
        }
      ]
    }
  ],
  "knowledgeFrequency": { "矩阵秩": 3, "二次型": 2 },
  "toneAndDifficulty": "整体难度中偏上，强调矩阵理论的综合运用",
  "totalEstimatedScore": 100
}

要求：
- knowledgePoints 必须是具体可识别的考点名词（中文为主），不要写"线代基础"这种泛泛而谈的标签。
- 同一道大题包含多个小问时，可以合并为一个 question，但 knowledgePoints 要并集。
- 题号尽量保留原始格式（"1"、"1.(1)"、"二.5"）。
- knowledgeFrequency 是对所有 question 的 knowledgePoints 做计数汇总。
- 如果某道题看不清/被截断，type 用 "unknown"，rawSnippet 留 "[文本不完整]"。
- 只输出 JSON，不要 markdown 代码围栏，不要解释。`,
    },
    {
      role: 'user',
      content: `试卷文本（已截断）：\n\n${paperText}`,
    },
  ];
}

/**
 * 变体题生成：基于真题分析 + 薄弱点，深度变体（不是换皮）。
 */
export function examVariantPrompt(args: {
  paperAnalyses: ExamPaperAnalysis[];
  weakKnowledgePoints: string[];
  count: number;
  focusMode: 'cover-all' | 'reinforce-weakness' | 'mock-full';
  ctx: PromptContext;
}): ChatMessage[] {
  const { paperAnalyses, weakKnowledgePoints, count, focusMode, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'exercise-gen' };

  const focusModeDescription: Record<typeof focusMode, string> = {
    'cover-all': '尽量均匀覆盖所有真题考点，让学生整体过一遍',
    'reinforce-weakness': '重点强化薄弱考点，70% 题量覆盖薄弱点',
    'mock-full': '模拟一整套考卷的题型分布与难度梯度',
  };

  // 抽取真题考点 + 题型分布给 AI
  const allKnowledge = new Set<string>();
  const typeBuckets: Record<string, number> = {};
  const sampleQuestions: Array<{ number: string; type: string; knowledgePoints: string[]; rawSnippet?: string }> = [];
  for (const analysis of paperAnalyses) {
    for (const section of analysis.sections) {
      for (const q of section.questions) {
        q.knowledgePoints.forEach((kp) => allKnowledge.add(kp));
        typeBuckets[q.type] = (typeBuckets[q.type] ?? 0) + 1;
        if (sampleQuestions.length < 12) {
          sampleQuestions.push({
            number: q.number,
            type: q.type,
            knowledgePoints: q.knowledgePoints,
            rawSnippet: q.rawSnippet?.slice(0, 200),
          });
        }
      }
    }
  }

  const knowledgeList = Array.from(allKnowledge).slice(0, 30);
  const weakList = weakKnowledgePoints.slice(0, 15);

  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n你是一位经验丰富的命题人。请基于下面给出的真题考点分布与学生薄弱点，生成 ${count} 道"深度变体题"。

输出严格 JSON 数组：
[
  {
    "number": "1",
    "type": "choice" | "fill" | "free" | "proof" | "code" | "short",
    "difficulty": 3,
    "prompt": "题面（Markdown，含必要的 LaTeX）",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "knowledgePoints": ["考点1", "考点2"],
    "sourceQuestionRef": "派生自原题 3.(2)（可选）",
    "variantStrategy": ["angle-shift" | "new-scenario" | "combine-points" | "reverse"],
    "estimatedScore": 5
  }
]

== 深度变体的硬性约束（这是你与"换皮题"的根本区别） ==
不要保留原题的：题面表述、具体数字、变量名、场景设定。
必须保留原题的：考点、题型、目标难度。
每道变体题必须做到至少 2 项：
  - 改变考点的呈现角度（例："求行列式" → "判断矩阵可逆性"）
  - 引入新场景（数学题加应用背景；代码题换语言/API；理论题换被推证的对象）
  - 组合 2 个以上考点（让题目同时覆盖多个 knowledgePoints）
  - 反向出题（给结论求条件；给结果反推过程）

== 出题模式 ==
focusMode = ${focusMode}：${focusModeDescription[focusMode]}

== 输出规则 ==
- 题号 number 从 "1" 开始顺序编号。
- choice 类型必须给 options（4 选项），其他类型 options 留空数组或省略。
- variantStrategy 至少 2 个标签。
- prompt 必须是完整可独立作答的题面，不要写"参考原题"。
- 题面 Markdown 中数学公式严格用 $...$（行内）和 $$...$$（独立式）。
- 如果使用代码题，给出明确的输入输出格式或 starter code。
- 只输出 JSON 数组，不要 markdown 代码围栏，不要解释。

== 真题考点分布 ==
全卷考点（去重）：${knowledgeList.join('、') || '（无）'}
题型分布：${Object.entries(typeBuckets).map(([k, v]) => `${k}=${v}`).join(', ') || '（无）'}

== 学生薄弱考点（按重要性递减） ==
${weakList.length ? weakList.join('、') : '（暂无明显薄弱点，按 focusMode 分布即可）'}`,
    },
    {
      role: 'user',
      content: `请生成 ${count} 道深度变体题。

参考真题题样（用于学习考点风格，不要照抄题面）：
${sampleQuestions.length
        ? sampleQuestions.map((q) => `- 题号 ${q.number} | 题型 ${q.type} | 考点 [${q.knowledgePoints.join(', ')}]${q.rawSnippet ? `\n  原文片段：${q.rawSnippet}` : ''}`).join('\n')
        : '（无可参考题样）'}

请输出 JSON 数组。`,
    },
  ];
}

/**
 * Vision 批改：图像 + 题面 JSON → 学生答案 OCR + 评分 + 反馈。
 * 调用方应往 user 消息里塞 images。
 */
export function examVisionGradingPrompt(args: {
  questionsJson: string;
  ctx: PromptContext;
}): MultimodalChatMessage[] {
  const { questionsJson, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'grade' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n你将看到学生的手写答题截图（可能多张）。请：
1. OCR 提取每道题学生写的答案（中文/数学符号/代码 OCR）。
2. 对照下面给出的题面 JSON，给每题打分。
3. 输出严格 JSON：
{
  "perQuestion": [
    {
      "questionNumber": "1",
      "studentAnswerOcr": "OCR 出来的学生答案；不清楚时填 [未识别]",
      "correct": true | false | "partial",
      "score": 8,
      "maxScore": 10,
      "feedback": "1-3 句中文简明反馈",
      "knowledgePoints": ["矩阵秩"],
      "weaknessTags": ["concept" | "syntax" | "logic" | "edge-case" | "complexity" | "debugging" | "other"]
    }
  ],
  "overall": {
    "totalScore": 70,
    "maxScore": 100,
    "percentage": 70,
    "strengths": ["计算准确"],
    "weaknesses": ["证明步骤不严谨"],
    "nextSteps": ["复习二次型正定性判定", "练 3 道反向出题"]
  }
}

要求：
- weaknessTags 只能从 concept / syntax / logic / edge-case / complexity / debugging / other 中选；如无则空数组。
- OCR 不清楚时填 "[未识别]" 但仍尝试根据上下文给出判断；correct 用 false。
- 每题反馈以"鼓励但精确"为原则，1-3 句中文，避免空话套话。
- overall.weaknesses 按"由弱→强"排序，让学生先看到最重要的。
- nextSteps 给出 2-4 条可执行建议（"复习 X 章"、"再做 N 道 Y 类题"）。
- 只输出 JSON，不要 markdown 代码围栏，不要解释，不要任何前缀。`,
    },
    {
      role: 'user',
      content: `题面 JSON：\n${questionsJson}\n\n请对照下面的图片打分。`,
    },
  ];
}

/**
 * 文字 fallback 批改：vision 不可用时让用户手动输入答案。
 */
export function examTextGradingPrompt(args: {
  questionsJson: string;
  studentAnswers: Array<{ questionNumber: string; answer: string }>;
  ctx: PromptContext;
}): ChatMessage[] {
  const { questionsJson, studentAnswers, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'grade' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n请对照题面 JSON 给学生答案打分，输出严格 JSON：
{
  "perQuestion": [
    {
      "questionNumber": "1",
      "studentAnswerOcr": "原样回写学生输入",
      "correct": true | false | "partial",
      "score": 8,
      "maxScore": 10,
      "feedback": "1-3 句中文简明反馈",
      "knowledgePoints": ["矩阵秩"],
      "weaknessTags": ["concept" | "syntax" | "logic" | "edge-case" | "complexity" | "debugging" | "other"]
    }
  ],
  "overall": {
    "totalScore": 70,
    "maxScore": 100,
    "percentage": 70,
    "strengths": ["计算准确"],
    "weaknesses": ["证明步骤不严谨"],
    "nextSteps": ["复习二次型正定性判定"]
  }
}

要求：
- weaknessTags 只能从 concept / syntax / logic / edge-case / complexity / debugging / other 中选。
- 学生未作答的题 score=0、correct=false、studentAnswerOcr="[未作答]"。
- 反馈以"鼓励但精确"为原则，1-3 句。
- overall.weaknesses 按由弱→强排序。
- 只输出 JSON，不要 markdown 代码围栏，不要解释。`,
    },
    {
      role: 'user',
      content: `题面 JSON：\n${questionsJson}\n\n学生答案：\n${JSON.stringify(studentAnswers, null, 2)}`,
    },
  ];
}

/**
 * 就绪度的 AI 部分：根据弱点 + 距考天数 + 最近成绩，生成 3-5 条考前 checklist。
 */
export function examReadinessAnalysisPrompt(args: {
  weakSpots: string[];
  daysToExam?: number;
  latestPercentage?: number;
  ctx: PromptContext;
}): ChatMessage[] {
  const { weakSpots, daysToExam, latestPercentage, ctx } = args;
  const scopedCtx: PromptContext = { ...ctx, scope: 'diagnosis' };
  return [
    {
      role: 'system',
      content: buildSystemBase(scopedCtx) + `\n你正在为学生生成"考前行动清单"。请输出严格 JSON：
{
  "preExamChecklist": [
    "考前 7 天：用 30 分钟过一遍二次型 4 类典型题",
    "考前 3 天：完成 1 套整卷限时模考"
  ]
}

要求：
- 数组长度 3 到 5。
- 每条以"什么时候 + 做什么 + 多久"的可执行格式给出（中文）。
- 优先针对弱点；如果没弱点，优先针对距考天数的节奏（远=广覆盖；近=专项 + 整卷）。
- 不要写"加油 / 多做题"这种空话。
- 只输出 JSON，不要 markdown 代码围栏，不要解释。`,
    },
    {
      role: 'user',
      content: `当前弱点（按重要性递减）：${weakSpots.length ? weakSpots.join('、') : '（暂无明显弱点）'}
距考天数：${typeof daysToExam === 'number' ? `${daysToExam} 天` : '未设定'}
最近模考成绩：${typeof latestPercentage === 'number' ? `${latestPercentage}%` : '未做过模考'}

请生成 preExamChecklist。`,
    },
  ];
}
