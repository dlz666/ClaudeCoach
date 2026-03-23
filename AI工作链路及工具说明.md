# ClaudeCoach AI 工作链路及工具说明

## 1. AI 层在项目里的真实位置

ClaudeCoach 里的 AI 不是一个单独页面功能，而是整条学习工作流的底层能力层。

AI 参与的任务包括：

- 生成课程大纲
- 基于资料重构课程大纲
- 生成讲义
- 生成练习
- 批改答案
- 分析学习诊断
- 资料结构化摘要
- 日常问答
- 直接修改现有讲义文件

如果用模块化语言概括：

```text
模块族：AI Orchestration Layer
输入：学生画像、学习偏好、诊断结果、课程大纲、资料摘要、资料片段、用户消息
处理：Prompt 组装、模型调用、结果解析、文件写回
输出：课程文件、练习文件、批改结果、诊断报告、聊天回复、讲义修订
```

## 2. 核心 AI 模块清单

### 2.1 `AIProfileManager`

职责：

- 管理全局 AI Profiles
- 管理工作区级 AI 覆盖
- 导入 `.claude` / `.codex` / 配置包
- 导出配置包
- 解析当前生效配置
- 测试当前配置连通性

### 2.2 `AIClient`

职责：

- 统一封装模型调用
- 根据 provider 分流到 OpenAI 兼容接口或 Anthropic 接口
- 支持文本返回和 JSON 返回
- 做超时、重试、错误摘要

### 2.3 `prompts.ts`

职责：

- 定义所有任务的 Prompt 模板
- 把学习画像、偏好、诊断、课程、资料一起装入系统提示词
- 约束输出格式

### 2.4 `tokenBudget.ts`

职责：

- 估算 token
- 预留输出空间
- 在学习诊断场景下控制历史摘要与批改记录的装载量

### 2.5 任务执行模块

它们分别使用 AIClient + Prompt：

- `ContentGenerator`
- `Grader`
- `MaterialManager`
- `AdaptiveEngine`
- `SidebarProvider` 中的聊天与讲义修改链路

## 3. 当前支持的模型与路由方式

### 3.1 Provider 分流

当前支持：

- `openai`
- `anthropic`

路由规则：

```pseudo
chatCompletion(messages):
  config = resolveConfig()
  if provider == "anthropic":
    call anthropic /v1/messages
  else:
    call openai-compatible /chat/completions
```

### 3.2 OpenAI 兼容接口链路

请求目标：

```text
{baseUrl}/chat/completions
```

请求体关键字段：

- `model`
- `messages`
- `temperature`
- `max_tokens`

### 3.3 Anthropic 链路

请求目标：

```text
{anthropicBaseUrl}/v1/messages
```

当前实现里有一个重要细节：

- 系统消息会被转成 `user` 角色一起发出

这属于兼容型适配，而不是 Anthropic 原生最细粒度的 system 用法。

## 4. Prompt 上下文是怎么组装的

所有任务 Prompt 都建立在同一个系统上下文构造器 `buildSystemBase(ctx)` 上。

它会尽量注入下面这些信息：

- 学生画像 `profile`
- 学习偏好 `preferences`
- 最新学习诊断 `diagnosis`
- 当前课程标题
- 当前课程大纲摘要
- 当前锁定资料标题
- 资料摘要
- 与当前问题最相关的资料片段

另外，还会注入数学公式格式规则，强约束模型输出可写回 Markdown 的公式格式。

伪代码：

```pseudo
buildSystemBase(ctx):
  sys = "你是一位大学老师"
  sys += profileContext(ctx.profile)
  sys += preferencesContext(ctx.preferences)
  sys += diagnosisContext(ctx.diagnosis)

  if ctx.currentCourseTitle:
    sys += currentCourseTitle
  if ctx.courseOutlineSummary:
    sys += courseOutlineSummary
  if ctx.selectedMaterialTitle:
    sys += selectedMaterialTitle
  if ctx.materialSummary:
    sys += materialSummary
  if ctx.retrievedExcerpts:
    sys += retrievedExcerpts
    sys += "不要说你看不到资料库"

  sys += mathFormattingRules
  return sys
```

这说明项目的 AI 设计不是“单轮裸问答”，而是“上下文工程 + 任务模板”。

## 5. 各条 AI 工作链路

### 5.1 课程大纲生成链路

入口：

- 学习页点击“生成课程大纲”

调用链：

```text
Webview
  -> SidebarProvider.generateCourse
  -> PreferencesStore / AdaptiveEngine / ProgressStore
  -> MaterialManager.getRelevantSummary
  -> ContentGenerator.generateCourse
  -> courseOutlinePrompt
  -> AIClient.chatJson
  -> CourseManager.saveCourseOutline
```

输出：

- `outline.json`
- `summary.md`

伪代码：

```pseudo
generateCourse(subject):
  prefs = loadPreferences()
  diag = loadDiagnosis(subject)
  profile = loadStudentProfile()
  materialSummary = getRelevantSummary(subject, "")

  messages = courseOutlinePrompt(subject, ctx)
  outlineJson = ai.chatJson(messages)
  normalizedOutline = persistOutline(outlineJson)
  return normalizedOutline
```

