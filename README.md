# ClaudeCoach

A self-hosted, AI-powered learning assistant for VS Code. Generates courses,
lectures and exercises from your own textbooks; grades hand-written answers
via vision models; runs an autonomous "coach" that nudges you toward your
goals; and retrieves grounded context from your reference material via a
keyword + vector hybrid RAG pipeline.

> This README is the canonical entry point for AI agents and human
> maintainers. It documents the project structure, data flows, module
> responsibilities, conventions, and the most common maintenance tasks. If
> you change architecture or add a major subsystem, update this file in the
> same commit.

---

## Table of Contents

1. [What It Is](#what-it-is)
2. [Top-Level Architecture](#top-level-architecture)
3. [Directory Structure](#directory-structure)
4. [Core Data Flows](#core-data-flows)
5. [Module Reference](#module-reference)
6. [Active Coach Framework](#active-coach-framework)
7. [Hybrid RAG (Retrieval) Architecture](#hybrid-rag-retrieval-architecture)
8. [Exam Prep Mode](#exam-prep-mode)
9. [Inline Edit (Lecture Webview)](#inline-edit-lecture-webview)
10. [Settings & Preferences](#settings--preferences)
11. [AI Profile System](#ai-profile-system)
12. [Storage Layout](#storage-layout)
13. [Build, Run, Develop](#build-run-develop)
14. [Conventions & Patterns](#conventions--patterns)
15. [Maintenance Playbook](#maintenance-playbook)
16. [Known Limits / Non-Goals](#known-limits--non-goals)

---

## What It Is

ClaudeCoach is a **VS Code extension** that turns the editor into an
adaptive, multi-modal learning environment. Unlike chat-only assistants,
it runs a **closed loop**:

```
   user activity ─▶ progress events ─▶ adaptive engine ─▶ next prompt difficulty
                                            │
                                            ▼
                                  active coach (5 loops)
                                            │
                                            ▼
                                proactive suggestions / nudges
```

Three subsystems make this possible:

| Subsystem            | Goal                                                                    |
|----------------------|-------------------------------------------------------------------------|
| **Course Engine**    | Generate course outlines, lessons (`.md`) and exercises from textbooks  |
| **Adaptive Engine**  | Grade answers → record weak/strong tags → diagnose → adjust difficulty  |
| **Active Coach**     | Watch user activity; proactively suggest review / breaks / next steps   |

Plus the supporting capabilities:

- **Hybrid RAG**: keyword IDF + bge-m3 vector embeddings, RRF-fused
- **Multi-modal grading**: paste handwritten answer photos, vision LLM grades
- **Exam Prep mode**: paper analysis → variant questions → readiness score
- **Inline edit**: select any text in the lecture, type "再举一个反例" → AI rewrites in place
- **Multi-profile AI config**: switch between OpenAI / Anthropic / SiliconFlow / Codex relays

---

## Top-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension Host                         │
│                                                                        │
│  ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────┐    │
│  │ SidebarProvider  │   │ LectureWebview-  │   │ ExamWebview-    │    │
│  │  (main sidebar)  │   │ Provider         │   │ Provider        │    │
│  │                  │   │ (panel)          │   │ (panel + PDF)   │    │
│  └────────┬─────────┘   └────────┬─────────┘   └────────┬────────┘    │
│           │                      │                      │              │
│           └──────────┬───────────┴──────────┬───────────┘              │
│                      │                      │                          │
│  ┌───────────────────▼──────────────────────▼─────────────────────┐    │
│  │                     Service Layer                              │    │
│  │                                                                 │    │
│  │  AIClient (chat/json/vision)    EmbeddingClient (separate)     │    │
│  │  ContentGenerator               MaterialManager (+ HybridRAG)  │    │
│  │  CourseManager                  ExamPrepStore + Analyzer/etc.  │    │
│  │  AdaptiveEngine                 CoachAgent (+ 5 loops)         │    │
│  │  CourseProfileStore             SuggestionStore + EventBus     │    │
│  │  PreferencesStore               LearningPlanStore              │    │
│  │  ProgressStore                  SessionLogger                  │    │
│  └────────────────────────────┬───────────────────────────────────┘    │
│                               │                                        │
│  ┌────────────────────────────▼───────────────────────────────────┐    │
│  │                  Storage Layer (file-system)                   │    │
│  │   StoragePathResolver gives every store its directory.         │    │
│  │   All persistence is plain JSON / Markdown — no databases.     │    │
│  └────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────┘
```

**Bootstrap**: `extension.ts > activate()` instantiates every store/engine,
wires the dependency injection (`materialManager.setHybridDeps`,
`sidebarProvider.attachCoachAgent`), and registers commands + the sidebar
view. There are **no global singletons** — everything is constructed once
in `activate` and passed via constructor or setter.

---

## Directory Structure

```
ClaudeCoach/
├── src/
│   ├── extension.ts                # entry point — activate() wires DI
│   ├── config.ts                   # legacy single-profile config helpers
│   ├── types.ts                    # ALL shared types (1300+ lines)
│   │
│   ├── ai/
│   │   ├── client.ts               # AIClient: chat / chatJson / multimodal
│   │   ├── embeddingClient.ts      # EmbeddingClient: /v1/embeddings (RAG)
│   │   ├── profileManager.ts       # AI Profile CRUD + import (.claude/.codex)
│   │   ├── prompts.ts              # ALL system prompts (1450+ lines)
│   │   └── tokenBudget.ts          # token-aware context trimming helpers
│   │
│   ├── coach/
│   │   ├── coachAgent.ts           # decision center; throttle + DND
│   │   ├── coachEventBus.ts        # vscode.EventEmitter-based pubsub
│   │   ├── coachState.ts           # persistent { dnd, lastBriefAt }
│   │   ├── suggestionStore.ts      # CoachSuggestion CRUD + dedup
│   │   ├── sessionLogger.ts        # StudySession + ActivityLog
│   │   ├── learningPlanStore.ts    # LearningPlan + drift calculation
│   │   ├── spacedRepetitionStore.ts# SR queue (SM-2 simplified)
│   │   ├── dailyBriefCache.ts      # per-day brief cache
│   │   ├── streakHook.ts           # streak detection + cross-lesson tag links
│   │   ├── inlineEdit.ts           # 1A: native-preview inline edit commands
│   │   ├── inlineWriteback.ts      # source-line + selection text → file write
│   │   ├── lectureWebviewProvider.ts # 1B: self-rendered lecture webview panel
│   │   ├── examWebviewProvider.ts  # exam workbench + variants PDF panels
│   │   └── loops/
│   │       ├── index.ts            # registers all loops with CoachAgent
│   │       ├── dailyBrief.ts       # Loop 1
│   │       ├── idleCoach.ts        # Loop 2
│   │       ├── spacedRepetition.ts # Loop 3
│   │       ├── metacognition.ts    # Loop 4
│   │       └── driftDetection.ts   # Loop 5
│   │
│   ├── courses/
│   │   ├── courseManager.ts        # course-outline.json CRUD + lesson paths
│   │   ├── contentGenerator.ts     # generateCourse / generateLesson / generateExercises
│   │   ├── exerciseScanner.ts      # parse 练习.md → Exercise[]
│   │   └── grader.ts               # gradeOne / gradeAll
│   │
│   ├── exam/
│   │   ├── examPrepStore.ts        # session CRUD + image storage
│   │   ├── examAnalyzer.ts         # AI analyze paper → topics/types/coverage
│   │   ├── examVariantGenerator.ts # generate deep variants (not "换皮")
│   │   ├── examGrader.ts           # vision OCR + grade; text fallback
│   │   └── examReadinessCalculator.ts # 4-component weighted readiness score
│   │
│   ├── materials/
│   │   ├── materialManager.ts      # main facade; index, retrieve, vectorize
│   │   ├── textExtractor.ts        # pdf-parse + .txt/.md raw read
│   │   ├── textbookParser.ts       # build summary (chapters/sections/exercises)
│   │   ├── vectorIndex.ts          # per-material .vec.json (Hybrid RAG)
│   │   └── hybridRetriever.ts      # RRF fusion of keyword + vector channels
│   │
│   ├── progress/
│   │   ├── progressStore.ts        # StudentProfile + sessionCount
│   │   ├── adaptiveEngine.ts       # diagnose() + recordGradeForAdaptive()
│   │   ├── courseProfileStore.ts   # per-subject CourseProfile (fine-grained)
│   │   └── preferencesStore.ts     # LearningPreferences (the giant config)
│   │
│   ├── sidebar/
│   │   ├── SidebarProvider.ts      # 3000+ lines: 60+ message handlers
│   │   ├── webview/                # main sidebar UI
│   │   │   ├── index.html          # structure (Learn/Chat/Materials/Settings/Logs tabs)
│   │   │   ├── main.js             # 3700+ lines: rendering + state + event handlers
│   │   │   └── style.css           # 2100+ lines: VS Code-themed styles
│   │   ├── lecture-webview/        # self-rendered lecture viewer
│   │   ├── exam-webview/           # exam workbench
│   │   └── exam-pdf-webview/       # variant questions PDF preview
│   │
│   ├── storage/
│   │   └── pathResolver.ts         # ALL filesystem paths derived here
│   │
│   └── utils/
│       ├── fileSystem.ts           # ensureDir / readJson / writeJson / fileExists
│       └── markdown.ts             # writeMarkdown (with fixLatex) + open helpers
│
├── package.json                    # commands / keybindings / configuration
├── tsconfig.json                   # strict mode; out/ → ./out
├── README.md                       # ← this file
├── AI_FEATURES.md                  # higher-level feature catalog (legacy)
├── 前端功能说明.md                  # frontend handler reference (Chinese)
└── out/                            # tsc output; entry: out/extension.js
```

### Webview Resource Convention

The four webviews share the same template pattern:

1. HTML uses `{{varName}}` placeholders
2. Provider does `webview.asWebviewUri(extensionUri.joinPath(...))`
3. `html = template.replace(/{{varName}}/g, uri.toString())`
4. CSP sets `script-src ${webview.cspSource} 'nonce-${nonce}'`
5. All `<script>` tags carry `nonce="{{nonce}}"`

Shared dependencies served from `node_modules`:

- `markdown-it/dist/markdown-it.min.js`
- `katex/dist/{katex.min.js, katex.min.css, contrib/auto-render.min.js}`
- `@highlightjs/cdn-assets/{highlight.min.js, styles/github-dark.min.css}`

---

## Core Data Flows

### Flow 1: Generate Lesson

```
User clicks "生成讲义" in sidebar
  └─▶ webview postMessage('generateLesson')
      └─▶ SidebarProvider case 'generateLesson'
          ├─ prefsStore.get()
          ├─ adaptiveEngine.getLatestDiagnosis(subject)
          ├─ progressStore.getProfile()
          ├─ courseManager.listWrongQuestions(subject)
          ├─ _resolveMaxExcerpts('normal')  ← user pref drives RAG depth
          ├─ _buildSubjectGrounding(subject, query)
          │   └─ materialManager.buildGroundingContext(subject, query)
          │       └─ retrieveRelevantExcerpts(subject, query)
          │           └─ _retrieveRelevantExcerptsWholeBook(...)
          │               ├─ _locateRelevantSections (stage 1: section mappings)
          │               ├─ _scoreChunkWithIDF (stage 2: per-chunk IDF)
          │               └─ hybridRetriever.fuse(...) ← RRF if vectors enabled
          │                   └─ embeddingClient.embed(query)
          │                   └─ vectorIndex.search(material, vec)
          ├─ _buildCourseProfileContext(subject, topicId)
          └─ contentGenerator.generateLesson(...)
              ├─ buildSystemBase('lesson-gen', context, prefs)  ← prompts.ts
              ├─ ai.chatJson(...)
              └─ writeMarkdown(lessonPath, content)  ← fixLatex applied
```

### Flow 2: Grade Exercise

```
User clicks "批改" on an exercise
  └─▶ SidebarProvider._gradeOneAnswer(subject, topicId, lessonId, exerciseId, answer)
      ├─ courseManager.getExercises(subject, topicId, lessonId)
      ├─ _matchExerciseLoosely(exerciseId, exercises)  ← 3-level fallback
      ├─ ai.chatJson(buildSystemBase('grade'), buildUserGrade(...))
      ├─ courseManager.recordGrade(...)
      ├─ adaptiveEngine.recordGradeForAdaptive(subject, score, weakTags, strongTags)
      │   ├─ updates AdaptiveTriggerState (recentEvents, streak)
      │   ├─ if mid-score → emit 'metacog-due' event for Loop 4
      │   ├─ if streak >= 3 same direction → emit 'streak-detected'
      │   └─ courseProfileStore.recordEvent(subject, event)
      └─ post('gradeResult', result)
          └─ frontend renders + may post 'coachSuggestion'
```

### Flow 3: Coach Daily Brief (proactive)

```
Webview becomes visible
  └─▶ webview postMessage('getDailyBrief')
      └─▶ SidebarProvider case 'getDailyBrief'
          └─ coachAgent.requestDailyBrief(subject)
              ├─ dailyBriefCache.get(dateKey + subject)
              │   └─ if cached and < 12h → return cached
              ├─ else:
              │   ├─ collect: SR due count, yesterday StudySession, plan progress
              │   ├─ loops/dailyBrief.ts compose AI prompt
              │   ├─ ai.chatJson(...) → { yesterdayRecap, todaySuggestions[3] }
              │   └─ dailyBriefCache.put(...)
              └─ post('dailyBrief', data) + post('coachSuggestions', ...)
```

### Flow 4: Inline Edit (Lecture Webview)

```
User selects text in lecture-webview, clicks 💬 chip
  └─▶ webview shows comment popover
      └─▶ user types "解释下这一段" + Enter
          └─▶ webview postMessage('inlineSuggest', { selection, sourceLineRange, intent, instruction })
              └─▶ LectureWebviewProvider.handleInlineSuggest
                  ├─ buildInlineRewritePrompt(...)  ← prompts.ts
                  ├─ ai.chat(...)
                  └─ postMessage('inlineSuggestResult', { newContent })
                      └─▶ webview shows preview bubble + "采纳/丢弃"
                          └─▶ on accept: postMessage('inlineApply')
                              └─ inlineWriteback.applyEdit(filePath, sourceLineRange, original, newContent)
                              └─ writeMarkdown(filePath, updatedFile)
                              └─ webview re-renders + flashes change
```

### Flow 5: Auto Vector-Index after Material Import

```
User picks PDF → 'importMaterial' message
  └─▶ SidebarProvider case 'importMaterial'
      └─ materialManager.importMaterial(subject)  ← copies file into storage
      └─ _reconcileMaterialsInBackground(subject, entryId)
          └─▶ materialManager.reconcileMaterials(subject, { materialId })
              ├─ for each candidate: ensureMaterialIndexed
              │   ├─ textExtractor.extractTextFromFile (PDF → .txt)
              │   ├─ textbookParser.parse (text → MaterialSummary)
              │   └─ writeJson(summary.json)
              └─ _autoVectorizeReconciledMaterials(results)  [non-blocking]
                  └─ for each indexed material:
                      └─ ensureVectorIndexFor(material)
                          ├─ chunks = _chunkText(text)  ← heading-aware
                          ├─ existing = vectorIndex.load(material)
                          ├─ { keep, todo } = vectorIndex.diff(existing, chunks, model, dim)
                          ├─ for batch in todo:
                          │   └─ embeddingClient.embed(batch)
                          ├─ vectorIndex.merge(material, model, dim, keep, fresh)
                          └─ emit onDidVectorize → SidebarProvider posts log
```

---

## Module Reference

This section documents every module under `src/`. Each entry covers:
**Purpose**, **Key Exports**, **Dependencies**, and notable invariants.

### `src/extension.ts`

- **Purpose**: VS Code extension entry. `activate()` constructs every
  store/engine, registers commands and the sidebar view, then injects
  dependencies (Coach loops, Hybrid RAG into materialManager, etc.).
- **Key fact**: Order of construction matters — `MaterialManager` must
  exist before `ExamAnalyzer` (which takes it as a constructor param);
  `CoachAgent` is instantiated last and attached to `SidebarProvider`
  via `attachCoachAgent()` to break the circular dependency.

### `src/types.ts`

- **Purpose**: Single source of truth for all cross-module types.
- **Categories**:
  - AI: `AIConfig`, `AIProfile`, `AIWireApi`, `ResolvedAIConfig`
  - Course: `CourseOutline`, `TopicOutline`, `LessonMeta`, `Exercise`, `GradeResult`
  - Tags & Playbooks: `CourseTag`, `CourseTagPlaybook`, `MaterialType`
  - Profile/Progress: `StudentProfile`, `CourseProfile`, `LatestDiagnosis`,
    `FeedbackWeaknessTag`, `FeedbackStrengthTag`
  - Preferences: `LearningPreferences` (the giant one)
  - Coach: `CoachSuggestion`, `LearningPlan`, `StudySession`, `LearnerActivityEntry`
  - Inline edit: `InlineSuggestRequest`, `InlineApplyRequest`, `InlineSuggestResult`
  - Materials: `MaterialEntry`, `MaterialIndex`, `MaterialSummary`, `GroundingSource`
  - Exam: 11 schemas — `ExamPrepSession`, `ExamPaperAnalysis`, `ExamVariantSet`, etc.
  - Sidebar protocol: `SidebarCommand` (incoming), `SidebarResponse` (outgoing)
- **Convention**: New webview messages MUST be added to both unions, or
  TypeScript will reject `_post(...)` / message handlers.

### `src/ai/client.ts`

- **Purpose**: Provider-agnostic AI client. Switches between OpenAI and
  Anthropic protocols based on the active profile's `provider` and
  `wireApi`.
- **Key methods**:
  - `chatCompletion(messages, options)` → text
  - `chatJson<T>(messages, options)` → parsed JSON (auto-extract from
    fenced code, repair attempt, throw on failure)
  - `chatCompletionMultimodal(messages, options)` → vision-capable
  - `chatJsonMultimodal<T>(...)` → vision + JSON
  - `isVisionCapable(provider, model)` → boolean (model name heuristic)
- **Bug-class watch-outs** (fixed but worth knowing):
  - Anthropic API does NOT accept `role: 'system'` in messages array;
    extract to top-level `system` field
  - `wireApi: 'responses'` (Codex) requires different request shape than
    `chat_completions`
  - Stream-only relays (rare) reject non-stream calls; we don't currently
    handle this, but `VisionUnsupportedError` is thrown when needed

### `src/ai/embeddingClient.ts`

- **Purpose**: Independent of `AIClient`. Reads its config from prefs each
  call (so user can change baseUrl/token without restart).
- **Why separate**: chat profile may use a relay that doesn't proxy
  `/v1/embeddings` (e.g. `apikey.soxio.me` for Codex). Embeddings can run
  on `siliconflow.cn` (free `BAAI/bge-m3`) independently.
- **Behavior**:
  - `embed(texts[], options?)` → `number[][] | null` (null on any failure
    — caller falls back to keyword retrieval)
  - Batches up to 32 inputs per HTTP request
  - Retries with exponential backoff
  - `testConnection()` exposed for the Settings UI's "Test" button

### `src/ai/profileManager.ts`

- **Purpose**: Persistent CRUD for AI profiles + import wizards.
- **Storage**: `~/ClaudeCoach/app/ai/profiles.json`
- **Key methods**: `getState`, `saveProfile`, `deleteProfile`,
  `duplicateProfile`, `activateProfile`, `saveWorkspaceOverride`,
  `testResolvedConfig`, `exportProfile`, `importProfile`
- **Workspace override**: `~/ClaudeCoach/workspaces/<id>/ai/override.json`
  optionally pins a different profile to a specific workspace.

### `src/ai/prompts.ts`

- **Purpose**: All system prompts in one file (1450 lines).
- **Pattern**: `buildSystemBase(scope, ctx)` is the entry; it includes a
  context-table that decides which fragments to inject by `scope`:
  - `chat` / `lesson-gen` / `exercise-gen` / `grade` / `diagnosis` /
    `outline-gen` / `lecture-edit`
- **Composition order** (top to bottom of system prompt):
  1. Role declaration
  2. `preferencesContext(prefs, scope)` — user style/tone/symbols
  3. `courseTagContext(tags, scope)` — playbook hint per CourseTag
  4. `studentProfileBlock(profile)` — overall identity
  5. `courseProfileBlock(courseProfile)` — fine-grained chapter mastery
  6. `groundingBlock(grounding)` — retrieved excerpts + sources
  7. `taskInstructions(scope)` — what to do for this scope
- **Convention**: Add new prompt = pick the correct scope, decide which
  fragments to include via the table; do NOT hardcode strings in
  ContentGenerator / ExamGrader / etc. — call `buildSystemBase`.

### `src/ai/tokenBudget.ts`

- **Purpose**: Lightweight token estimation + truncation. Used to keep
  long contexts under the active model's `contextWindow`.
- **Notes**: Uses character-based heuristics (1 token ≈ 4 ASCII chars / 1.5
  CJK chars). Good enough for budgeting, NOT for billing.

### `src/coach/coachAgent.ts`

- **Purpose**: Decision center. Owns the 5 loops, the throttle counters,
  the DND state.
- **API**:
  - `requestDailyBrief(subject)` — debounced, cache-aware
  - `recordEvent(event)` — entry to event bus from outside
  - `getCurrentDoNotDisturb()` / `setDoNotDisturb(durationMinutes)`
  - `getActivePromotions()` — returns suggestions ready to display
- **Throttle**: `maxToastsPerHour` and `maxBannersPerHour` from prefs;
  the agent silently shelves over-budget suggestions (writes to JSONL
  with `dispatchedAt: null`, retries next tick).

### `src/coach/coachEventBus.ts`

- **Purpose**: Thin wrapper around `vscode.EventEmitter` with a typed
  event union. Loops subscribe; producers (AdaptiveEngine, SessionLogger,
  webview) emit.

### `src/coach/loops/*`

Five proactive behaviors. Each loop:

1. Subscribes to relevant events (or runs on a tick)
2. Decides whether to emit a `CoachSuggestion`
3. Respects DND + throttle (handled by `CoachAgent`)

| Loop                       | Trigger                                      | Action                                  |
|----------------------------|----------------------------------------------|-----------------------------------------|
| `dailyBrief.ts`            | webview visible + 12h since last brief       | AI summary of yesterday + 3 suggestions |
| `idleCoach.ts`             | active md editor + N min no typing           | banner: "卡住了？AI 来帮一下"             |
| `spacedRepetition.ts`      | grade < 70 (queue) + daily tick (due scan)   | "今日复习 N 道" chip → re-practice       |
| `metacognition.ts`         | grade in 30-80 mid-band                      | grade panel adds reflection input       |
| `driftDetection.ts`        | LearningPlan exists, daily brief             | drift > threshold → re-balance plan      |

### `src/coach/learningPlanStore.ts`

- **Purpose**: CRUD for `LearningPlan` per subject.
- **Path**: `~/ClaudeCoach/app/coach/plans/<subject>.json`
- **AI integration**: `decomposeIntoMilestones(plan, courseOutline)` calls
  `ai.chatJson` with `learningPlanDecomposePrompt` to break a goal into
  dated milestones; falls back to "evenly split chapters across days"
  when AI fails.

### `src/coach/spacedRepetitionStore.ts`

- **Purpose**: SM-2 simplified spaced-repetition queue per subject.
- **Algorithm**: `interval` resets to 1 on wrong answer; on correct,
  `interval` doubles (1 → 2 → 4 → 8 → 16 → 30 days max).
- **Path**: `<courseSubjectDir>/sr-queue.json`

### `src/coach/dailyBriefCache.ts`

- **Purpose**: Per-day cache to avoid re-calling AI for the same brief.
- **Key**: `${YYYY-MM-DD}::${subject || 'global'}`
- **Strategy**: `'per-day'` (default) or `'always-fresh'` from prefs.

### `src/coach/inlineEdit.ts`, `inlineWriteback.ts`

- **Purpose**: Native-preview mode (1A) inline edit. Registers
  `claudeCoach.inlineEdit` and `claudeCoach.inlineRewrite` commands.
  Writes back via line-range + selection-text matching.
- **Path safety**: only allows writes to files inside
  `<courseSubjectDir>/**/*.md` (whitelist enforced).

### `src/coach/lectureWebviewProvider.ts`

- **Purpose**: Mode 1B — self-rendered lecture viewer (Claude-Code-style
  selection comments). Markdown-it + KaTeX + highlight.js.
- **Selection→source mapping**: markdown-it plugin injects
  `data-source-line="N"` on every block element; webview reads the
  attribute to compute precise source line ranges.
- **Hot-reload**: `vscode.workspace.onDidChangeTextDocument` (debounced
  300ms) → re-render webview if external editor changed the .md.

### `src/coach/examWebviewProvider.ts`

- **Purpose**: Two webview panels:
  - `claudeCoach.examWorkbench` — paper analysis, variants, submit/grade
  - `claudeCoach.examVariantsPreview` — print-friendly PDF preview
- **Image upload**: paste / drop / file-picker; data-URL → backend saves
  to `<storage>/exam-sessions/<id>/submissions/<sid>/<n>.png`.

### `src/courses/courseManager.ts`

- **Purpose**: Course outline + lesson file management.
- **Storage**: `<courseSubjectDir>/{course-outline.json, course-summary.md}`
- **Lesson paths**: `<courseSubjectDir>/<topicCode>-<lessonId>/{讲义.md, 练习.md}`
- **Key methods**: `getCourseOutline`, `setCourseOutline`,
  `getLessonPath`, `recordGrade`, `listWrongQuestions`,
  `addWrongQuestion`, `markWrongQuestionResolved`

### `src/courses/contentGenerator.ts`

- **Purpose**: All AI-generation flows: course outline, lesson, exercises,
  outline rebuild (preview + apply).
- **Coupling**: takes `MaterialManager` (for grounding), `CourseManager`
  (for writing), `AIClient`. Most methods accept a `PromptContext` that
  the SidebarProvider builds.

### `src/courses/grader.ts`

- **Purpose**: Per-exercise grading. Wraps `ai.chatJson` with the grade
  prompt, returns `GradeResult`.
- **Key**: After grading, emits to AdaptiveEngine for the closed-loop
  feedback (recent events + chapter profile updates).

### `src/exam/*`

See [Exam Prep Mode](#exam-prep-mode) for full doc.

### `src/materials/materialManager.ts`

- **Purpose**: Facade for the entire materials subsystem — import,
  index, retrieve, vectorize.
- **Key methods**:
  - `importMaterial(subject)` — file picker + copy to storage
  - `reconcileMaterials(subject, options)` — ensure all are indexed,
    triggers auto-vectorize
  - `buildGroundingContext(subject, query, options)` — main retrieval
    entry returning `GroundingContextV2`
  - `ensureVectorIndexFor(material, progress)` — incremental vectorize
  - `reindexAllVectors(subject, progress)` — force rebuild
  - `setHybridDeps(...)` — DI for embedding/vector/hybrid trio
- **Events**: `onDidChangeIndex`, `onDidVectorize`

### `src/materials/textExtractor.ts`

- **Purpose**: Pluggable text extraction. Currently `pdf-parse` for PDFs;
  raw read for `.md` / `.txt`. Returns empty string on failure (callers
  must handle).

### `src/materials/textbookParser.ts`

- **Purpose**: Parses raw textbook text into structured `MaterialSummary`:
  chapters → sections → exercises with anchor terms. Used both for the
  retrieval first-stage section locator and for the materials sidebar.

### `src/materials/vectorIndex.ts`

- **Purpose**: Per-material vector storage.
- **File**: `<materialDir>/vector-index.json`
- **Schema**: `{ version, model, dimension, chunks: [{ chunkIndex,
  textHash, text, vector }] }`
- **`diff()`**: text-hash-based incremental detection (unchanged chunks
  reuse old vectors; model/dim changes invalidate everything)

### `src/materials/hybridRetriever.ts`

- **Purpose**: RRF fusion of keyword + vector channels.
- **Formula**: `score(c) = 1/(60+rank_kw) + α · 1/(60+rank_vec)`
  where α = `prefs.retrieval.embedding.hybridWeight`
- **Why rank-based not score-based**: keyword IDF (~tens) and cosine
  (0..1) are different magnitudes; rank normalizes them.
- **Fallback chain**: vector unavailable → pure keyword; keyword empty
  but vector hits exist → vector-only result set.

### `src/progress/adaptiveEngine.ts`

- **Purpose**: Closed-loop feedback. The "因材施教" engine.
- **Key methods**:
  - `recordGradeForAdaptive(subject, score, weakTags, strongTags)` —
    feeds the loop, updates streak, emits coach events
  - `getLatestDiagnosis(subject)` / `runDiagnosis(subject, force)`
  - `nextDifficulty(subject, baseLevel)` — used by ContentGenerator
- **State**: `~/ClaudeCoach/app/diagnostics/<subject>/{latest,history/}`
  + `AdaptiveTriggerState` (recent events ring + streak)

### `src/progress/courseProfileStore.ts`

- **Purpose**: Per-subject "fine-grained student profile" — chapter-level
  mastery, misconceptions, preferred scaffolding.
- **Path**: `<courseSubjectDir>/profile.json`
- **Built into prompts**: `buildSystemBase` includes a `courseProfileBlock`
  fragment derived from this.

### `src/progress/preferencesStore.ts`

- **Purpose**: User preferences CRUD with defaults + migration.
- **Path**: `~/ClaudeCoach/app/preferences/learning.json`
- **Migration**: deep merge with `DEFAULT_PREFERENCES`. Stale prefs
  files keep working when new fields are added.
- **API**: `get`, `save`, `resetGroup`, `resetAll`, `exportRaw`, `importRaw`

### `src/progress/progressStore.ts`

- **Purpose**: Persistent `StudentProfile` (overall identity, total
  sessions, etc.). Different from `CourseProfile` — student-wide, not
  per-subject.

### `src/sidebar/SidebarProvider.ts`

- **Purpose**: The fat coordinator. Hosts the main sidebar webview;
  receives 60+ message types; orchestrates every other store/engine.
- **Anti-pattern alert**: this file is 3000+ lines. Every "new webview
  message" tends to land here. When it grows past ~3500 lines, factor
  out groups of handlers (Coach handlers / Exam handlers / AI handlers)
  into separate `*Router` files.
- **Common pattern in handlers**:
  1. Validate the message
  2. `_startTask(name, async () => { ... })` for long-running work
  3. Build `PromptContext` via `_buildPromptContext` helpers
  4. Call store/engine method
  5. `_post({ type: ..., data: ... })` to the webview
  6. Update related state (`_refreshCourses`, `_refreshMaterials`)

### `src/storage/pathResolver.ts`

- **Purpose**: Single source of truth for filesystem paths.
- **Root**: `~/ClaudeCoach/` by default; configurable via
  `claudeCoach.dataDirectory`.
- **Adding a new subsystem**: add a getter/method here, never hardcode
  paths in stores.

### `src/utils/markdown.ts`

- **`writeMarkdown(filePath, content)`**: writes `.md` after running
  `fixLatex` (escapes `$` in code blocks, normalizes block math).
- **`openMarkdownPreview(filePath)`**: opens in VS Code preview based on
  user's `viewerMode` preference.
- **`writeMarkdownAndPreview(filePath, content)`**: convenience wrapper.

### `src/utils/fileSystem.ts`

Standard helpers: `ensureDir`, `readJson<T>`, `writeJson`, `writeText`,
`fileExists`. All async, all swallow expected errors (returns `null`
for missing files, etc.).

---

## Active Coach Framework

The coach is the user-perceptible "agency" of ClaudeCoach. It must be:

1. **Visible** — every suggestion has an explanation; users see the
   activity stream that triggered it
2. **Throttled** — never floods. Hourly/daily limits + DND
3. **Optional** — every loop and notification level is a setting

### Architecture

```
                          CoachEventBus
                               │
            ┌──────────────────┼─────────────────┐
            │                  │                 │
            ▼                  ▼                 ▼
       Loop 1..5         AdaptiveEngine     SessionLogger
            │                  │                 │
            └────────┬─────────┴─────────────────┘
                     │
                     ▼
             ┌───────────────┐
             │  CoachAgent   │  (decision center)
             │  - throttle   │
             │  - DND        │
             │  - dedup      │
             └───────┬───────┘
                     │ emit
                     ▼
              SuggestionStore     (JSONL, dedupKey)
                     │
                     │ render
                     ▼
              Sidebar UI (today panel) + StatusBar + (optional) Toast
```

### Event taxonomy (from `coachEventBus.ts`)

| Event                        | Producer                     | Loops listening   |
|------------------------------|------------------------------|-------------------|
| `gradeRecorded`              | AdaptiveEngine               | 3, 4              |
| `streakDetected`             | AdaptiveEngine               | streakHook        |
| `crossLessonTagDetected`     | AdaptiveEngine               | streakHook        |
| `webviewVisible`             | SessionLogger                | 1                 |
| `editorIdle`                 | SessionLogger                | 2                 |
| `lessonOpened`               | SessionLogger                | 1, 5              |
| `srItemDue`                  | SpacedRepetitionStore        | 3                 |
| `planMissedDay`              | LearningPlanStore (tick)     | 5                 |

### Suggestion lifecycle

```
Loop emits → CoachAgent dedups by `dedupKey` → SuggestionStore.append (JSONL)
                                                       │
                                                       ▼
                                            UI requests pending list
                                                       │
                                                       ▼
                                         renders in "今日 Coach" panel
                                                       │
                                                       ▼
                                User clicks action / dismiss → markDismissed
```

### Key invariant

`CoachAgent` ALWAYS persists suggestions to `suggestions.jsonl`, even
when shelved by throttle/DND (with `dispatchedAt: null`). This ensures
nothing is silently lost; the user can review the activity stream and
see *why* a suggestion didn't fire.

---

## Hybrid RAG (Retrieval) Architecture

### Why hybrid

Pure keyword (IDF) misses synonyms and cross-language ("dynamic
programming" vs "动态规划"). Pure vector misses exact phrases and
section-anchored matches. RRF fusion gets both.

### Pipeline

```
query string
   │
   ├─▶ keyword channel:
   │     ├─ _extractSearchTerms(query) → terms[]
   │     ├─ _locateRelevantSections (anchor on summary.sectionMappings)
   │     └─ for each chunk: IDF score + section bonus + tag bonus
   │     → top K_kw candidates
   │
   ├─▶ vector channel (only if hybridWeight > 0 and embedding enabled):
   │     ├─ embeddingClient.embed([query])
   │     ├─ for each material: vectorIndex.search(queryVec, K_vec)
   │     └─ collect across all materials
   │     → top K_vec candidates
   │
   └─▶ hybridRetriever.fuse(keyword, vector, options)
         └─ score = 1/(60+rank_kw) + α·1/(60+rank_vec)
         → top maxExcerpts → RetrievedExcerpt[] with retrievedBy tag
```

### Storage

```
~/ClaudeCoach/library/materials/<subject>/<materialId>/
  ├── source.pdf                  ← original file
  ├── extracted.txt               ← textExtractor output
  ├── summary.json                ← MaterialSummary (chapters, sections)
  ├── meta.json                   ← MaterialEntry copy
  └── vector-index.json           ← VectorIndexFile (1024d × N chunks)
```

### Heading-aware chunking

`_chunkText` tracks current chapter/section as it walks paragraphs.
Output chunks get a `[第 3 章 动态规划 / 3.2 最优子结构]` prefix so:

- Keyword IDF picks up chapter words
- Vector embeddings get clearer semantic boundaries
- Retrieved excerpts are self-contained for the LLM

### Embedding provider

- Default: `BAAI/bge-m3` via `https://api.siliconflow.cn/v1` (free,
  multilingual, 1024d)
- Configurable to any OpenAI-compatible `/v1/embeddings` endpoint
- Independent from the chat profile (different baseUrl/token allowed)

### Failure modes (graceful)

| Condition                            | Behavior                          |
|--------------------------------------|-----------------------------------|
| Embedding profile not configured     | Pure keyword retrieval            |
| Embedding API call fails             | Pure keyword retrieval (this query)|
| Material has no vector index         | That material → keyword only       |
| Model/dimension mismatch on load     | Treat as no index → rebuild on next vectorize |
| Wrong text after edit (hash miss)    | That chunk re-embedded next vectorize |

---

## Exam Prep Mode

Lives in `src/exam/` + `src/coach/examWebviewProvider.ts`.

### User flow

1. User creates an exam session (subject + name + exam date)
2. Selects a "真题" PDF from materials → `examAnalyzer.analyze()` produces
   topics covered, question types, difficulty distribution
3. Clicks "Generate variants" → `examVariantGenerator.generate()`
   produces N "deep variants" (different angle / scenario / combination,
   not "换皮")
4. Variants render as a printable PDF webview → user prints to A4 → does
   the paper by hand → photographs answers
5. Drag/paste answer photos into the workbench → `examGrader.grade()`
   uses vision-capable LLM to OCR + grade per-question
6. `examReadinessCalculator.compute()` outputs a 0-100 readiness score:
   - 40% mock exam performance
   - 30% wrong-question burndown
   - 20% topic coverage
   - 10% study plan progress

### Storage

```
~/ClaudeCoach/app/exam-sessions/
  ├── index.json                  ← list of all sessions
  └── <sessionId>/
      ├── session.json            ← ExamPrepSession
      ├── analyses/<paperId>.json ← ExamPaperAnalysis
      ├── variants/<setId>.json   ← ExamVariantSet
      ├── submissions/<subId>/
      │   ├── meta.json           ← ExamSubmission
      │   ├── 01.png …            ← uploaded answer images
      │   └── grading.json        ← ExamGrading
      └── readiness.json          ← latest snapshot
```

### Vision fallback

If the active AI profile's model doesn't support image input,
`examGrader` throws `VisionUnsupportedError` with `suggestedModels`.
The webview catches this and offers a text-fallback modal where the
user types each answer.

---

## Inline Edit (Lecture Webview)

Two modes coexist (`coach.lecture.viewerMode`):

### `'lecture-webview'` (default — Claude Code-style)

- Custom webview panel renders markdown
- User selects any text → 💬 chip appears near selection
- Three intents (rendered as buttons): **改写** / **追问** / **想法**
- Click → comment box → type instruction → Enter
- Backend: `LectureWebviewProvider.handleInlineSuggest`
  - Computes source line range via `data-source-line` attribute
  - Builds prompt via `inlineRewritePrompt(...)`
  - Calls AI → posts result back
- Two apply modes (`coach.lecture.applyMode`):
  - `'preview-confirm'` (default): preview bubble + 采纳/丢弃
  - `'auto-apply'`: write back immediately

### `'native-preview'` (1A — fallback)

- Source `.md` opens with VS Code's native preview to the side
- `Alt+I` in the source pane → input box → AI inserts at cursor
- Right-click → "重写选中段落" → AI replaces selection

Both modes share `inlineWriteback.ts` for the actual file write.

---

## Settings & Preferences

### Schema

`LearningPreferences` lives in `types.ts:467`. Top-level groups:

```ts
{
  difficulty: { global, perSubject, exerciseMix },
  pace:       { dailyGoalMinutes, exercisesPerSession, speed,
                reviewEveryNLessons, restDays, studyTimeSlots },
  language:   { content, exercises, codeComments },
  aiStyle:    { lessonDetail, feedbackTone, explanationStyles,
                mathSymbol, exerciseTypeMix, includeProofs, includeHistory },
  retrieval:  { defaultGrounding, strictness, citeSources, maxExcerpts,
                embedding: { enabled, baseUrl, apiToken, model,
                             dimension, hybridWeight } },
  ui:         { fontSize, defaultTab, expandCourseTree, showEmoji, theme },
  coach:      { active, loops: { dailyBrief, idle, sr, metacog, drift },
                notifications: { toastLevel, quietHoursStart, quietHoursEnd },
                throttle: { maxToastsPerHour, maxBannersPerHour },
                doNotDisturbUntil, idleThresholdMinutes,
                sr: { variantStrategy },
                dailyBrief: { cacheStrategy },
                lecture: { viewerMode, applyMode, syncSourceEditor,
                           highlightChangesMs } }
}
```

### How preferences influence prompts

`preferencesContext(prefs, scope)` in `prompts.ts` injects fragments
based on the current scope. The most-impactful flows:

| Setting                          | Scope                  | Effect on prompt                                   |
|----------------------------------|------------------------|----------------------------------------------------|
| `aiStyle.lessonDetail`           | lesson-gen             | "目标字数 X-Y 字"                                   |
| `aiStyle.feedbackTone`           | grade, chat            | Adjusts opener: 严肃 / 鼓励 / 苏格拉底 / push / 有趣 |
| `aiStyle.explanationStyles`      | lesson-gen, chat       | "示例优先 / 公式优先 / 直觉优先 / 严谨证明"           |
| `aiStyle.mathSymbol`             | all                    | "中文符号 ⌈⌉" vs "标准 LaTeX"                       |
| `aiStyle.exerciseTypeMix`        | exercise-gen           | "选择 X% / 问答 Y% / 代码 Z%"                       |
| `aiStyle.includeProofs/History`  | lesson-gen             | Toggles "包含证明" / "包含历史背景"                  |
| `language.content/exercises`     | all relevant           | zh / en / mixed instructions                        |
| `retrieval.strictness`           | grounding              | Controls IDF threshold in scoring                   |

### Settings UI structure

`src/sidebar/webview/index.html` renders 8 accordion groups (only one
open at a time, mutex enforced in `main.js`):

1. 学习节奏与目标
2. AI 风格与内容
3. 主动 Coach
4. 资料检索
5. 讲义阅读体验
6. UI 与显示
7. AI 配置中心
8. 数据管理

Each group has its own "恢复默认" button. The whole page has
搜索 / 导出偏好 / 导入偏好 at the top.

---

## AI Profile System

Multiple AI providers can coexist. Switch via the Settings → AI Profile
center.

### Profile fields

```ts
{
  id, name, provider: 'openai' | 'anthropic',
  baseUrl, anthropicBaseUrl, apiToken,
  model, wireApi: 'chat_completions' | 'responses',
  contextWindow, maxTokens, reasoningEffort,
  notes, source: 'manual' | 'claude' | 'codex' | 'package',
  createdAt, updatedAt
}
```

### Import sources

| Source     | Reads                                | Notes                              |
|------------|--------------------------------------|------------------------------------|
| `claude`   | `~/.claude/settings.json`            | One profile per `apiKeyHelper` entry |
| `codex`    | `~/.codex/{config.toml, auth.json}`  | Includes `wireApi: 'responses'`    |
| `package`  | An exported `.cczip` profile         | Round-trips with `exportProfile`   |
| `manual`   | User fills the form                  | -                                  |

### Workspace override

Optional. `~/ClaudeCoach/workspaces/<id>/ai/override.json`. When present,
takes precedence over the global active profile inside that workspace.
Useful for "this work project uses Anthropic, my study uses OpenAI".

---

## Storage Layout

All persistent state under `~/ClaudeCoach/` (configurable). No databases
— plain JSON / Markdown.

```
~/ClaudeCoach/
├── app/
│   ├── ai/profiles.json                          ← all AI profiles
│   ├── user/profile.json                         ← StudentProfile
│   ├── preferences/learning.json                 ← LearningPreferences
│   ├── diagnostics/<subject>/{latest.json, history/}
│   ├── coach/
│   │   ├── plans/<subject>.json                  ← LearningPlan
│   │   ├── sessions/YYYY-MM-DD.jsonl             ← StudySession
│   │   ├── activity/YYYY-MM-DD.jsonl             ← LearnerActivityEntry
│   │   ├── suggestions.jsonl                     ← all CoachSuggestion
│   │   ├── daily-brief-cache.json
│   │   └── state.json                            ← CoachState (DND etc.)
│   └── exam-sessions/
│       ├── index.json
│       └── <sessionId>/{session.json, analyses/, variants/, submissions/, readiness.json}
│
├── library/
│   └── materials/
│       ├── index.json                            ← MaterialIndex
│       └── <subject>/<materialId>/
│           ├── source.<ext>                      ← original PDF/MD/TXT
│           ├── extracted.txt
│           ├── summary.json                      ← MaterialSummary
│           ├── meta.json                         ← MaterialEntry
│           └── vector-index.json                 ← VectorIndexFile (Hybrid RAG)
│
└── workspaces/<workspaceId>/
    ├── meta.json
    ├── ai/override.json                          ← optional workspace AI profile
    └── courses/<subject>/
        ├── outline.json                          ← CourseOutline
        ├── summary.md                            ← human-readable index
        ├── profile.json                          ← CourseProfile
        ├── wrong-questions.json                  ← WrongQuestion[]
        ├── sr-queue.json                         ← SpacedRepetitionQueue
        └── <topicCode>-<lessonId>/
            ├── 讲义.md                            ← lesson markdown
            ├── 练习.md                            ← exercises (parseable)
            └── grades/<exerciseId>.json          ← per-exercise grade history
```

### Path discipline

All paths derived in `src/storage/pathResolver.ts`. **Never hardcode
paths in stores.** When adding a new subsystem, add a getter here first.

---

## Build, Run, Develop

### Prerequisites

- Node.js 18+
- VS Code 1.85+

### First run

```bash
npm install
npm run compile          # tsc -p ./
# Press F5 in VS Code → Extension Development Host launches
```

### Watch mode

```bash
npm run watch            # tsc -watch
# In the dev host: Cmd/Ctrl+R reloads after each compile
```

### Debugging

`launch.json` should have `"runtimeArgs": ["--extensionDevelopmentPath=${workspaceFolder}"]`
configured (it does, see `.vscode/launch.json` if present). Console
goes to Debug Console; webview console goes to its devtools (right-click
in the webview → Inspect).

### Type-checking only

```bash
npx tsc -p ./ --noEmit
```

### Lint

```bash
npm run lint             # eslint src
```

---

## Conventions & Patterns

### Adding a new webview message

1. Add to `SidebarCommand` (in) or `SidebarResponse` (out) in `types.ts`
2. Handler: in `SidebarProvider._handleMessage` switch
3. Frontend: post via `vscode.postMessage({ type: '...', ... })`,
   handle in `main.js`'s `window.addEventListener('message')` switch
4. **Always** `_post({ type: 'log', ... })` after long-running ops so
   the user sees something happened

### Adding a new AI prompt

Don't put strings in stores or providers. Always:

1. Define `function buildXxxPrompt(ctx) { ... }` in `prompts.ts`
2. Call `buildSystemBase(scope, ctx)` for the shared system part
3. Call `ai.chatJson` / `ai.chat` from the appropriate store/engine

### Adding a new preference

1. Extend `LearningPreferences` in `types.ts`
2. Add to `DEFAULT_PREFERENCES` in `preferencesStore.ts`
3. Extend the `mergePreferences` deep-merge to include the new branch
4. UI: add to the relevant accordion group in `index.html` + handlers
   in `main.js`'s `renderPreferences` and the save path
5. Make it actually do something: connect into `preferencesContext` in
   `prompts.ts` (this is the step usually forgotten)

### Adding a coach loop

1. Create `src/coach/loops/<name>.ts`
2. Export `register(coachAgent: CoachAgent)` that calls
   `bus.on('event', handler)` and emits suggestions via
   `coachAgent.emitSuggestion(...)`
3. Register from `src/coach/loops/index.ts`
4. Add a toggle to `coach.loops.<name>` in `LearningPreferences`
5. Have the loop check the toggle before doing anything

### Long-running work

Wrap with `_startTask(name, async () => { ... })` in SidebarProvider —
this posts `taskStart` / `taskEnd` so the webview can show a spinner.

### Error policy

- File-system errors: catch + log + return `null`/empty (caller decides)
- AI errors: catch in handler, post `{ type: 'log', level: 'error', message }`
- Compilation errors: NEVER ship; `tsc --noEmit` must pass before commit
- User-facing: `vscode.window.showWarningMessage({ modal: true })` for
  destructive confirms — `window.confirm()` does NOT work in webviews

### Emoji policy

UI labels (toggles, buttons) and webview messages may use emoji where
they aid scanability. **Code comments and identifiers**: avoid.

---

## Maintenance Playbook

### "AI is generating Chinese where I want English"

1. Check `prefs.language.content` and `prefs.language.exercises`
2. Verify `preferencesContext(prefs, scope)` includes language for that
   scope (`prompts.ts`)
3. If the scope is missing in the table, add it

### "Vector retrieval isn't kicking in"

1. Settings → 资料检索 → 向量检索 should be enabled
2. Click 🔌 测试连通性 — it should return `✓ ... 1024 维`
3. Click ⚙️ 重建当前学科向量索引 to force rebuild
4. Confirm `vector-index.json` exists under
   `~/ClaudeCoach/library/materials/<subject>/<materialId>/`
5. Material card should show `▣ N` green badge after rebuild

### "Coach suggestions never appear"

1. Settings → 主动 Coach → ensure top toggle + at least one loop is on
2. Settings → 通知级别 should NOT be `never`
3. Check current DND: status bar / 设置页 doNotDisturbUntil
4. Inspect `~/ClaudeCoach/app/coach/suggestions.jsonl`. If suggestions
   exist with `dispatchedAt: null`, throttle is firing — raise
   `maxToastsPerHour` / `maxBannersPerHour`

### "Exercise IDs don't match during grading"

This was a bug fixed via three-level loose matching in
`SidebarProvider._matchExerciseLoosely`:
1. Exact ID match
2. Fuzzy ID (strips `ex-` prefix and zero-pads)
3. Index-based (the Nth exercise)

If a new mismatch surfaces, add a fourth level rather than rewriting
the existing ones.

### "I changed types.ts and now SidebarProvider won't compile"

You probably forgot to add the new message type to `SidebarCommand`
(incoming) or `SidebarResponse` (outgoing). Check the tsc errors at
SidebarProvider.ts — they always point to one of these unions.

### "Adding a new file scope and prompt"

If you're adding a new prompt context (say `'review-gen'`):

1. Add to `PromptContextScope` in `types.ts:1117`
2. Update the table in `shouldInclude` in `prompts.ts` for which
   fragments to include
3. Add `taskInstructions` for the new scope
4. Have the calling code build a `PromptContext` with `scope:
   'review-gen'` and call `buildSystemBase(ctx)`

### "Resetting one user's data without affecting others"

Settings → 数据管理 has per-subject "重置当前课程进度" buttons. They
delete `course-outline.json`, `wrong-questions.json`, `sr-queue.json`,
all lesson files, but preserve materials and AI profiles.

For full nuclear reset: delete `~/ClaudeCoach/` and reload the window.

### "Profiles imported from .codex don't work for embedding"

Expected. Codex relays usually only proxy chat. Configure embedding
separately (typical: SiliconFlow + bge-m3, free). See
[Hybrid RAG](#hybrid-rag-retrieval-architecture) section.

### "Prompt budget overrun (response truncated)"

1. Lower `prefs.retrieval.maxExcerpts`
2. Lower `prefs.aiStyle.lessonDetail` to `'concise'`
3. Verify `tokenBudget.ts` heuristics for your model — for very
   non-English text, the 1.5x CJK multiplier may need tuning

---

## Known Limits / Non-Goals

- ❌ **Cross-window-restart real-time alerts**: VS Code can't surface
  toasts when not in foreground. The status bar + JSONL replay on next
  activate are the workaround.
- ❌ **Mobile / web VS Code**: requires Node `https`, `fs/promises`,
  `pdf-parse`. Web runtime not supported.
- ❌ **Reranker (cross-encoder)**: explicitly not in v1; the RRF design
  leaves room for it as a post-processing layer in the future.
- ❌ **Multi-user / cloud sync**: all storage is local.
  `~/ClaudeCoach/` is portable — copy to another machine and it works,
  but no automatic sync.
- ❌ **Stream-only relays**: a few relays require `stream: true` for
  every chat call. Currently we don't transparently downgrade. If you
  need this, see `AIClient.chatCompletion` and add a streaming branch.

---

## License & Acknowledgments

This is a personal project; treat the contents of this repo as
Apache-2.0-equivalent unless a `LICENSE` file says otherwise.

Built on:

- VS Code Extension API (Microsoft)
- markdown-it, KaTeX, highlight.js
- pdf-parse
- BAAI/bge-m3 (via SiliconFlow free tier) for embeddings
- Anthropic Claude / OpenAI GPT for generation

---

> **For maintainers**: when in doubt, prefer adding to existing
> abstractions rather than introducing new ones. The codebase has
> already absorbed several "let's make this generic" refactors that
> turned out to be premature; new code that "fits the pattern" tends
> to compose better than new code that invents one.
