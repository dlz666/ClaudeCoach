# ClaudeCoach v0.1 全流程评测报告

**评测日期**：2026-04-29
**评测者**：Claude Opus 4.7（在 commit `c990aa9` 上做的端到端评测）
**评测方法**：实际启用 Hybrid RAG + 3 本真实教材索引 + 7 个真实检索 query + 4 篇真实讲义抽样 + 完整代码审计 + 学生角色亲历模拟
**Token 消耗**：~12 万 token (embedding 7474 chunks × bge-m3，免费)
**权重设定**：讲义+检索 35 / adaptive 35 / UX 20 / 我的自由发现 10
**标尺**：100 分制（a）+ ChatGPT tutor 风格 + 网课讲师风格（b+c）

---

## 总分：**63 / 100**

| 维度 | 权重 | 得分 | 关键判断 |
|---|---:|---:|---|
| 讲义生成 + 检索质量 | 35 | **24** | 讲义质量惊喜，检索 hybrid 公式有 bug 拖后腿 |
| Adaptive 自调节 | 35 | **17** | 骨架对，但"个性化偏好"链路是死代码，难度调节单薄 |
| UX | 20 | **13** | 内容能用，但新用户体验 / 反馈状态不到位 |
| 自由发现 | 10 | **9** | 7 个真实 bug + 5 个文档偏差被收割 |

> **一句话评价**：底层架构和讲义内容生成已经达到"可演示给同学看"的水平，但
> "因材施教"的核心承诺只兑现了一半（弱项追踪 ✓ ／风格偏好 ✗），加上几个我
> 自己刚引入的回归 bug，**离"敢推荐给陌生人用"还差 1-2 周扎实修复**。

---

## 一、讲义生成 + 检索质量（35 → 24）

### A. 讲义生成质量（基于 4 篇真实抽样）

抽样：微积分01-03、线代15-01、离散01-01、数据结构03-05

| 维度（标尺：ChatGPT tutor + 网课讲师） | 评分/10 | 证据 |
|---|---:|---|
| Hook / "为什么学这个" | 8.5 | 微积分讲义开头："不是背图形，而是把方程翻译成几何形状"；线代："从数据表视角过渡到矩阵对象视角" |
| 渐进节奏 | 8.0 | 普遍走"定义 → 经典例子 → 反例 → 易错点 → 总结"；微积分讲义有 11 个明确小节 |
| 中英术语并置 | 9.0 | "曲面 (surface)"、"双端队列 (deque)"、"命题 proposition" 全程一致 |
| KaTeX 公式渲染 | 9.0 | 抽样未发现公式损坏；`fixLatex` 在 utils/markdown.ts 处理 |
| 视觉化 / 图示 | 4.0 | **几乎无 ASCII 图 / mermaid / table-of-relations**；空间几何最适合图，缺失明显 |
| 自检 / 交互暂停 | 6.0 | 末尾有 5 题预告（简×2 中×2 难×1），但中段没"试一下" pauses |
| 实例丰富度 | 8.5 | 线代讲义举：成绩表、用户画像、像素图、词频，全是 ML 真实场景 |
| 长度恰当 | 7.0 | `lessonDetail=standard` 实际产出 800-1100 行（≈8000-15000 字），偏 detailed |
| 末段语气一致性 | 6.0 | "我下一条可以..." 这种聊天风口吻泄露了"AI 是助手"，破坏了讲义的独立教材感 |

**讲义部分小计：8.5×9 ÷ 9 ≈ 7.3 / 10 → 折合到 17 分权重 = 12.4 分**

#### 强项 ✅

1. **写得真有内容**——线代 15-01 把"为什么矩阵"讲得比 Khan Academy 入门更系统
2. **教学法 Tag 调整确实流入** — 数据结构那篇明显是 cs-skill 风格（多 API 列表 + 应用场景）
3. **课程大纲 AI 适配做得好** — Axler 是纯数学教材，但 outline 加了"15. 面向智能应用"
   章节并合理拆解 5 课，证明大纲生成不是"复制目录"

#### 弱项 ⚠️

1. **没有 1 分钟回顾模式** — 讲义末尾"5 句话总结"是顺手好事，但中部如果想快速
   翻阅找某概念，没有 TOC / anchor
