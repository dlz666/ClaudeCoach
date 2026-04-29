/**
 * Misconception 模板库 — 预置常见学习误区。
 *
 * 设计哲学：
 * - misconception 是"结构性的、跨学生反复出现的、典型的"错误理解。
 *   不同于"这个学生不会"，而是"任何一批学生都有 30%+ 会踩中"。
 * - 库内容来自经典教科书的 errata、教学论文、Stack Exchange 高频问答。
 *
 * 使用流水线：
 *   学生答案文本 → matchMisconceptions() → 命中的 misconception[]
 *           → 写入 GradeResult.weaknesses（前置 [误区:id]）
 *           → recordEvent 进 chapter.misconceptions
 *           → 下次讲义生成时，prompt 列出"本节常踩的 N 个误区，请前置说清"
 *
 * 库的扩展性：
 * - 用户的 ~/ClaudeCoach/app/misconceptions/<subject>.json 可覆盖/扩展默认库
 *   （未实现的 v2 能力，留 hook 在 loadMisconceptionsForSubject）
 */

import type { FeedbackWeaknessTag, Subject } from '../types';

export interface MisconceptionTemplate {
  /** 全局唯一 id，用作 dedup key */
  id: string;
  /** 显示名（短）— 出现在 weakness 列表里给学生看 */
  shortName: string;
  /** 详细描述 — 注入 prompt 时给 AI 看 */
  description: string;
  /** 关联的 weakness tag — 命中后会加进该 tag 的统计 */
  tag: FeedbackWeaknessTag;
  /**
   * 触发模式：
   * - RegExp：正则匹配（学生答案文本）— 典型用法
   * - string[]：多个关键词，命中任一即触发
   * - { all: string[] }：必须全部命中（用于多概念组合误区）
   */
  match: RegExp | string[] | { all: string[] };
  /** 该误区涉及的高级别主题（可选，用于讲义/章节匹配） */
  topicKeywords?: string[];
}

/**
 * 默认库：按学科 key 分组。
 * 学科 key 用宽匹配——key 出现在用户 subject 字符串里就算命中。
 * 例如 'linear-algebra' 也会匹配 "线性代数 / Linear Algebra Done Right"。
 */
