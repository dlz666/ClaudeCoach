# ClaudeCoach

> English docs: see [README.md](README.md)

一个住在 **VS Code** 里的个人 AI 学习助手。从你自己的教材生成课程、用 AI 渲染
的讲义自学、让视觉模型批改你拍照的手写答题、由"自动教练"按节奏推送复习与弱
点重练 —— 全部从一个侧边栏完成，所有数据留在本机。

由一名计算机本科生为自驱型、应试导向的学习场景打造。自备 API Key（Anthropic /
OpenAI 兼容 / Claude Code CLI 任选）。

---

## 它是什么

ClaudeCoach 把学习视作一个闭环：

1. **你给它素材** —— 一本教材 PDF、一份大纲，或者直接一句话目标。
2. **它生成课程** —— 根据你的基础与目标，自动出主题/讲义/练习的完整大纲。
3. **你看 AI 渲染的讲义** —— 内嵌公式、Mermaid/Graphviz 图、可交互 HTML widget、AI 联网搜的示意图，全都直接渲染在 markdown 里。
4. **你做练习** —— 打字或拍照手写答案，多模态模型批改并解释错因。
5. **错题反哺** —— 后续生成会针对你的弱点，难度自适应调整。

除了你自己配置的 AI 接口，没有任何数据离开本机。

---

## 主要特性

| 特性 | 你能得到的 |
|---|---|
| **课程生成器** | 从"我要在 X 时间内学完 Y"出发，自动产出主题/讲义/练习的完整大纲，支持迭代细化。 |
| **讲义阅读器** | 独立的渲染面板：KaTeX 公式、Mermaid、Graphviz/DOT、代码高亮、可交互 HTML widget、粘贴图片/视频链接直接嵌入。 |
| **行内编辑** | 在讲义里选中任意文字 → 让 AI 改写/扩写/简化/批注，一键应用 + `.bak` 一步撤回。 |
| **智能搜图** | 点一下 → 后台启动 `claude` CLI → 联网搜图返回真实 URL → 宿主下载并嵌入讲义。 |
| **混合 RAG** | 关键词（BM25）+ 向量 Embedding + 可选 Vision PDF 深度提取。Embedding 后端任何 OpenAI 兼容接口都行。 |
| **视觉批改** | 拍下你手写的答案 → 多模态模型批改、解释、自动记入错题本。 |
| **多 AI Profile** | 管理多套 (服务商, 模型, Token) 配置，一键从 `~/.codex/config.toml` 或 `~/.claude/settings.json` 导入；支持按 workspace 覆盖。 |
| **主动教练** | 一个调度器观察你的学习节奏，定时推送提醒、弱点回顾、自适应任务。 |
| **项目模式** | 一句话想法 → 自动生成结构化的项目规格（目标、里程碑、交付物）。 |

---

## 截图 & 演示

*待补充 —— 把截图丢到 `docs/screenshots/` 然后在这里引用。*

建议放这几张：

```
docs/screenshots/
  01-sidebar.png       (侧边栏概览)
  02-lecture.png       (讲义阅读器：公式 + 图)
  03-inline-edit.png   (行内编辑浮窗)
  04-search-image.png  (智能搜图)
  05-grading.png       (拍照手写批改结果)
```

---

## 快速开始

### 准备

- VS Code 1.85+
- Node.js 18+（从源码构建用）
- 以下三选一：
  - 任意 OpenAI 兼容服务的 API Key（OpenAI、DeepSeek、OpenRouter 等）
  - Anthropic API Key
  - 本机已安装并登录的 `claude` CLI（用你的 Claude 订阅额度，不消耗 API token）

### 从源码安装（开发模式）

```bash
git clone https://github.com/dlz666/ClaudeCoach.git
cd ClaudeCoach
npm install
npm run compile
```

然后在 VS Code 里：

1. 打开项目目录。
2. 按 **F5** → 弹出新的 **Extension Development Host** 窗口。
3. 在这个新窗口里点左侧活动栏的 **ClaudeCoach** 图标。
4. 进 **设置 → AI 与系统 → AI Profile**，新建第一份 Profile。
5. 切到 **学习** tab，创建第一门学科。

### 打包成 VSIX

```bash
npm run package
```

生成的 `claudecoach-*.vsix` 可以通过 **扩展 → ⋯ → 从 VSIX 安装** 装到普通 VS Code。

---

## 工作原理

ClaudeCoach 是一个自托管的 VS Code 扩展。**没有任何服务器** —— 所有课程内容、
练习、错题、设置都存在你的工作目录或 VS Code 扩展存储里。

AI 调用有三条路径，按 AI Profile 决定走哪条：