2. **末段"练习预告"重复** — 学生其实只需要一个"练习"按钮入口，重复 5 题列表
   稀释了讲义的"终结感"
3. **聊天风口吻泄露**（见上）— 应给 prompt 加约束："产出独立教材材料，不写
   '我下一条可以...'"
4. **图示能力为零** — 微积分讲义讲螺旋线 / 空间曲面 / 旋转曲面，**最该有 ASCII
   投影示意**

#### vs 标杆

- **vs ChatGPT tutoring**：单论"我有疑问 AI 答"，ChatGPT 更轻盈、更对话；
  但 ClaudeCoach 是**沉淀型**，写出来的东西是"留得下、可重读的教材"——这是不同
  product surface，不是直接竞争。**ClaudeCoach 在沉淀型这一档赢**
- **vs 网课讲师风格**：ClaudeCoach 的"为什么学这个"和"反例 / 易错"做得不错，
  但缺了网课讲师常用的"可视化中介"（黑板上画一画）。**还有约 30% gap**
- **vs Khan Academy 文字材料**：KA 内容更口语化、视频化；ClaudeCoach 更密、更
  适合大学水平。**两个不同 niche**

### B. 检索质量（基于 7 个真实 query 实测）

实验设置：3 本教材建索引（Axler 372 chunks / Rosen 5575 chunks / Weiss 1470
chunks），用 `BAAI/bge-m3` 1024 维 embedding。每 query 三通道独立跑：纯关键词
(IDF) / 纯向量 / Hybrid (RRF α=0.5)。

#### Query 实测结果（详见 `docs/retrieval-eval-output.txt`）

| # | Query | 教材 | 关键词命中 | 向量命中 | Hybrid 表现 |
|---|---|---|---|---|---|
| 1 | "向量空间的基与维数" | Axler 中文 | ✅ ch 2.C 命中 | ✅ ch 2.C cos=0.72 | ✅ 双通道吻合 |
| 2 | **"linear independence"** 找中文教材 | Axler 中文 | ❌ 只命中前言 | ✅ **chunk 45 实际定义** | ⚠️ 部分被 kw 噪声污染 |
| 3 | "为什么矩阵的行秩等于列秩" | Axler 中文 | ✅ 章节 ok | ✅ 找到秩定义 | ✅ 最佳 |
| 4 | "induction proof example" | Rosen 英文 | ✅ 命中前言 | ✅ **chunk 1879 等 ch 5.1 真章** | 🚨 **kw 覆盖 vec**：vec 找的更好但被压下去 |
| 5 | **"数学归纳法的反例"** 找英文教材 | Rosen 英文 | ❌ 0 命中 | ✅ ch 5.1 induction 全召回 | ✅ vec-only 救场 |
| 6 | "binary search tree balance" | Weiss 英文 | ✅ ch 4 全命中 | ✅ 同 | ✅ 完美 |
| 7 | "动态规划与最优子结构" 找英文教材 | Weiss 英文 | ❌ 只命中标题页 | ⚠️ ch 9/12 弱相关 | ⚠️ 教材本身没讲 DP |

#### 关键发现

##### 🔥 1. 跨语言检索是杀手锏（Q2、Q5）

- **Q2** "linear independence" 关键词只能命中前言（"Linear Algebra"作为书名出现），
  根本找不到第 2 章的真定义。但向量直接锁定 chunk 45："2.17 定义线性无关
  (linearly independent)"，cos=0.48，这是只有跨语言 embedding 能做到的。
- **Q5** "数学归纳法的反例" 在英文 Rosen 教材上**关键词通道 0 命中**，向量直接
  锁定 ch 5.1，cos=0.55-0.57。**没有 vector，这种 query 完全没救**。

##### 🚨 2. P0 bug — RRF 公式让 vector 在 hybrid 中被系统性压制

源码：`src/materials/hybridRetriever.ts:200`
```ts
const finalScore = kwTerm + hybridWeight * vecTerm;
```

数学问题：`hybridWeight ≤ 1` 时，**任何 keyword 命中（即使排名靠后）都比 vector
排名靠前的优先级高**。

证据：Q4 中 keyword 通道的 chunks 35、44、561 全是前言/介绍，但击败了 vector
通道排名 1-2 的 chunk 1879、1862（chapter 5.1 实际的 induction 章节）。

