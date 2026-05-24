# ClaudeCoach

> 中文文档：see [README_zh.md](README_zh.md)

A personal AI learning assistant that lives in **VS Code**. Generate courses
from your own textbooks, study with AI-rendered lectures, get hand-written
answers graded by vision models, and let an autonomous "coach" nudge you
toward your learning goals — all from one sidebar, all data on your machine.

Built by a CS undergrad for self-driven, exam-prep style learning.
Bring your own API key (Anthropic / OpenAI-compatible / Claude Code CLI).

---

## What It Does

ClaudeCoach treats studying as a closed loop:

1. **You give it material** — a textbook PDF, a syllabus, or just a goal in plain text.
2. **It generates a course** — topics, lessons, and exercises tailored to your background.
3. **You learn from rendered lectures** — inline math, mermaid/graphviz diagrams, interactive widgets, and AI-searched illustrations embedded right in the markdown.
4. **You answer exercises** — by typing or by handwriting a photo; vision models grade them.
5. **Wrong answers feed back** — future generations target your weak spots, difficulty auto-adjusts.

Nothing leaves your machine except API calls to the model you configured.

---

## Highlights

| Feature | What you get |
|---|---|
| **Course generator** | From "I want to learn X by Y" to a full topic/lesson/exercise outline, with iterative refinement. |
| **Lecture reader** | A dedicated panel that renders generated markdown with KaTeX, Mermaid, Graphviz/DOT, syntax-highlighted code, interactive HTML widgets, and pastable images/video links. |
| **Inline edit** | Select any text in a lecture and ask the AI to rewrite, expand, simplify, or annotate — applied with one-step `.bak` undo. |
| **Smart image search** | One click → spawn `claude` CLI in the background → it searches the web, returns figure URLs → host downloads and embeds them into the lecture. |
| **Hybrid RAG** | Keyword (BM25) + vector embeddings + optional Vision PDF deep extraction. Plug in any OpenAI-compatible embedding endpoint. |
| **Vision grading** | Photograph your handwritten answer → multimodal model grades, explains, and logs wrong questions. |
| **Multi AI Profile** | Manage many (provider, model, token) tuples. Import from `~/.codex/config.toml` or `~/.claude/settings.json` with one click. Per-workspace overrides. |
| **Active coach** | A scheduler that watches your study cadence and surfaces nudges, weak-spot reviews, and adaptive sessions. |
| **Project mode** | Auto-generate a structured project spec (goals, milestones, deliverables) from a one-line idea. |

---

## Screenshots & Demo

*Coming soon — drop your screenshots into `docs/screenshots/` and reference them here.*

Suggested set:

```
docs/screenshots/
  01-sidebar.png       (sidebar tabs overview)
  02-lecture.png       (lecture reader with math + diagram)
  03-inline-edit.png   (inline edit popover)
  04-search-image.png  (smart image search in action)
  05-grading.png       (handwriting grading result)
```

---

## Quick Start

### Prerequisites

- VS Code 1.85+
- Node.js 18+ (for building from source)
- One of:
  - An API key for any OpenAI-compatible service (OpenAI, DeepSeek, OpenRouter, ...)
  - An Anthropic API key
  - A locally installed and logged-in `claude` CLI (uses your Claude subscription; zero API tokens spent on your account)

### Install from source (dev mode)

```bash
git clone https://github.com/dlz666/ClaudeCoach.git
cd ClaudeCoach
npm install
npm run compile
```

Then in VS Code:

1. Open the project folder.
2. Press **F5** → opens an **Extension Development Host** window.
3. In that window, click the **ClaudeCoach** icon in the left activity bar.
4. Go to **Settings → AI & System → AI Profile**, create your first profile.
5. Switch to the **Learning** tab and create your first subject.

### Package as VSIX

```bash
npm run package
```

The resulting `claudecoach-*.vsix` can be installed via **Extensions → ⋯ → Install from VSIX**.

---

## How It Works

ClaudeCoach is a self-hosted VS Code extension. There is **no server** —
all course content, exercises, wrong-question logs, and settings live in your
workspace folder or VS Code's extension storage.

Three execution paths for AI calls, chosen per AI Profile:

1. **OpenAI-compatible HTTP** — anything that speaks `/v1/chat/completions`. Streaming SSE supported.
2. **Anthropic native** — `/v1/messages` for Claude direct.
3. **Claude Code CLI subprocess** — uses your local `claude` binary and your Claude subscription quota (zero API tokens spent on your account). Used for long-running "agent" tasks: smart image search, project scaffolding, batch lecture refinement.