1. **OpenAI 兼容 HTTP** —— 任何支持 `/v1/chat/completions` 的服务。流式 SSE 已实现。
2. **Anthropic 原生** —— `/v1/messages`，直连 Claude。
3. **Claude Code CLI 子进程** —— 调本机 `claude` 命令、用你的 Claude 订阅额度（不烧 API token）。用于长时间运行的 "agent" 任务：智能搜图、项目脚手架生成、批量讲义打磨。

```
                ┌───────────────────────────────────┐
                │       VS Code 侧边栏（UI）         │
                │   课程 · 讲义 · 练习               │
                │   设置 · 日志 · 对话               │
                └───────────────┬───────────────────┘
                                │ webview 消息
                                ▼
┌─────────────────────────────────────────────────────────┐
│              扩展宿主（Node 进程）                       │
│  ┌────────┐  ┌────────┐  ┌──────────┐  ┌────────────┐   │
│  │AIClient│  │内容生成 │  │ 检索     │  │ 讲义阅读器  │   │
│  │HTTP /  │  │        │  │BM25 +    │  │ Webview    │   │
│  │CLI     │  │        │  │Vector    │  │ Provider   │   │
│  └───┬────┘  └───┬────┘  └────┬─────┘  └─────┬──────┘   │
└──────┼──────────┼────────────┼──────────────┼──────────┘
       ▼          ▼            ▼              ▼
   OpenAI /    本地 .md 文件   Embedding      讲义阅读面板
   Anthropic                  索引            （独立 webview）
   / CLI
```

---

## 配置

### AI Profile

ClaudeCoach 管理多套 AI Profile。每个 Profile 是一组
`(服务商, Base URL, 模型, Token, 上下文窗口, max tokens)`。你可以：

- **手动新建**
- **从 `~/.codex/config.toml` + `auth.json` 导入**
- **从 `~/.claude/settings.json` 导入**
- **按 workspace 覆盖** —— 不同项目用不同 Profile

配置入口：**侧边栏 → 设置 → AI 与系统 → AI Profile**。

### 学习偏好

**设置 → 学习** 下：

- **节奏** —— 每日讲义产出量
- **AI 风格** —— 讲解口吻（精炼 / 详细 / 苏格拉底式）
- **讲义** —— 渲染偏好（数学密度、代码优先 vs 文本优先）
- **检索** —— RAG 严格度、top-K、是否引用来源

### 混合 RAG

三个引擎，独立开关：

| 引擎 | 干什么 | 什么时候开 |
|---|---|---|
| **Grounding（关键词）** | 对导入的 markdown/PDF 文本做 BM25 风格关键词检索。轻量稳定。 | 默认开。 |
| **Vector（向量）** | 混合检索 —— 关键词 + Embedding ANN。需要 Embedding 服务端点。 | 资料超过几百页之后建议开。 |
| **Vision PDF** | 把扫描版 PDF 页发给视觉模型做深度 OCR + 图表抽取。 | 纯文本提取效果差（数学教材、扫描课件）时开。 |

Embedding / Vision 服务在 **设置 → 学习 → 检索** 配置。

---

## 数据布局

用户内容都在工作目录下的 `.claudecoach/`：

```
.claudecoach/
  subjects/
    <学科 slug>/
      course.json                  # 大纲 + 元数据
      topics/
        <章节 slug>/
          lessons/
            <讲义 id>.md           # 渲染好的讲义（markdown）
            <讲义 id>.md.bak       # 一步撤回缓冲
            assets/                # 粘贴 / 搜来的图片
          exercises/
            <练习 id>.md           # 题目 + 你的答案
            <练习 id>.json         # 批改结果
      wrong-questions.json
  materials/                       # 你导入的参考 PDF / md
  retrieval/                       # Embedding 缓存
```

VS Code 扩展全局存储另外保存：

- AI Profile（API Token 走 VS Code `SecretStorage`）
- 跨 workspace 偏好
- Coach 调度器状态

---

## 项目结构

```
src/
  extension.ts                    # 扩展入口
  ai/
    client.ts                     # HTTP + CLI 双形态 AI Client，重试、流式
    prompts.ts                    # 所有 system / user prompt 在这里
    profileManager.ts             # 多 Profile + Secret Storage
  coach/
    lectureWebviewProvider.ts     # 讲义阅读面板
    claudeCodeRunner.ts           # 启动并解析 `claude` CLI 子进程
    inlineEdit.ts                 # 行内改写 / 扩写 / 批注
  courses/
    courseManager.ts              # 学科 / 章节 / 讲义文件系统层
    contentGenerator.ts           # 大纲 + 讲义 + 练习生成
  retrieval/                      # 混合 RAG：关键词 + 向量 + Vision PDF
  sidebar/
    SidebarProvider.ts            # 主侧边栏 webview 控制器
    webview/                      # 主侧边栏 HTML / CSS / JS
    lecture-webview/              # 讲义阅读器 HTML / CSS / JS
    shared/design-system.css      # 跨 webview 共享设计 Token + 组件
  projects/                       # 项目规格生成器
  utils/                          # 文件系统、Markdown、消毒等
  types.ts                        # 共享类型
```