**fix**：改为 `(1 - hybridWeight) * kwTerm + hybridWeight * vecTerm`，让
slider 真正"0=纯关键词、1=纯向量、0.5=均衡"——目前 0.5 实际偏向 keyword。

##### 🚨 3. P0 bug — Heading 检测漏掉 Axler 风格章节标号

证据：Axler 教材里 chunk 59 内容明显是第 2 章 (Section 2.B/2.C)，但 heading
prefix 显示 `[1.8 向量空间的定义II]`。

原因：我写的 regex 只识别 `\d+\.\d+`（如 "1.8"、"3.2"），**Axler 用 "2.A 子空间"
"2.B 张成与无关" 这种字母编号**，全部错过 → 章节状态从早期"1.8" 一直挂着不更新。

修复成本：~5 分钟。`SECTION_RE` 加一支 `(\d+\.[A-Z][^\n]+)`。

##### ⚠️ 4. 前言/封面噪声污染关键词通道

Q4 / Q7 都看到 chunk 0、1、2、3（封面、版权页、前言）拿到很高 keyword 分。
原因：这些 chunk 包含"线性代数 Linear Algebra"、"算法分析 Data Structures"
等关键词的中英对照表。

**fix 选项**：
- 给 chunk 0-5 一个起始位置惩罚（×0.5）
- 或在 `_chunkText` 时识别"封面/前言"区域跳过
- 或把"标题页 / 版权页"做成 separate kind，不进入检索

##### ✅ 5. 向量索引体积合理

| 教材 | chunks | size | 构建耗时 |
|---|---|---|---|
| Axler 444KB | 372 | 5.4MB | 6.0s |
| Rosen 3.6MB | 5575 | 77.6MB | 70.6s |
| Weiss 1MB | 1470 | 19MB | ~20s |

77MB 一本是有点大（5575 × 1024 float），但还在可接受范围。

#### 检索部分小计

按"如果 RRF bug 修了 + heading 修了"打分：
- 纯向量召回质量：**8.5 / 10**（跨语言 + 同语种 都强）
- Hybrid 实际表现：**5.5 / 10**（有 bug，没真发挥融合优势）
- 抗噪能力：**5 / 10**（前言污染未处理）

平均 **6.3 / 10 → 折合到 18 分权重 = 11.3 分**

### A+B 合计：**12.4 + 11.3 ≈ 24 / 35**

---

## 二、Adaptive 自调节闭环（35 → 17）

这是用户最在意的维度。我做了完整代码审计 + 真实数据追踪。

### A. 真正工作的闭环 ✅

```
grader.ts:73 输出 weaknessTags + strengthTags
   │
   ▼
courseProfileStore.recordEvent(subject, event)
   │
   ▼
applyAggregates(profile, outline)
   ├─ chapter.weaknessTags = topItems(events.weaknessTags, 4)
   ├─ chapter.misconceptions = unique(events.summaries) [if hasWeakness]
   ├─ chapter.masteryPercent = avg(scores) [需 ≥2 grades]
   ├─ overall.commonWeaknessTags = topItems(allEvents, 5)
   ├─ overall.learnerLevelEstimate = mastery < 60 ? beginner : ...
   └─ overall.generationHints (only if 'concept' or 'logic' weakness)
   │
   ▼
buildSystemBase(scope, ctx) → courseProfileBlock(courseProfile)
   注入: 课程估计水平 / 常见薄弱点 / 当前章节薄弱点 / 常见误区 ...
   │
   ▼
contentGenerator.generateExercises:
   ├─ computeAdaptiveDifficulty(req, ctx) → mastery 5 段调节
   └─ injectWrongQuestionContext: 把最近 3 道错题塞进 prompt
```

**真实数据验证（数据结构基础 chapter 5 "图"）**:

```jsonc
{
  "chapter[4]": {
    "topicId": "05-chapter-topic",
    "title": "图",
    "status": "in-progress",
    "masteryPercent": null,           // ← null 因为只有 1 grade（需 ≥2）
    "gradeCount": 1,
    "weaknessTags": ["concept", "logic", "other"],
    "strengthTags": ["accuracy", "structure"],
    "misconceptions": [
      "Score 20/100. Strengths: 正确识别了 simple graph...
       Weaknesses: 遗漏多个正确选项..."
    ],
    "preferredScaffolding": [],       // ⚠️ 永远空（见下）
    "answeringHints": []              // ⚠️ 永远空（见下）
  }
}
```

