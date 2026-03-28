import {
  ChatMessage,
  Subject,
  LearningPreferences,
  LatestDiagnosis,
  StudentProfile,
  CourseOutline,
  OutlineRebuildSelection,
  subjectLabel,
} from '../types';

interface PromptContext {
  profile?: StudentProfile | null;
  preferences?: LearningPreferences | null;
  diagnosis?: LatestDiagnosis | null;
  currentCourseTitle?: string;
  courseOutlineSummary?: string;
  materialSummary?: string;
  materialExerciseSummary?: string;
  retrievedExcerpts?: string;
  selectedMaterialTitle?: string;
}

function preferencesContext(prefs: LearningPreferences | null): string {
  if (!prefs) {
    return '';
  }

  return [
    'Learning preferences:',
    `- Global difficulty: ${prefs.difficulty.global}`,
    `- Exercise mix: easy ${prefs.difficulty.exerciseMix.easy}%, medium ${prefs.difficulty.exerciseMix.medium}%, hard ${prefs.difficulty.exerciseMix.hard}%`,
    `- Pace: ${prefs.pace.speed}`,
    `- Exercises per session: ${prefs.pace.exercisesPerSession}`,
    `- Content language: ${prefs.language.content}`,
    `- Code comment language: ${prefs.language.codeComments}`,
  ].join('\n');
}

function diagnosisContext(diag: LatestDiagnosis | null): string {
  if (!diag) {
    return '';
  }

  const lines = [
    `Latest diagnosis at ${diag.updatedAt}:`,
    `- Overall strategy: ${diag.overallStrategy}`,
  ];

  for (const snapshot of diag.subjectSnapshots) {
    lines.push(
      `- ${snapshot.subject}: mastery ${snapshot.mastery}%, trend ${snapshot.recentTrend}, weaknesses ${snapshot.topWeaknesses.join(', ') || 'none'}`
    );
  }

  return lines.join('\n');
}

function profileContext(profile: StudentProfile | null): string {
  if (!profile) {
    return 'Student profile: first-year computer science student.\n';
  }

  return [
    `Student profile: ${profile.name}`,
    `- Level: ${profile.level}`,
    `- Goals: ${profile.goals.join(', ') || 'none'}`,
    `- Total exercises completed: ${profile.totalExercises}`,
  ].join('\n');
}

function serializeOutlineForRebuild(outline: CourseOutline): string {
  return JSON.stringify({
    title: outline.title,
    topics: outline.topics.map((topic) => ({
      id: topic.id,
      code: topic.code,
      title: topic.title,
      lessons: topic.lessons.map((lesson) => ({
        id: lesson.id,
        code: lesson.code,
        title: lesson.title,
        difficulty: lesson.difficulty,
      })),
    })),
  }, null, 2);
}

function buildOptionalRebuildInstruction(instruction?: string): string {
  const trimmed = String(instruction ?? '').trim();
  return trimmed || 'No extra user instruction.';
}

function exercisePersonalizationContext(ctx: PromptContext, difficulty: number, count: number): string {
  const lines = [
    `Generate ${count} exercises centered around difficulty ${difficulty}/5.`,
    'Personalize the set to the student instead of producing a generic worksheet.',
    'If the reference materials contain after-class exercises, review questions, worked examples, or end-of-chapter problems, borrow their distribution and style but do not copy wording.',
    'Keep the set progressive: foundational understanding first, then application, then synthesis when appropriate.',
  ];

  if (ctx.profile) {
    lines.push(`Adjust scaffolding and challenge for level ${ctx.profile.level}.`);
  }

  if (ctx.preferences) {
    lines.push(`Respect the learner pace ${ctx.preferences.pace.speed} and preferred session size ${ctx.preferences.pace.exercisesPerSession}.`);
  }

  const weaknesses = ctx.diagnosis?.subjectSnapshots.flatMap((snapshot) => snapshot.topWeaknesses).filter(Boolean) ?? [];
  if (weaknesses.length) {
    lines.push(`Prioritize these recent weak spots: ${Array.from(new Set(weaknesses)).slice(0, 5).join(', ')}.`);
  }

  return lines.map((line) => `- ${line}`).join('\n');
}