### 5.2 基于资料重构课程大纲链路

入口：

- 对话页按钮“基于资料重构当前大纲”

额外特征：

- 不只看原课程大纲
- 还会检索资料摘要和命中的资料片段

这是当前项目里最接近“课程知识库驱动重排”的一条链路。

### 5.3 讲义生成链路

入口：

- 课程树里点击“讲义”

调用链：

```text
课程标题 + topicTitle + lessonTitle
  -> buildSubjectGrounding()
  -> lessonPrompt()
  -> AIClient.chatCompletion()
  -> writeMarkdownAndPreview()
```

讲义 Prompt 会要求模型输出：

- 关键概念摘要
- 循序渐进讲解
- 例题与解析
- 练习预告

### 5.4 练习生成链路

入口：

- 课程树“更多操作 -> 练习”

调用链：

```text
SidebarProvider
  -> buildSubjectGrounding()
  -> ContentGenerator.generateExercises()
  -> exercisePrompt()
  -> AIClient.chatJson()
  -> 写 prompt.md + prompt.json
```

特点：

- 练习是结构化 JSON 先生成，再渲染成 Markdown
- 每道题会带 `type` 与 `difficulty`
- 最后会同步更新课时状态

### 5.5 批改链路

批改逻辑存在两套入口。

第一套：

- `Grader.grade()`，用于显式批改请求

第二套：

- `ExerciseScanner.scanAndGradeAll()`，用于扫描练习 Markdown 中已经写好的答案再批改

当前项目里的一个实际情况是：

```text
批改后端能力已实现；
但 Webview 主界面里没有直接的“答案输入并提交批改”入口；
自动扫描批改也没有明显前端入口。
```

也就是说，批改引擎是真实存在的，但当前交互层还没有完整暴露。

批改伪代码：

```pseudo
grade(exercise, answer):
  messages = gradePrompt(exercise.prompt, answer, ctx)
  result = ai.chatJson(messages)
  write grade.json
  write feedback.md
  updateTopicSummary(score, weaknesses)
```

### 5.6 学习诊断链路

入口：

- 学习页点击“运行诊断”

调用链：

```text
AdaptiveEngine.runDiagnosis(subject)
  -> syncLessonStatuses()
  -> collectSummaries()
  -> collectRecentGrades()
  -> createBudget()
  -> selectHistoryForPrompt()
  -> diagnosisPrompt()
  -> AIClient.chatJson()
  -> write latest.json / history / diagnosis-report.md
```

这里的 AI 不是直接读完整历史，而是先做 token 预算裁剪。

伪代码：

```pseudo
runDiagnosis(subject):
  summaries = collectTopicSummaries(subject)
  grades = collectRecentGrades(subject)
  budget = createBudget(contextWindow, fixedPromptText)
  compactHistory = selectHistoryForPrompt(budget, summaries, grades)
  diagnosis = ai.chatJson(diagnosisPrompt(compactHistory))
  archivePreviousDiagnosis()
  saveLatestDiagnosis()
  writeReadableMarkdownReport()
```

### 5.7 资料索引链路

入口：

- 导入资料

调用链：

```text
MaterialManager.importMaterial()
  -> copy source file
  -> extractTextFromFile()
  -> materialIndexPrompt()
  -> AIClient.chatJson()
  -> write summary.json
```

它的目标不是简单保存 PDF，而是把资料转成后续可复用的结构化知识。

### 5.8 AI 问答链路

入口：

- 对话页发送消息

上下文决策逻辑：

- `general`：不注入课程和资料
- `course`：注入当前课程 + 资料摘要 + 检索片段
- `material`：在 course 模式基础上进一步锁定到某份资料

伪代码：

```pseudo
chat(message, subject, mode, materialId):
  if mode == general:
    grounding = {}
  else:
    grounding = buildChatGrounding(message, subject, mode, materialId)

  messages = chatPrompt(message, chatHistory, grounding + profile + prefs + diagnosis)
  reply = ai.chatCompletion(messages)
  appendHistory(user, assistant)
```

### 5.9 聊天式讲义修改链路

这是项目里很有特色的一条链路。

如果系统识别到用户消息像是在“修改讲义”，就不走普通问答，而走“定位文件 -> AI 改文件 -> 写回磁盘”的链路。

识别方式：

- 消息中包含“修改 / 重写 / 补充 / 精简 / 润色 / 合并 / 删除”等词
- 当前有课程上下文，或用户最近打开过某一节讲义

工作步骤：

1. 根据消息匹配目标课时
2. 确认讲义文件存在
3. 读取当前 Markdown
4. 如果文档很长且章节较多，进入 patch 模式
5. 否则进入 full rewrite 模式
6. AI 返回修订结果
7. 写回 Markdown 并打开预览

伪代码：