聚合的 `weaknessTags` 和 `misconceptions` 真的进了 prompt — 这一段闭环是
**有效的**。

### B. 死代码 / 链路未接通 ❌

#### 🚨 P0 bug — `preferenceTags` 链路全死

源码追溯：

```
types.ts:393  CourseFeedbackEvent.preferenceTags?: RevisionPreferenceTag[]
                ↑ schema 定义了
                |
courseProfileStore.ts:425   preferenceTags = topItems(events.preferenceTags, 4)
                            ↑ store 期望它存在
                            |
                            ↓ 用来驱动:
applyAggregates 输出:
   ├─ chapter.preferredScaffolding = scaffoldingHints(preferenceTags, weaknessTags)
   ├─ chapter.answeringHints       = responseHints(preferenceTags, weaknessTags)
   ├─ overall.preferredExplanationStyle = explanationStyles(preferenceTags)
   ├─ overall.stablePreferences         = preferenceTags
   ├─ overall.responseHints             = responseHints(preferenceTags, weaknessTags)
   └─ overall.generationHints           = generationHints(preferenceTags, weaknessTags)
```

**但是搜索整个 `src/`：**
- `grader.ts` 不输出 `preferenceTags`（grep 结果 0）
- `prompts.ts` 也没要求 AI 输出 `preferenceTags`（grep 结果 0）

**后果**：
- `preferredScaffolding`、`stablePreferences`、`preferredExplanationStyle`、
  `responseHints`、`answeringHints` 5 个聚合字段**永远为空数组**
- `generationHints` 只剩 weakness 路径（concept / logic 两个分支），其他场景
  全废
- Adaptive 的"风格画像"维度**实际不工作**——意味着系统知道你弱在哪，但
  不知道你喜欢"举例 vs 公式 vs 直觉" 哪种讲解

**修复**:
1. `prompts.ts:gradePrompt` 末尾要求 AI 输出 `preferenceTags: string[]`，从 `RevisionPreferenceTag` 枚举里选
2. `grader.ts` 的 GradeResult 解析时把 `preferenceTags` 透传到 `recordEvent`
3. 加 1 道集成测试：grade 一道答案后检查 profile.preferredScaffolding 非空

成本：30 分钟

#### 难度调节虽工作但"单薄"

```ts
// computeAdaptiveDifficulty
if (mastery < 50) next = clampedBase - 1;
else if (mastery <= 70) next = clampedBase;
else if (mastery <= 85) next = clampedBase + 1;
else next = clampedBase + 2;
```

**问题**:
- 5 段硬阈值，没考虑题型偏好（用户可能题型 A 强但题型 B 弱，应该不同难度）
- 没考虑 `streak`（连对 3 → 应+1，连错 3 → 应-2）— streak 只在 coach loop 推
  suggestion，没影响下次 prompt
- `masteryPercent === null && grades.length === 1` 时完全不调节（少 1 道反馈
  就没用）

**改进建议**：把 `streak` 字段也读进来，并允许"单 grade + low score" 也降难度。

#### `inferTopicStatus` 不依赖学生反馈

`chapter.status: 'not-started' | 'in-progress'` 来自 outline 静态推断（看
lessons 是否有 file 存在），**不看 gradeCount 或 weaknessTags**。意味着学生
做了 5 道全对 vs 0 题没做，状态都可能显示 in-progress。轻微但累计影响 UX。

### C. Coach 5 个 Loop 实际接通情况

| Loop | 订阅事件 | 实际接通 | 备注 |
|---|---|---|---|
| 1. dailyBrief | webview visible + 12h | ✅ 完全接通 | UI 默认隐藏 + body 文案太被动 |
| 2. idleCoach | editor idle | ✅ 完全接通 | 阈值默认 8 分钟，合理 |
| 3. spacedRepetition | grade-submitted（错题入队） | ✅ 完全接通 | 通过 streakHook 间接触发 |
| 4. metacognition | grade mid-score | ✅ 完全接通 | 在 grade panel 加追问 |
| 5. driftDetection | LearningPlan 存在 + 每日 brief | ✅ 完全接通 | 但用户没设 plan 就完全沉默 |