function buildSystemBase(ctx: PromptContext): string {
  const sections: string[] = [
    'You are a patient, rigorous university tutor helping a beginner-level computer science student.',
    profileContext(ctx.profile ?? null),
    preferencesContext(ctx.preferences ?? null),
    diagnosisContext(ctx.diagnosis ?? null),
  ].filter(Boolean);

  if (ctx.currentCourseTitle) {
    sections.push(`Current course title:\n${ctx.currentCourseTitle}`);
  }

  if (ctx.courseOutlineSummary) {
    sections.push(`Current course outline summary:\n${ctx.courseOutlineSummary}`);
  }

  if (ctx.selectedMaterialTitle) {
    sections.push(`Pinned reference material:\n${ctx.selectedMaterialTitle}`);
  }

  if (ctx.materialSummary) {
    sections.push(`Reference material summary:\n${ctx.materialSummary}`);
  }

  if (ctx.materialExerciseSummary) {
    sections.push(`Reference exercise summary:\n${ctx.materialExerciseSummary}`);
  }

  if (ctx.retrievedExcerpts) {
    sections.push(`Retrieved material excerpts:\n${ctx.retrievedExcerpts}`);
  }

  sections.push([
    'Markdown and math formatting rules:',
    '- Inline math must use $...$ on a single physical line.',
    '- Display math must use $$...$$ on its own lines.',
    '- Never output a standalone "=" line; merge "=" onto the previous formula line.',
    '- Never leave dangling "$" markers or broken math fences.',
  ].join('\n'));

  return sections.join('\n\n');
}

export function courseOutlinePrompt(subject: Subject, ctx: PromptContext): ChatMessage[] {
  return strictCourseOutlinePrompt(subject, ctx);
}

export function rebuildCourseOutlinePrompt(subject: Subject, currentOutline: CourseOutline, ctx: PromptContext): ChatMessage[] {
  return strictRebuildCourseOutlinePrompt(subject, currentOutline, ctx);
}

export function strictCourseOutlinePrompt(subject: Subject, ctx: PromptContext): ChatMessage[] {
  const subjectName = subjectLabel(subject);

  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nCreate a structured course outline for "${subjectName}" and return JSON only in this shape:
{
  "title": "课程标题",
  "topics": [
    {
      "title": "主题标题",
      "lessons": [
        { "title": "课时标题", "difficulty": 1 }
      ]
    }
  ]
}

Rules:
- Include 5 to 8 topics.
- Each topic should have 3 to 5 lessons.
- Course / topic / lesson titles must be concise Chinese only.
- Do not use formulas, LaTeX, English letters, digits, or punctuation in titles.
- Keep the structure progressive and coherent.
- Use lesson difficulty values from 1 to 5.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Generate the course outline JSON for "${subjectName}".`,
    },
  ];
}

export function strictRebuildCourseOutlinePrompt(subject: Subject, currentOutline: CourseOutline, ctx: PromptContext): ChatMessage[] {
  return strictFullRebuildCourseOutlinePrompt(subject, currentOutline, ctx);
}

export function strictFullRebuildCourseOutlinePrompt(
  subject: Subject,
  currentOutline: CourseOutline,
  ctx: PromptContext,
  instruction?: string,
): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const currentOutlineJson = serializeOutlineForRebuild(currentOutline);
  const userInstruction = buildOptionalRebuildInstruction(instruction);

  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nYou are generating a full course-outline rebuild for "${subjectName}".

Return pure JSON only in this exact shape:
{
  "title": "课程标题",
  "topics": [
    {
      "title": "主题标题",
      "lessons": [
        { "title": "课时标题", "difficulty": 1 }
      ]
    }
  ]
}

Rules:
- This is a full rebuild. Old outline artifacts can be cleared before apply.
- You may reorder, merge, split, or remove topics and lessons when needed.
- Course / topic / lesson titles must be concise Chinese only.
- Do not output formulas, LaTeX, English letters, digits, or punctuation in titles.
- Keep the progression coherent.
- Use lesson difficulty values from 1 to 5.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Current course title: ${currentOutline.title}

Current outline JSON:
${currentOutlineJson}

User instruction:
${userInstruction}

Generate the fully rebuilt course outline JSON now.`,
    },
  ];
}