### 给 AI agent / 维护者的关键文件

| 关心的事 | 文件 |
|---|---|
| 扩展激活 | [src/extension.ts](src/extension.ts) |
| 侧边栏消息分发（约 70 个消息类型） | [src/sidebar/SidebarProvider.ts](src/sidebar/SidebarProvider.ts) |
| 讲义阅读器主控 | [src/coach/lectureWebviewProvider.ts](src/coach/lectureWebviewProvider.ts) |
| 所有 prompt | [src/ai/prompts.ts](src/ai/prompts.ts) |
| AI HTTP / CLI Client | [src/ai/client.ts](src/ai/client.ts) |
| Claude CLI 子进程封装 | [src/coach/claudeCodeRunner.ts](src/coach/claudeCodeRunner.ts) |
| 课程 / 讲义 / 练习生成 | [src/courses/contentGenerator.ts](src/courses/contentGenerator.ts) |
| 设计系统（共享） | [src/sidebar/shared/design-system.css](src/sidebar/shared/design-system.css) |

---

## 开发

```bash
npm run compile     # tsc → out/
npm run watch       # tsc -w
npm run lint        # eslint
npm run test        # 单测
npm run package     # 打包成 .vsix
```

### 项目约定

代码里写死的硬规则，贡献时请遵守：

- **`tsconfig` 没开 `noEmitOnError`。** 半成品 `out/` 会让扩展激活直接崩。**有 in-progress 改动时不要自动 compile。**
- **设计系统单一来源。** Token + 组件 CSS 全部在 `src/sidebar/shared/design-system.css`，两套 webview 都通过 `localResourceRoots` 引用它。
- **讲义写入必经 `.bak`。** 每次写讲义 `.md` 前先把上一份内容存到 `<file>.md.bak`，讲义阅读器里的撤回按钮就靠这个。
- **真文件，不 mock。** 生成相关的测试都打真 markdown 文件，避免 mock 掉文件系统 / AI Client。
- **Prompt 集中放。** 所有 system / user prompt 模板都在 `src/ai/prompts.ts`。不要在 handler 里 inline prompt 字符串。
- **Webview 消息通过 `type` 字段隐式版本化。** 加一个新消息需要 producer（webview JS）和 consumer（扩展宿主 TS）同步更新。

### 常见坑

- **Windows `cmd.exe` + 长中文 prompt** —— 启动 `claude` CLI 时，prompt 走 **stdin pipe**（不走 `-p` 命令行参数），stderr 用 UTF-8 → GBK 智能回退解码。见 [src/coach/claudeCodeRunner.ts](src/coach/claudeCodeRunner.ts)。
- **Claude 的 `Write` 工具不支持二进制。** 智能搜图时 Claude 只返回 URL，扩展宿主用 `https.get` 下载。见 [src/coach/lectureWebviewProvider.ts](src/coach/lectureWebviewProvider.ts) 的 `handleClaudeCodeSearchImage`。
- **默认 `maxTokens: 4096` 会把长讲义截断。** 讲义生成显式传 `maxTokens: 16000`。见 [src/courses/contentGenerator.ts](src/courses/contentGenerator.ts)。
- **`localResourceRoots` 必须包含 `shared/`**，否则 `design-system.css` 加载会被 webview CSP 拒。

---

## 路线图

- [ ] README 加截图 / GIF 演示
- [ ] 发布到 VS Code Marketplace
- [ ] 首次启动引导流程
- [ ] 完成课程可导出为移动端友好格式（HTML / EPUB）
- [ ] 在错题本之上加间隔重复调度器
- [ ] 公共模型预设（一键模板 Profile）

---

## 隐私 & 数据

- **零遥测。** 除了你配置的 AI / Embedding 接口，ClaudeCoach 不发任何外网请求。
- **没有服务器。** 课程 / 讲义 / 练习都是你磁盘上的普通文件；唯一的"服务"是 VS Code 的 `SecretStorage`（用来存 API Token）。
- **想清空** 只要删掉 `.claudecoach/` 目录、卸载扩展即可。

---

## 贡献

欢迎 Issue 和 PR。重大架构变更请先开 Issue 讨论。这是一个有偏好的单作者项目
（偏应试学习风格）—— 提替代方案而不是直接强推。

## License

MIT。见 [LICENSE](LICENSE)。

## 致谢

构建在这些项目之上：

- [VS Code Extension API](https://code.visualstudio.com/api)
- [markdown-it](https://github.com/markdown-it/markdown-it)、[KaTeX](https://katex.org/)、[Mermaid](https://mermaid.js.org/)、[hpcc-js/wasm](https://github.com/hpcc-systems/hpcc-js-wasm)（Graphviz）
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- 灵感来源：Anki 间隔重复、Andy Matuschak 的常青笔记、Khan Academy。