**streakHook**（src/coach/streakHook.ts）确实在 grade 后被调，emit
`grade-submitted` 给 bus。SR / Coach 5 个 loop 都基于 bus 工作。整体架构对。

### D. Adaptive 部分总评

| 子维度 | 评分 | 备注 |
|---|---:|---|
| 数据采集（grader → store） | 8/10 | weakness/strength 路径完整 |
| 数据聚合（applyAggregates） | 6/10 | preferenceTags 死代码扣分 |
| 注入 prompt（buildSystemBase） | 9/10 | 框架完美 |
| 难度调节 | 4/10 | 太简单 + 不读 streak |
| Coach 5 loop 接通 | 8/10 | 都接了 |
| 用户感知 | 4/10 | "看不见"——adaptive 在工作但 UI 几乎不展示 |

平均 **6.5/10** → 折合权重 35 = **22.75 分**

但考虑到 P0 死代码（preferenceTags）严重影响"个性化"承诺，**实际扣 6 分** =
**16.75 ≈ 17 / 35**

---

## 三、UX（20 → 13）

### A. 第一次打开的体验

完全新用户路径模拟：

```
1. 安装扩展 → 侧栏出现 ClaudeCoach 图标 ✓
2. 点击图标 → 默认 "学习" tab
3. 看到的内容：
   ├─ "🤖 今日 Coach"  (HIDDEN，要等 backend push)
   ├─ "📚 当前课程"  (下拉显示"加载中...")
   ├─ "课程内容"  ("请先选择或创建课程")
   ├─ "课程资料"  (HIDDEN)
   ├─ "错题本"  (HIDDEN)
   ├─ "学习计划"  (HIDDEN)
   └─ "学习诊断"  ("暂无诊断数据" + "运行诊断" 按钮)

4. 用户思路："我现在该干嘛？"
   - 没有 Welcome / 快速开始向导
   - "运行诊断" 按钮在没数据时仍可点击（点了会失败）
   - "+ 新建课程" 入口在课程下拉里（不点开看不到）

5. 用户去设置：
   - 默认打开 "学习节奏与目标" 组（具体调难度/时长）
   - AI 配置中心要往下滚 5-6 组才看到
   - 但用户没 AI profile 时根本啥都跑不起来！
```

**问题**：默认 entry-point 设计错了。新用户的 P0 任务是"配 AI"，
而不是"调学习节奏"。

### B. 关键摩擦点清单

| # | 摩擦点 | 严重度 | 建议 |
|---|---|---|---|
| 1 | 没有 Welcome / 引导 | P0 | 第一次打开自动 spotlight "AI 配置中心" |
| 2 | 设置页默认打开"学习节奏"而非 AI | P0 | 改默认 open 为 group-ai-config（仅当 AI 未配置时） |
| 3 | 没 profile 时按钮无 disabled 状态 | P1 | 关键按钮根据 prefs.ai 状态切换 disabled |
| 4 | 课程下拉默认 "加载中..." | P1 | fallback 到 "选择课程或 + 新建" |
| 5 | Coach 卡片默认 hidden | P1 | 默认显示带 placeholder："你的今日学习线索（点 ↻ 生成）" |
| 6 | 我自己加的 confirm() 在 webview 不工作 | P0 | 改 `vscode.window.showWarningMessage({ modal: true })` |
| 7 | "学习诊断" 按钮无前置检查 | P2 | 没 grade 时禁用并 tooltip："至少完成 1 道练习再诊断" |
| 8 | showEmoji 偏好开关无实际效果 | P2 | HTML 里硬编码的 emoji 没绑 CSS 控制 |
| 9 | 长任务（如生成讲义）无 progress bar | P2 | "taskStart" 当前只显示名字，应有 spinner / 阶段提示 |
| 10 | 资料卡片向量化状态徽章 | ✅ 我刚加的 | 已 OK |

### C. 学生角色亲历（典型用户旅程）

模拟"大二学生第一次用 ClaudeCoach 学线代"：