```
                ┌───────────────────────────────────┐
                │      VS Code Sidebar (UI)         │
                │  Courses · Lectures · Exercises   │
                │  Settings · Logs · Chat           │
                └───────────────┬───────────────────┘
                                │ webview messages
                                ▼
┌─────────────────────────────────────────────────────────┐
│              Extension Host (Node)                       │
│  ┌────────┐  ┌────────┐  ┌──────────┐  ┌────────────┐   │
│  │AIClient│  │Content │  │Retrieval │  │ Lecture    │   │
│  │HTTP /  │  │Gen     │  │BM25 +    │  │ Webview    │   │
│  │CLI     │  │        │  │Vector    │  │ Provider   │   │
│  └───┬────┘  └───┬────┘  └────┬─────┘  └─────┬──────┘   │
└──────┼──────────┼────────────┼──────────────┼──────────┘
       ▼          ▼            ▼              ▼
   OpenAI /    .md files   embedding      Lecture Panel
   Anthropic   on disk     index          (separate webview)
   / CLI
```

---

## Configuration

### AI Profiles

ClaudeCoach manages multiple AI profiles. Each profile is one
`(provider, base URL, model, token, context window, max tokens)` tuple.
You can:

- **Create** profiles manually
- **Import** from `~/.codex/config.toml` + `auth.json`
- **Import** from `~/.claude/settings.json`
- **Override per workspace** — use a different profile for different repos

Configure in: **sidebar → Settings → AI & System → AI Profile**.

### Learning Preferences

Under **Settings → Learning**:

- **Pace** — daily lesson count target
- **AI Style** — explanation register (concise / verbose / Socratic)
- **Lecture** — render preferences (math density, code-first vs prose-first)
- **Retrieval** — RAG strictness, top-K, source citation toggle

### Hybrid RAG

Three engines, independently toggleable:

| Engine | What it does | When to enable |
|---|---|---|
| **Grounding** | Keyword retrieval (BM25-style) over your imported markdown / PDF text. Always cheap. | Default ON. |
| **Vector** | Hybrid retrieval — keyword + embedding ANN. Needs an embedding endpoint. | Enable when materials grow past a few hundred pages. |
| **Vision PDF** | Sends scanned PDF pages to a vision model for deep OCR + diagram extraction. | When text-extracted PDF quality is poor (math textbooks, scanned course notes). |

Configure embedding / vision endpoints in **Settings → Learning → Retrieval**.

---

## Storage Layout

All user content lives in `.claudecoach/` inside your workspace:

```
.claudecoach/
  subjects/
    <subject-slug>/
      course.json                  # outline + metadata
      topics/
        <topic-slug>/
          lessons/
            <lesson-id>.md         # rendered lecture (markdown)
            <lesson-id>.md.bak     # one-step revert buffer
            assets/                # pasted / searched images
          exercises/
            <session-id>.md        # questions + your answers
            <session-id>.json      # graded results
      wrong-questions.json
  materials/                       # your imported reference PDFs / md
  retrieval/                       # embedding cache
```

VS Code's extension global storage additionally holds:

- AI Profiles (tokens stored via VS Code SecretStorage)
- Cross-workspace preferences
- Coach scheduler state

---

## Project Structure

```
src/
  extension.ts                    # extension entry point
  ai/
    client.ts                     # HTTP + CLI AI client, retry, streaming
    prompts.ts                    # ALL system / user prompts live here
    profileManager.ts             # multi-profile + secret storage
  coach/
    lectureWebviewProvider.ts     # lecture reader panel
    claudeCodeRunner.ts           # spawns and parses `claude` CLI subprocess
    inlineEdit.ts                 # inline rewrite / expand / annotate
  courses/
    courseManager.ts              # subject / topic / lesson filesystem layer
    contentGenerator.ts           # outline + lesson + exercise generation
  retrieval/                      # hybrid RAG: keyword + vector + vision PDF
  sidebar/
    SidebarProvider.ts            # main sidebar webview controller
    webview/                      # main sidebar HTML / CSS / JS
    lecture-webview/              # lecture reader HTML / CSS / JS
    shared/design-system.css      # cross-webview design tokens + components
  projects/                       # project spec generator
  utils/                          # filesystem, markdown, sanitize, ...
  types.ts                        # shared types
```