export function strictPartialRebuildCourseOutlinePrompt(
  subject: Subject,
  currentOutline: CourseOutline,
  selection: OutlineRebuildSelection,
  ctx: PromptContext,
  instruction?: string,
): ChatMessage[] {
  const subjectName = subjectLabel(subject);
  const currentOutlineJson = serializeOutlineForRebuild(currentOutline);
  const selectedTopicsJson = JSON.stringify(
    currentOutline.topics.slice(selection.startIndex, selection.endIndex + 1).map((topic) => ({
      id: topic.id,
      code: topic.code,
      title: topic.title,
      lessons: topic.lessons.map((lesson) => ({
        id: lesson.id,
        code: lesson.code,
        title: lesson.title,
        difficulty: lesson.difficulty,
      })),
    })),
    null,
    2,
  );
  const userInstruction = buildOptionalRebuildInstruction(instruction);

  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nYou are rebuilding only a selected continuous topic range for "${subjectName}".

Return pure JSON only in this exact shape:
{
  "topics": [
    {
      "title": "主题标题",
      "lessons": [
        { "title": "课时标题", "difficulty": 1 }
      ]
    }
  ]
}

Rules:
- Return replacement topics only, not the full course outline.
- The course title must stay unchanged in partial mode.
- The replacement may be shorter or longer than the original selected range.
- Unselected topics before and after the range will be preserved by the app.
- Topic / lesson titles must be concise Chinese only.
- Do not output formulas, LaTeX, English letters, digits, or punctuation in titles.
- Use lesson difficulty values from 1 to 5.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Course title (must stay unchanged): ${currentOutline.title}

Selected range: topics ${selection.startIndex + 1} to ${selection.endIndex + 1}

Full current outline JSON:
${currentOutlineJson}

Selected topics to replace:
${selectedTopicsJson}

User instruction:
${userInstruction}

Generate only the replacement topics JSON now.`,
    },
  ];
}

export function lessonPrompt(subject: Subject, topicTitle: string, lessonTitle: string, difficulty: number, ctx: PromptContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nWrite a complete lecture note in Markdown.

Requirements:
- Start with a short "Key Ideas" section.
- Explain concepts progressively with intuition, worked examples, and short checks.
- End with a short "Next Practice" section.
- Use difficulty ${difficulty}/5 as the target depth.
- Keep Markdown clean and stable for local rendering.
- Never put "=" on a line by itself inside math; attach it to the previous formula line.`,
    },
    {
      role: 'user',
      content: `Write a lecture note for subject "${subjectLabel(subject)}", topic "${topicTitle}", lesson "${lessonTitle}".`,
    },
  ];
}

export function exercisePrompt(subject: Subject, lessonTitle: string, count: number, difficulty: number, ctx: PromptContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + '\n' + exercisePersonalizationContext(ctx, difficulty, count) + `\nReturn pure JSON only in this shape:
[
  {
    "id": "ex-01",
    "prompt": "question text",
    "type": "free-response",
    "difficulty": ${difficulty}
  }
]

Rules:
- Allowed types: free-response, multiple-choice, code.
- Generate exactly ${count} exercises.
- Keep difficulty centered around ${difficulty}/5.
- When material exercises are available, borrow structure and focus but do not copy.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Generate ${count} exercises for "${subjectLabel(subject)}" / "${lessonTitle}".`,
    },
  ];
}

export function gradePrompt(exercisePromptText: string, studentAnswer: string, ctx: PromptContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nGrade the student's answer and return JSON only in this shape:
{
  "score": 85,
  "feedback": "detailed markdown feedback",
  "strengths": ["point 1"],
  "weaknesses": ["point 1"]
}

Rules:
- Score must be from 0 to 100.
- Feedback should be actionable and specific.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Prompt:\n${exercisePromptText}\n\nStudent answer:\n${studentAnswer}`,
    },
  ];
}

export function diagnosisPrompt(
  subject: Subject,
  topicSummaries: string,
  recentGrades: string,
  ctx: PromptContext,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nAnalyze the student's learning status for "${subjectLabel(subject)}" and return JSON only in this shape:
{
  "subjectSnapshots": [
    {
      "subject": "subject-name",
      "mastery": 75,
      "recentTrend": "improving",
      "topStrengths": ["strength 1"],
      "topWeaknesses": ["weakness 1"],
      "keyMistakePatterns": ["pattern 1"],
      "recommendedFocus": "what to focus next"
    }
  ],
  "overallStrategy": "overall strategy",
  "nextSteps": ["next step 1"]
}

Rules:
- Base the diagnosis on the supplied data.
- Identify conceptual gaps, error patterns, and next priorities.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Topic summaries:\n${topicSummaries}\n\nRecent grades:\n${recentGrades}`,
    },
  ];
}