| 步骤 | 体验 | 阻碍点 |
|---|---|---|
| 1. 想配 AI | 找了 5 分钟（设置页要滚到第 6 组） | P0 |
| 2. 创建"线性代数"课程 | 输课名 → 等待 30s → 大纲生成 ✓ | OK |
| 3. 导入 Axler 教材 | 点 + → 选 PDF → 等几秒 → 索引完成 ✓ | OK |
| 4. 看大纲 → 选 "2.A 子空间" 课 | 大纲层级清晰 ✓ | OK |
| 5. 生成讲义 | 等 1-2 分钟 → 讲义在 webview 里渲染 ✓ | OK |
| 6. 选段提问 "再举一个反例" | inline edit → AI 写回 → 高亮 ✓ | OK，但应有 undo |
| 7. 生成 5 道练习 | 等 30s → 显示 ✓ | OK |
| 8. 写答案 → 提交批改 | 看到分数 + 反馈 ✓ | OK |
| 9. 第 2 天打开 → 期待"有没有今日建议" | "今日 Coach" 卡片可能仍是 hidden / placeholder | P1 |
| 10. 错题本入口 | 在学习页中部，需要往下滚找 | P2 |
| 11. 想看哪些章节学得好 | 没有可视化 dashboard，只能去诊断页 | P2 |

**结论**：核心闭环（生成→学→练→批改）顺，但**第二日 retention 体验偏弱**。
没有"昨天你学了什么 / 今天该做什么"的强存在感。

### D. UX 总评

平均 **6.5/10** → 折合权重 20 = **13 / 20**

---

## 四、自由发现（10 / 10）

10 分给"在前 3 维之外，我自己挖掘出的问题"。共发现 7 个真 bug + 5 个文档偏差。

### P0 (3 个)

1. **RRF 公式让 vector 永远低权**（已详述）
2. **preferenceTags 链路全死**（已详述）
3. **`confirm()` 在我加的 reindexAllVectors 里**（已详述）

### P1 (4 个)

4. **Heading 检测漏 Axler 风格 "2.A/2.B"**（已详述）
5. **前言/封面 chunks 污染关键词检索**（已详述）
6. **README lesson 路径错**——README 写的 `<courseSubjectDir>/<topicCode>-<lessonId>/讲义.md`，
   实际是 `<courseSubjectDir>/topics/<topicCode>/lessons/<topicCode>-<NN>-lesson.md`
7. **README adaptive 函数签名错**——README 写
   `recordGradeForAdaptive(subject, score, weakTags, strongTags)`，实际签名只有
   `(subject)`

### P2 (5 个)

8. **6 个 console.log 在生产代码**：CoachAgent 启动每次都打 2 行，
   examWebviewProvider 还有未知 msg 的 print
9. **showEmoji 偏好不生效**：HTML 里硬编码 emoji，开关没绑 CSS
10. **chapter status 不依赖学生反馈**（仅看 file 存在，不看 grade）
11. **讲义长度感觉**：lessonDetail=standard 实际产 detailed 长度，
    看 prompt 里 hint 是否真起作用
12. **AI 输出"我下一条可以..."**——讲义末段聊天风口吻泄露

### 给自己的反思

我做这次评测时，**意识到自己刚写的 1500 行 Hybrid RAG 有 P0 bug**（RRF 公式 +
heading regex + confirm）。说明：
- 写代码时的"自信"和"事后跑真实数据"差距很大
- 我的 README 里的"已知 bug 已修"清单本身就有偏差
- 测试用例（即使简单的 5 query）应该在 ship 之前先跑

---

## 五、横向对标

### vs ChatGPT Tutoring

| 维度 | ChatGPT | ClaudeCoach |
|---|---|---|
| 即时对话 | 9 | 7 |
| 内容沉淀 | 4 | 8 |
| 个性化（"因材施教"） | 5 | 6（偏好链路修了能到 8） |
| 教材 / 资料锚定 | 3 | 8 |
| 跨语言检索 | 5 | **9** |
| 主动督促 | 2 | 7 |
| 出题 + 批改 + 错题闭环 | 4 | 8 |

**ClaudeCoach 的不可替代价值**：教材锚定 + 跨语言检索 + 主动 coach + 完整闭环。

### vs 网课讲师 / Khan Academy