### Key files for AI agents / maintainers

| Concern | File |
|---|---|
| Extension activation | [src/extension.ts](src/extension.ts) |
| Sidebar message handler (~70 message types) | [src/sidebar/SidebarProvider.ts](src/sidebar/SidebarProvider.ts) |
| Lecture reader controller | [src/coach/lectureWebviewProvider.ts](src/coach/lectureWebviewProvider.ts) |
| All prompts | [src/ai/prompts.ts](src/ai/prompts.ts) |
| AI HTTP / CLI client | [src/ai/client.ts](src/ai/client.ts) |
| Claude CLI subprocess runner | [src/coach/claudeCodeRunner.ts](src/coach/claudeCodeRunner.ts) |
| Course / lesson / exercise generation | [src/courses/contentGenerator.ts](src/courses/contentGenerator.ts) |
| Design system (shared) | [src/sidebar/shared/design-system.css](src/sidebar/shared/design-system.css) |

---

## Development

```bash
npm run compile     # tsc → out/
npm run watch       # tsc -w
npm run lint        # eslint
npm run test        # unit tests
npm run package     # bundle to .vsix
```

### Conventions

Hard rules embedded in the codebase. Respect them when contributing:

- **`tsconfig` does not set `noEmitOnError`.** Broken `out/` artifacts will crash extension activation. **Do not auto-compile when in-progress changes are present.**
- **Design system is single-sourced.** Token + component CSS live in `src/sidebar/shared/design-system.css`. Both webviews load it via `localResourceRoots`.
- **Lecture writes go through `.bak`.** Every write to a lecture `.md` saves the previous content to `<file>.md.bak`, enabling the in-reader undo button.
- **Real files, not mocks.** Generation tests hit real markdown files on disk; we avoid mocking the file system or AI client.
- **Prompts in one place.** Every system / user prompt template is in `src/ai/prompts.ts`. Don't inline prompt strings in handlers.
- **Webview messages are versioned implicitly by `type`.** Adding a message requires both producer (webview JS) and consumer (extension host TS) to agree.

### Common pitfalls

- **Windows `cmd.exe` + long Chinese prompts** — when spawning `claude` CLI, prompts go through **stdin pipe** (not `-p` argv) and stderr is smart-decoded UTF-8 → GBK fallback. See [src/coach/claudeCodeRunner.ts](src/coach/claudeCodeRunner.ts).
- **Claude `Write` tool cannot write binary.** For image search, Claude returns URLs only; the extension host downloads via `https.get`. See `handleClaudeCodeSearchImage` in [src/coach/lectureWebviewProvider.ts](src/coach/lectureWebviewProvider.ts).
- **Default `maxTokens: 4096` truncates long lectures.** Lesson generation explicitly passes `maxTokens: 16000`. See [src/courses/contentGenerator.ts](src/courses/contentGenerator.ts).
- **`localResourceRoots` must include `shared/`** for `design-system.css` to load.

---

## Roadmap

- [ ] Screenshots & GIF demos in README
- [ ] VS Code Marketplace publish
- [ ] First-run onboarding flow
- [ ] Mobile-friendly export (HTML / EPUB) of finished courses
- [ ] Spaced-repetition scheduler on top of wrong-question log
- [ ] Public model presets (one-click profile templates)

---

## Privacy & Data

- **No telemetry.** ClaudeCoach makes zero outbound calls except to the AI / embedding endpoints **you configured**.
- **No server.** All course / lecture / exercise data is plain files on your disk; the only "service" is VS Code's `SecretStorage` for API tokens.
- **You can delete everything** by removing the `.claudecoach/` folder and uninstalling the extension.

---

## Contributing

Issues and PRs welcome. For major architectural changes, please open an
issue to discuss first. This codebase is opinionated (single-author project
biased toward "exam-prep" learning style) — propose alternatives rather than
forcing them.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Built on:

- [VS Code Extension API](https://code.visualstudio.com/api)
- [markdown-it](https://github.com/markdown-it/markdown-it), [KaTeX](https://katex.org/), [Mermaid](https://mermaid.js.org/), [hpcc-js/wasm](https://github.com/hpcc-systems/hpcc-js-wasm) (Graphviz)
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- Inspiration: Anki spaced repetition, Andy Matuschak's evergreen notes, Khan Academy.