export function materialIndexPrompt(text: string, subject: Subject): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `Analyze the study material and return JSON only in this shape:
{
  "chapters": [
    {
      "title": "chapter title",
      "summary": "short summary",
      "keyPoints": ["point 1"],
      "topicMapping": ["possible course topic"]
    }
  ]
}

Keep the result concise and grounded in the provided material.`,
    },
    {
      role: 'user',
      content: `Subject: ${subjectLabel(subject)}\n\nMaterial text:\n${text.slice(0, 15000)}`,
    },
  ];
}

export function textbookChunkParsePrompt(
  text: string,
  subject: Subject,
  options?: { chunkIndex?: number; totalChunks?: number },
): ChatMessage[] {
  const chunkIndex = options?.chunkIndex ?? 1;
  const totalChunks = options?.totalChunks ?? 1;

  return [
    {
      role: 'system',
      content: `You are parsing OCR-like textbook text into structured JSON.

Return JSON only in this shape:
{
  "documentType": "textbook",
  "chapters": [
    {
      "chapterNumber": "1",
      "title": "chapter title",
      "summary": "summary",
      "keyPoints": ["point 1"],
      "topicMapping": ["possible topic"],
      "sectionNumbers": ["1.1"],
      "relatedExerciseTitles": ["exercise 1"]
    }
  ],
  "sectionMappings": [
    {
      "chapterNumber": "1",
      "chapterTitle": "chapter title",
      "sectionNumber": "1.1",
      "sectionTitle": "section title",
      "summary": "summary",
      "keyPoints": ["point 1"],
      "topicMapping": ["possible topic"],
      "anchorTerms": ["search term"],
      "relatedExerciseTitles": ["exercise 1"]
    }
  ],
  "exerciseMappings": [
    {
      "chapterNumber": "1",
      "chapterTitle": "chapter title",
      "sectionNumber": "1.1",
      "sectionTitle": "section title",
      "title": "exercise title",
      "exerciseType": "after-class exercise",
      "summary": "summary",
      "keyPoints": ["point 1"],
      "topicMapping": ["possible topic"],
      "anchorTerms": ["search term"],
      "relatedSections": ["1.1 section title"]
    }
  ]
}

Rules:
- Extract only what is supported by the current chunk.
- Keep chapter and section numbering faithful to the source.
- Output JSON only.`,
    },
    {
      role: 'user',
      content: `Subject: ${subjectLabel(subject)}\nChunk: ${chunkIndex}/${totalChunks}\n\nText:\n${text.slice(0, 12000)}`,
    },
  ];
}

export function chatPrompt(userMessage: string, history: ChatMessage[], ctx: PromptContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nYou are the student's learning copilot.

Rules:
- Prefer answers grounded in the current course outline and retrieved materials.
- If you infer beyond the supplied material, say so explicitly.
- Be clear, patient, and concrete.
- If you materially rely on a specific reference, mention it briefly at the end.`,
    },
    ...history,
    { role: 'user', content: userMessage },
  ];
}

export function reviseMarkdownPrompt(
  instruction: string,
  currentContent: string,
  targetLabel: string,
  ctx: PromptContext,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nYou are directly revising an existing lecture Markdown file.

Rules:
- Modify the current Markdown according to the user request.
- Return the full revised Markdown only.
- Do not add markdown fences.
- Preserve unrelated valid content unless the user clearly wants it changed.
- Keep the Markdown stable for local rendering.
- Never put "=" on a line by itself inside math.`,
    },
    {
      role: 'user',
      content: `Target lecture: ${targetLabel}

User request:
${instruction}

Current Markdown:
${currentContent}

Return the full revised Markdown only.`,
    },
  ];
}

export function reviseMarkdownPatchPrompt(
  instruction: string,
  targetLabel: string,
  documentOutline: string,
  relevantSections: string,
  ctx: PromptContext,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: buildSystemBase(ctx) + `\nYou are editing an existing lecture markdown file. To keep the response compact, return pure JSON only in this schema:
{
  "action": "replace_section" | "insert_after_section" | "insert_before_section" | "append_document",
  "targetHeading": "exact heading line from DOCUMENT OUTLINE, empty when action is append_document",
  "content": "markdown fragment"
}

Rules:
- Choose exactly one action.
- Prefer the smallest possible edit.
- For replace_section, content must include the full replacement section including its heading.
- For insert_after_section or insert_before_section, content must include only the fragment to insert.
- targetHeading must exactly match a heading line from DOCUMENT OUTLINE for section-based actions.
- Do not wrap JSON in code fences.
- Do not include any explanation outside the JSON.`,
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