```pseudo
reviseLectureViaChat(userMessage):
  target = resolveChatEditTarget(userMessage)
  current = readMarkdown(target.filePath)
  sections = parseMarkdownSections(current)

  if sections > 1 and current.length > 8000:
    patch = ai.chatCompletion(reviseMarkdownPatchPrompt(...))
    revised = applyMarkdownPatch(current, patch)
  else:
    revised = ai.chatCompletion(reviseMarkdownPrompt(...))

  if revised changed:
    writeMarkdownAndPreview(target.filePath, revised)
```

这条链路说明项目里的 AI 已经不只是“答复用户”，而是在做“受控文件编辑”。

## 6. 资料检索不是向量检索，而是关键词检索

当前资料 grounding 的检索策略是本地规则检索，不是 embedding 向量库。

流程如下：

1. 把资料切成若干文本块
2. 从问题里提取英文词、数字词、中文短语、中文 n-gram
3. 对每个 chunk 打分
4. 取 top N 片段注入 Prompt

伪代码：

```pseudo
retrieveRelevantExcerpts(query):
  keywords = extractSearchTerms(query)
  for chunk in allChunks:
    score = scoreChunk(chunk, query, keywords)
  return topChunksByScore()
```

这是一种轻量、低依赖、可离线运行的方案，但语义能力明显弱于向量检索。

## 7. Token 预算工具

诊断场景会用 `tokenBudget.ts` 做预算控制。

基本思路：

- 粗略估算 token
- 固定预留 4000 给输出
- 只拿 context window 的 60% 作为历史预算
- 先塞 topic summary
- 再塞 recent grades

模块语言：

```text
模块名：TokenBudget
输入：contextWindow, fixedPromptText, summaries, grades
处理：估算 token，裁剪历史
输出：summariesText, gradesText
```

## 8. AI 工具与外部依赖

### 8.1 模型调用工具

- `fetch`
- OpenAI 兼容 Chat Completions API
- Anthropic Messages API

### 8.2 资料处理工具

- `pdf-parse`：优先抽取 PDF 文本
- `pdftoppm`：Windows OCR 前的 PDF 转图片
- PowerShell Windows OCR 脚本：当 PDF 文本质量差时兜底

### 8.3 VS Code 工具

- `showOpenDialog`
- `showSaveDialog`
- `showQuickPick`
- `markdown.showPreview`
- `revealFileInOS`

### 8.4 本地格式处理工具

- `fixLatex()`：规范数学公式
- Markdown section parser：支持局部修订
- JSON read/write helpers

## 9. AI 配置能力与界面接线情况

从后端能力看，AI 配置已经支持：

- 多 Profile 管理
- 激活全局 Profile
- 工作区级覆盖
- 导入 `.claude`
- 导入 `.codex`
- 导入 / 导出 JSON 配置包
- 测试配置连通性

从前端接线情况看，当前 Webview 只展示了：

- 当前生效配置
- warning pills
- 历史预算

所以应该这样描述现状：

```text
AI 配置工具链后端已基本齐全；
AI 配置中心前端属于“展示完成、完整编辑流未接通”。
```

## 10. 当前 AI 链路的边界与不足

### 10.1 已知边界

- 资料检索是关键词规则检索，不是向量检索
- 聊天历史只保留最近 20 条
- 讲义大文档 patch 模式依赖模型输出 JSON 的稳定性
- Anthropic 路由是兼容型封装，不是最细粒度原生用法

### 10.2 当前代码中的“已实现但未完全暴露”能力

- `submitAnswer`
- `scanExercises`
- `reprocessAllMarkdown`
- AI Profile 增删改切换消息流

这些后端能力存在，但在当前主 Webview 里没有完整可见入口。

### 10.3 当前代码中的“命令面板预留但未闭环”

扩展注册了这类命令：

- `claudeCoach.generateCourse`
- `claudeCoach.generateLesson`
- `claudeCoach.generateExercises`
- `claudeCoach.gradeAnswer`
- `claudeCoach.showDiagnosis`
- `claudeCoach.importMaterial`

这些命令会向 Webview 发 `triggerGenerateCourse` 等消息。

但当前 `main.js` 没有处理这些 `trigger*` 消息。

因此从真实功能角度说：

```text
命令已注册；
宿主会发消息；
Webview 侧尚未消费这些触发消息；
所以命令面板闭环还没真正完成。
```

## 11. AI 链路总伪代码

```pseudo
UserAction
  -> Webview postMessage
  -> SidebarProvider route by msg.type
  -> load profile / preferences / diagnosis / course / materials
  -> build prompt context
  -> AIClient.callModel()
  -> parse text/json result
  -> write markdown/json files if needed
  -> postMessage result back to Webview
  -> Webview rerender / append chat / refresh course tree
```

## 12. 一句话总结

ClaudeCoach 的 AI 不是一个聊天外挂，而是一套把“课程结构、资料知识、学习记录、Prompt 工程、文件写回”串成闭环的本地学习编排系统。它已经具备了课程生成、资料 grounding、诊断和受控文档修改的能力，但资料检索、AI 配置中心和部分命令入口还处在可继续打磨的阶段。