const DEFAULT_LIBRARY: Record<string, MisconceptionTemplate[]> = {
  // ============================================================
  // 线性代数
  // ============================================================
  'linear-algebra': [
    {
      id: 'la-matmul-commute',
      shortName: '矩阵乘法可交换',
      description: '把矩阵乘法当数字算术 — 一般 AB ≠ BA。仅特殊情形（如对角阵之间、可对易算子）才相等。',
      tag: 'concept',
      match: /(矩阵.*交换律|AB\s*=\s*BA|matrix.*commut)/i,
      topicKeywords: ['矩阵', '矩阵乘法', 'matrix'],
    },
    {
      id: 'la-rank-mix',
      shortName: '行秩 ≠ 列秩',
      description: '行秩 = 列秩是定理（任何矩阵都成立），不是巧合。证明可以通过矩阵分解或线性映射的核-像定理。',
      tag: 'concept',
      match: /(行秩.*[≠不等]\s*列秩|row rank.*≠.*column rank|行秩.*列秩.*不同)/i,
      topicKeywords: ['秩', '行秩', '列秩', 'rank'],
    },
    {
      id: 'la-det-nonzero-implies-inv',
      shortName: '只看行列式判可逆是循环论证',
      description: '"行列式 ≠ 0 ⇔ 可逆"是定理，不能用它证明矩阵可逆——证明可逆通常要构造逆矩阵或用秩为 n 等独立论证。',
      tag: 'logic',
      match: /(因为.*det.*0.*所以.*可逆|because.*det.*0.*therefore.*invertible)/i,
      topicKeywords: ['行列式', '可逆', 'determinant', 'invertible'],
    },
    {
      id: 'la-eigenvec-zero',
      shortName: '把 0 当本征向量',
      description: '本征向量定义要求 v ≠ 0；0 不是本征向量（虽然 A·0 = λ·0 对任何 λ 都成立）。',
      tag: 'concept',
      match: /(0\s*是.*本征向量|0\s*is.*eigenvector|零向量.*本征向量)/i,
      topicKeywords: ['本征向量', '特征向量', 'eigenvector'],
    },
    {
      id: 'la-span-unique',
      shortName: '张成组只有一种',
      description: '同一向量空间可以由多组不同的向量张成；张成组不唯一。基才追求"长度等于维数 + 线性无关"。',
      tag: 'concept',
      match: /(张成组.*唯一|spanning set.*unique|张成.*只有一组)/i,
      topicKeywords: ['张成', '基', 'span', 'basis'],
    },
  ],

  // ============================================================
  // 微积分
  // ============================================================
  'calculus': [
    {
      id: 'cal-int-area',
      shortName: '积分等于面积',
      description: '定积分 = 带号面积。曲线在 x 轴下方时积分为负数，不等于"几何面积"。求几何面积要 ∫|f(x)|dx。',
      tag: 'concept',
      match: /(积分.*[就直接]?\s*[等于是]\s*面积|integral.*equals.*area)/i,
      topicKeywords: ['定积分', '面积', 'integral', 'area'],
    },
    {
      id: 'cal-deriv-equal-diff',
      shortName: '导数等于微分',
      description: '导数是函数（或值），微分 dy = f\'(x)dx 是线性近似量。dy/dx 是记号不是分数（早期），但也常用作分数处理（链式法则成立）。',
      tag: 'concept',
      match: /(导数.*=.*微分|微分\s*就是\s*导数|derivative\s*=\s*differential)/i,
      topicKeywords: ['导数', '微分', 'derivative', 'differential'],
    },
    {
      id: 'cal-cont-diff',
      shortName: '连续 ⇒ 可导',
      description: '连续 ≠ 可导。|x| 在 x=0 处连续但不可导。可导 ⇒ 连续，反之不成立。',
      tag: 'concept',
      match: /(连续.*所以.*可导|continuous.*therefore.*differentiable)/i,
      topicKeywords: ['连续', '可导', 'continuity', 'differentiable'],
    },
    {
      id: 'cal-limit-substitute',
      shortName: '直接代入求极限',
      description: '只有连续函数才能直接代入。非连续点（间断 / 0/0 / ∞-∞）必须用洛必达 / 等价无穷小 / 泰勒展开。',
      tag: 'logic',
      match: /(直接代入.*[就]\s*[得到]?\s*[极限值]|just plug in.*limit)/i,
      topicKeywords: ['极限', '洛必达', 'limit', "L'Hopital"],
    },
  ],

  // ============================================================
  // 离散数学
  // ============================================================
  'discrete-math': [
    {
      id: 'dm-converse-equiv',
      shortName: '逆命题与原命题等价',
      description: 'p→q 与 q→p（逆命题）一般不等价；与 ¬q→¬p（逆否命题）才等价。混淆这两个是离散数学最经典误区。',
      tag: 'logic',
      match: /(逆命题.*[等同?于]\s*原命题|p→q.*等价.*q→p|converse.*equivalent.*original)/i,
      topicKeywords: ['命题', '逆命题', 'converse', 'contrapositive'],
    },
    {
      id: 'dm-induction-base-skip',
      shortName: '归纳证明跳过基础步',
      description: '数学归纳法必须先证 n=1（或起始）成立。仅有归纳步骤不够——基础步立不住，整个归纳就崩。',
      tag: 'logic',
      match: /(归纳.*只.*证明.*归纳步|skip.*base case|不需要.*基础步)/i,
      topicKeywords: ['归纳', 'induction'],
    },
    {
      id: 'dm-empty-quantifier',
      shortName: '空集上的全称命题',
      description: '"对空集中所有 x，P(x)"按定义是真（vacuously true），不是假。容易反直觉。',
      tag: 'concept',
      match: /(空集.*全称.*假|empty set.*universal.*false|空集.*for all.*不成立)/i,
      topicKeywords: ['量词', '空集', 'quantifier', 'vacuously'],
    },
    {
      id: 'dm-counting-overlap',
      shortName: '组合计数忽略重叠',
      description: '|A ∪ B| ≠ |A| + |B|，要减去 |A ∩ B|。容斥原理是这一类计数的核心。',
      tag: 'logic',
      match: /(\|A\s*∪\s*B\|\s*=\s*\|A\|\s*\+\s*\|B\||A or B.*equals.*A.*plus.*B)/i,
      topicKeywords: ['计数', '容斥', 'counting', 'inclusion-exclusion'],
    },
  ],

  // ============================================================
  // 数据结构
  // ============================================================
  '数据结构': [
    {
      id: 'ds-bst-balance',
      shortName: 'BST 自动平衡',
      description: '普通 BST 不会自平衡，最坏情况退化为链表（O(n)）。AVL / 红黑树 才有平衡保证。',
      tag: 'concept',
      match: /(BST.*[自动]?平衡|binary search tree.*automatically.*balance)/i,
      topicKeywords: ['二叉搜索树', 'BST', '平衡', 'balance'],
    },
    {
      id: 'ds-array-vs-list',
      shortName: '数组和链表 push/pop 都是 O(1)',
      description: '数组末尾 push/pop O(1)，开头 O(n)；链表两端都 O(1)（但需要双向链表 + tail 指针）。',
      tag: 'complexity',
      match: /(数组.*开头.*O\(1\)|array.*front.*O\(1\)|链表.*随机访问.*O\(1\))/i,
      topicKeywords: ['数组', '链表', 'array', 'linked list'],
    },
    {
      id: 'ds-hash-collision',
      shortName: '哈希表查找永远 O(1)',
      description: '平均 O(1)，最坏 O(n)（所有 key 哈希到同一 bucket）。负载因子 / 哈希函数质量决定实际表现。',
      tag: 'complexity',
      match: /(哈希.*[永远|总是]\s*O\(1\)|hash.*always.*O\(1\))/i,
      topicKeywords: ['哈希表', '冲突', 'hash table', 'collision'],
    },
    {
      id: 'ds-recursion-equals-iter',
      shortName: '递归就是循环的另一种写法',
      description: '递归占用栈空间 O(深度)；尾递归才能编译成迭代。深度递归（如 10^5 层）会爆栈；循环不会。',
      tag: 'concept',
      match: /(递归.*[就]\s*是\s*循环|recursion.*same.*loop)/i,
      topicKeywords: ['递归', '循环', 'recursion', 'iteration'],
    },
    {
      id: 'ds-dp-vs-memo',
      shortName: 'DP = 记忆化递归',
      description: 'DP 的核心是 (1) 最优子结构 (2) 重叠子问题。记忆化只是 DP 的一种实现手段（自顶向下）；自底向上的迭代填表也是 DP。',
      tag: 'concept',
      match: /(动态规划.*[就]\s*是\s*记忆化|DP.*equals.*memoization)/i,
      topicKeywords: ['动态规划', '记忆化', 'DP', 'memoization'],
    },
  ],
};