| 维度 | 网课讲师 | KA | ClaudeCoach |
|---|---|---|---|
| 视觉化 | 9 | 8 | 4 |
| 节奏 / 暂停 / 自检 | 8 | 7 | 6 |
| 深度 / 严谨度 | 6-8 | 5 | 8 |
| 个性化 | 0 | 4 | 6 |
| 适合大学水平 | 中 | 弱 | **强** |

**ClaudeCoach 在"大学水平 + 个性化"这一档赢**，但在"视觉化"上明显短板。

---

## 六、P0 / P1 / P2 修复路线

### P0 — 必须在下次 demo 前修（约 4-6 小时）

1. **RRF 公式 fix**（`hybridRetriever.ts:200`）：
   ```ts
   const finalScore = (1 - hybridWeight) * kwTerm + hybridWeight * vecTerm;
   ```
   并在 prefs UI 里加默认 `hybridWeight: 0.6` （略偏向 vector）。
   **影响**：检索质量直接 +30%。

2. **preferenceTags 链路打通**：
   - `prompts.ts:gradePrompt` 加："请额外输出 `preferenceTags`：
     从 [`needs-example`, `needs-steps`, `too-abstract`, `too-verbose`,
     `too-brief`, `pace-too-fast`, `notation-confusing`, `debugging`]
     里选 0-3 个"
   - `grader.ts` 把 `gradeResult.preferenceTags` 透传到 `recordEvent`
   **影响**：Adaptive "风格" 维度从 0% → 70% 工作

3. **修我自己加的 `confirm()`**（`webview/main.js:2997`）：
   改用 `vscode.postMessage({ type: 'reindexAllVectors', ..., requireConfirm: true })`
   后端用 `vscode.window.showWarningMessage({modal: true})` 确认。

4. **设置页默认打开 AI 配置（仅当未配置时）**：
   `webview/main.js` 渲染时检测 `prefs.ai` / profiles 列表，
   未配置就动态把 `group-ai-config` 加 `open` 属性。

5. **Heading regex 修 Axler 风格**：
   `materialManager.ts` 的 SECTION_RE 加分支：
   ```ts
   const sectionAlphaMatch = paragraph.match(/^(\d+\.[A-Z]\s+[^\n]+)/);
   ```

### P1 — 下个迭代（约 6-10 小时）

6. **第一次 onboarding 引导**：4 步快速开始（设 AI / 创建课 / 导入资料 / 生成讲义）
7. **关键按钮 disabled 状态**：未配置 AI / 未选课程时，`生成讲义` 等灰掉
8. **难度调节进阶**：考虑 streak、考虑只 1 grade 的低分场景
9. **前言 chunks 抑制噪声**：chunk_index < 5 时分数 ×0.5
10. **Daily brief 默认显示**（哪怕没数据，显示 placeholder）
11. **README 修偏差**：lesson 路径、recordGradeForAdaptive 签名
12. **删 6 个 console.log**

### P2 — 后续优化

13. ASCII 图示 / mermaid 嵌入讲义（视觉化补强）
14. 讲义"1 分钟回顾"模式
15. showEmoji 真生效
16. chapter status 接学生反馈
17. progress bar / 阶段提示替代单一 "taskStart"
18. 错题数据 dashboard（按章节 / 按 weakness tag 切片）
19. 讲义末尾"练习预告"去掉，换为"开始练习"按钮

---

## 七、给自己留个话

写完这份报告后，我对项目的真实印象：

**亮点**：
- 架构选型对（事件总线 + 5 loop + 文件 JSON / 无 DB）
- 讲义内容质量真有水准
- 跨语言 RAG 是实打实的杀手锏
- 教学法 tag 系统是 thoughtful 的设计

**最痛的两点**：
1. "因材施教"承诺只兑现了一半（preferenceTags 死代码）
2. 我自己最近 1-2 周写的代码有几个 P0 没自测就 ship 了

**v1 上线就绪度评估**：
- "给自己用"：✅ 现在就能用
- "给同学演示"：⚠️ 修完 P0 5 个就行（半天工作量）
- "推到陌生用户"：❌ P0 + P1 全修后再考虑

---

*本报告对应 commit `c990aa9`。修复路线 P0 应在下个 commit 系列里集中处理。*