/**
 * 根据 subject 字符串模糊匹配相应的库。
 * 不区分大小写；支持中英对应（"线性代数" → 'linear-algebra'）。
 */
export function loadMisconceptionsForSubject(subject: Subject): MisconceptionTemplate[] {
  const s = (subject || '').toLowerCase();
  const out: MisconceptionTemplate[] = [];
  for (const [key, list] of Object.entries(DEFAULT_LIBRARY)) {
    const k = key.toLowerCase();
    if (s.includes(k)) {
      out.push(...list);
      continue;
    }
    // 中英对应表（粗粒度）
    if (k === 'linear-algebra' && /(线性代数|linear)/.test(s)) out.push(...list);
    else if (k === 'calculus' && /(微积分|calculus|高等数学|高数)/.test(s)) out.push(...list);
    else if (k === 'discrete-math' && /(离散|discrete)/.test(s)) out.push(...list);
    else if (k === '数据结构' && /(数据结构|data structure|algorithm)/.test(s)) out.push(...list);
  }
  return out;
}

/**
 * 在学生答案 / 反馈文本里检测命中哪些误区。
 *
 * @param text 待匹配文本（学生答案 + AI 反馈拼起来更精准）
 * @param library 该学科的可用模板
 * @returns 命中的模板列表（可能为空数组）
 */
export function matchMisconceptions(
  text: string,
  library: MisconceptionTemplate[],
): MisconceptionTemplate[] {
  if (!text || !library.length) return [];
  const lower = text.toLowerCase();
  const hits: MisconceptionTemplate[] = [];
  for (const m of library) {
    if (m.match instanceof RegExp) {
      if (m.match.test(text)) hits.push(m);
    } else if (Array.isArray(m.match)) {
      // 任一关键词命中即触发
      if (m.match.some((kw) => lower.includes(kw.toLowerCase()))) hits.push(m);
    } else if (m.match && typeof m.match === 'object' && 'all' in m.match) {
      if ((m.match.all as string[]).every((kw) => lower.includes(kw.toLowerCase()))) hits.push(m);
    }
  }
  return hits;
}

/**
 * 根据 chapter title / topic 关键词，找出与本章相关的误区。
 * 用于讲义生成时让 AI"前置防御"——告诉 AI 学生在这一章常踩什么。
 */
export function relevantMisconceptionsForTopic(
  topicTitle: string,
  library: MisconceptionTemplate[],
): MisconceptionTemplate[] {
  if (!topicTitle) return [];
  const lower = topicTitle.toLowerCase();
  return library.filter((m) =>
    (m.topicKeywords || []).some((k) => lower.includes(k.toLowerCase())),
  );
}

/**
 * 把命中的误区列表格式化为可注入 prompt 的字符串。
 */
export function formatMisconceptionsForPrompt(hits: MisconceptionTemplate[]): string {
  if (!hits.length) return '';
  return hits
    .map((m) => `- [${m.id}] ${m.shortName}：${m.description}`)
    .join('\n');
}
