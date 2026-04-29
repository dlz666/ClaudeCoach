import {
  CourseFeedbackEvent,
  CourseProfile,
  CourseProfileChapter,
  CourseProfileOverall,
  CourseOutline,
  FeedbackStrengthTag,
  FeedbackWeaknessTag,
  GradeResult,
  RevisionPreferenceTag,
  Subject,
  TopicOutline,
} from '../types';
import { readJson, writeJson } from '../utils/fileSystem';
import { CourseManager } from '../courses/courseManager';
import { getStoragePathResolver } from '../storage/pathResolver';

const COURSE_PROFILE_VERSION = 1;
const MAX_RECENT_EVENTS = 20;

export interface CourseProfilePromptContext {
  courseProfile: CourseProfile | null;
  chapterProfile: CourseProfileChapter | null;
  profileEvidenceSummary: string;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function topItems<T extends string>(items: T[], limit: number): T[] {
  const counts = new Map<T, number>();
  items.forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([item]) => item);
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function normalizeWeaknessTags(tags?: FeedbackWeaknessTag[], fallbackTexts?: string[]): FeedbackWeaknessTag[] {
  const cleaned = (tags ?? []).filter(Boolean);
  if (cleaned.length) {
    return unique(cleaned);
  }
  return inferWeaknessTagsFromTexts(fallbackTexts ?? []);
}

function normalizeStrengthTags(tags?: FeedbackStrengthTag[], fallbackTexts?: string[]): FeedbackStrengthTag[] {
  const cleaned = (tags ?? []).filter(Boolean);
  if (cleaned.length) {
    return unique(cleaned);
  }
  return inferStrengthTagsFromTexts(fallbackTexts ?? []);
}

export function inferWeaknessTagsFromTexts(texts: string[]): FeedbackWeaknessTag[] {
  const blob = texts.join(' ').toLowerCase();
  const tags: FeedbackWeaknessTag[] = [];

  if (/(concept|definition|theorem|理解|概念|定理|公式|本质)/i.test(blob)) {
    tags.push('concept');
  }
  if (/(syntax|语法|拼写|括号|缩进|标点|格式)/i.test(blob)) {
    tags.push('syntax');
  }
  if (/(logic|推理|思路|条件判断|逻辑|证明链条)/i.test(blob)) {
    tags.push('logic');
  }
  if (/(edge|boundary|边界|特殊情况|漏判|极端情况)/i.test(blob)) {
    tags.push('edge-case');
  }
  if (/(complexity|复杂度|效率|性能|时间复杂度|空间复杂度)/i.test(blob)) {
    tags.push('complexity');
  }
  if (/(debug|调试|排错|定位|报错|traceback)/i.test(blob)) {
    tags.push('debugging');
  }

  return tags.length ? unique(tags) : (blob.trim() ? ['other'] : []);
}

export function inferStrengthTagsFromTexts(texts: string[]): FeedbackStrengthTag[] {
  const blob = texts.join(' ').toLowerCase();
  const tags: FeedbackStrengthTag[] = [];

  if (/(accurate|correct|正确|严谨|无误)/i.test(blob)) {
    tags.push('accuracy');
  }
  if (/(reasoning|推理|分析|论证|思路清晰)/i.test(blob)) {
    tags.push('reasoning');
  }
  if (/(clear|清晰|表达|解释到位|讲清楚)/i.test(blob)) {
    tags.push('clarity');
  }
  if (/(structure|结构|步骤完整|条理|组织)/i.test(blob)) {
    tags.push('structure');
  }
  if (/(apply|application|迁移|应用|举一反三)/i.test(blob)) {
    tags.push('application');
  }

  return tags.length ? unique(tags) : (blob.trim() ? ['other'] : []);
}

export function inferRevisionPreferenceTags(message: string): RevisionPreferenceTag[] {
  const normalized = message.toLowerCase();
  const tags: RevisionPreferenceTag[] = [];

  if (/(抽象|太理论|不直观|看不懂本质|先讲直觉|直观一点|通俗一点)/i.test(normalized)) {
    tags.push('too-abstract');
  }
  if (/(分步|一步一步|拆开讲|过程详细|展开一点|推导过程)/i.test(normalized)) {
    tags.push('needs-steps');
  }
  if (/(例子|举例|实例|样例|再来一个例题)/i.test(normalized)) {
    tags.push('needs-example');
  }
  if (/(太啰嗦|太长|精简|简洁一点|压缩)/i.test(normalized)) {
    tags.push('too-verbose');
  }
  if (/(太短|不够详细|展开|多讲一点|讲透)/i.test(normalized)) {
    tags.push('too-brief');
  }
  if (/(符号|记号|notation|字母太乱|公式看不懂)/i.test(normalized)) {
    tags.push('notation-confusing');
  }
  if (/(太快|跟不上|慢一点|别跳步)/i.test(normalized)) {
    tags.push('pace-too-fast');
  }
  if (/(太慢|直接一点|别铺垫太多|推进快一点)/i.test(normalized)) {
    tags.push('pace-too-slow');
  }

  return unique(tags);
}

export function normalizeGradeSignals(result: GradeResult): GradeResult {
  const strengths = Array.isArray(result.strengths) ? result.strengths.filter(Boolean) : [];
  const weaknesses = Array.isArray(result.weaknesses) ? result.weaknesses.filter(Boolean) : [];
  return {
    ...result,
    strengths,
    weaknesses,
    strengthTags: normalizeStrengthTags(result.strengthTags, strengths),
    weaknessTags: normalizeWeaknessTags(result.weaknessTags, weaknesses),
    confidence: result.confidence === 'low' || result.confidence === 'high' ? result.confidence : 'medium',
  };
}

function inferTopicStatus(
  topic: TopicOutline,
  gradeCount: number = 0,
): CourseProfileChapter['status'] {
  const lessons = topic.lessons ?? [];
  if (!lessons.length) {
    return 'not-started';
  }
  if (lessons.every((lesson) => lesson.status === 'completed')) {
    return 'completed';
  }
  if (lessons.some((lesson) => lesson.status === 'in-progress' || lesson.status === 'completed')) {
    return 'in-progress';
  }
  // P2-2: lesson 全 not-started 但学生已经做过题 → 实际是 in-progress
  // 让 status 反映学生反馈而不只是文件存在
  if (gradeCount > 0) {
    return 'in-progress';
  }
  return 'not-started';
}

function explanationStyles(preferences: RevisionPreferenceTag[]): string[] {
  const styles: string[] = [];
  if (preferences.includes('needs-example') || preferences.includes('too-abstract')) {
    styles.push('example-first');
  }
  if (preferences.includes('needs-steps') || preferences.includes('pace-too-fast')) {
    styles.push('step-by-step');
  }
  if (preferences.includes('notation-confusing')) {
    styles.push('notation-clarity');
  }
  if (preferences.includes('too-brief')) {
    styles.push('more-detail');
  }
  if (preferences.includes('too-verbose') || preferences.includes('pace-too-slow')) {
    styles.push('concise');
  }
  return styles;
}

function scaffoldingHints(
  preferences: RevisionPreferenceTag[],
  weaknesses: FeedbackWeaknessTag[],
): string[] {
  const hints: string[] = [];
  if (preferences.includes('needs-steps') || preferences.includes('pace-too-fast')) {
    hints.push('break solutions into explicit steps');
  }
  if (preferences.includes('needs-example') || preferences.includes('too-abstract')) {
    hints.push('start with an intuitive example before formalism');
  }
  if (preferences.includes('notation-confusing')) {
    hints.push('name symbols before using formulas');
  }
  if (weaknesses.includes('concept')) {
    hints.push('restate definitions and invariants before problem solving');
  }
  if (weaknesses.includes('logic')) {
    hints.push('surface the reasoning chain, not just the result');
  }
  if (weaknesses.includes('edge-case')) {
    hints.push('call out common edge cases explicitly');
  }
  if (weaknesses.includes('complexity')) {
    hints.push('explain cost tradeoffs alongside the method');
  }
  return unique(hints).slice(0, 4);
}

function responseHints(
  preferences: RevisionPreferenceTag[],
  weaknesses: FeedbackWeaknessTag[],
): string[] {
  const hints: string[] = [];
  if (preferences.includes('needs-steps')) {
    hints.push('answer with numbered steps when the task is procedural');
  }
  if (preferences.includes('needs-example') || preferences.includes('too-abstract')) {
    hints.push('include one concrete example before abstraction');
  }
  if (preferences.includes('notation-confusing')) {
    hints.push('keep notation stable and explain each symbol once');
  }
  if (preferences.includes('too-verbose')) {
    hints.push('prefer shorter answers unless the user asks for depth');
  }
  if (preferences.includes('too-brief')) {
    hints.push('do not skip intermediate reasoning');
  }
  if (weaknesses.includes('debugging')) {
    hints.push('highlight how to verify and debug the result');
  }
  return unique(hints).slice(0, 5);
}

function generationHints(
  preferences: RevisionPreferenceTag[],
  weaknesses: FeedbackWeaknessTag[],
): string[] {
  const hints: string[] = [];
  if (preferences.includes('needs-example') || preferences.includes('too-abstract')) {
    hints.push('add worked examples close to the main concept');
  }
  if (preferences.includes('needs-steps') || preferences.includes('pace-too-fast')) {
    hints.push('use smaller conceptual jumps between sections');
  }
  if (preferences.includes('too-brief')) {
    hints.push('expand rationale and transitions between concepts');
  }
  if (preferences.includes('too-verbose')) {
    hints.push('compress repetition and keep one main idea per block');
  }
  if (weaknesses.includes('concept')) {
    hints.push('front-load key definitions and common misconceptions');
  }
  if (weaknesses.includes('logic')) {
    hints.push('add explicit reasoning checkpoints');
  }
  return unique(hints).slice(0, 5);
}

export class CourseProfileStore {
  private readonly paths = getStoragePathResolver();
  private readonly courseManager = new CourseManager();

  private profilePath(subject: Subject): string {
    return this.paths.courseProfilePath(subject);
  }

  private emptyOverall(): CourseProfileOverall {
    return {
      learnerLevelEstimate: 'undetermined',
      preferredExplanationStyle: [],
      commonWeaknessTags: [],
      commonStrengthTags: [],
      stablePreferences: [],
      responseHints: [],
      generationHints: [],
    };
  }

  private emptyChapter(topic: TopicOutline): CourseProfileChapter {
    return {
      topicId: topic.id,
      chapterNumber: topic.chapterNumber,
      title: topic.title,
      status: inferTopicStatus(topic),
      masteryPercent: null,
      gradeCount: 0,
      lastStudiedAt: null,
      weaknessTags: [],
      strengthTags: [],
      misconceptions: [],
      preferredScaffolding: [],
      answeringHints: [],
    };
  }

  private buildEmptyProfile(subject: Subject, outline: CourseOutline | null): CourseProfile {
    return {
      schemaVersion: COURSE_PROFILE_VERSION,
      subject,
      courseTitle: outline?.title ?? subject,
      updatedAt: new Date().toISOString(),
      overall: this.emptyOverall(),
      chapters: (outline?.topics ?? []).map((topic) => this.emptyChapter(topic)),
      recentEvents: [],
    };
  }

  private normalizeProfile(subject: Subject, raw: CourseProfile | null, outline: CourseOutline | null): CourseProfile {
    const base = this.buildEmptyProfile(subject, outline);
    if (!raw) {
      return base;
    }

    const chapterMap = new Map((raw.chapters ?? []).map((chapter) => [chapter.topicId, chapter]));
    const chapters = (outline?.topics ?? []).map((topic) => {
      const existing = chapterMap.get(topic.id);
      return {
        ...this.emptyChapter(topic),
        ...existing,
        topicId: topic.id,
        chapterNumber: topic.chapterNumber,
        title: topic.title,
        status: inferTopicStatus(topic),
      };
    });

    return {
      ...base,
      ...raw,
      schemaVersion: COURSE_PROFILE_VERSION,
      subject,
      courseTitle: outline?.title ?? raw.courseTitle ?? subject,
      overall: {
        ...base.overall,
        ...(raw.overall ?? {}),
      },
      chapters,
      recentEvents: [...(raw.recentEvents ?? [])]
        .filter((event) => !!event?.id && !!event?.type)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, MAX_RECENT_EVENTS),
    };
  }

  private async backfillGradeEvents(profile: CourseProfile, outline: CourseOutline | null): Promise<CourseProfile> {
    if (!outline) {
      return profile;
    }

    const backfilled: CourseFeedbackEvent[] = [];
    for (const topic of outline.topics) {
      for (const lesson of topic.lessons) {
        const gradePath = this.courseManager.getGradePath(outline.subject, topic.id, lesson.id);
        const grade = normalizeGradeSignals((await readJson<GradeResult>(gradePath)) ?? {} as GradeResult);
        if (!grade.gradedAt || !Number.isFinite(Number(grade.score))) {
          continue;
        }
        backfilled.push({
          id: `grade-${lesson.id}-${grade.gradedAt}`,
          type: 'grade',
          subject: outline.subject,
          topicId: topic.id,
          lessonId: lesson.id,
          createdAt: grade.gradedAt,
          summary: compact(`Score ${grade.score}/100. Weaknesses: ${(grade.weaknesses ?? []).join(', ') || 'none'}.`, 160),
          weaknessTags: normalizeWeaknessTags(grade.weaknessTags, grade.weaknesses),
          strengthTags: normalizeStrengthTags(grade.strengthTags, grade.strengths),
          rawRefs: [gradePath],
          metadata: {
            score: grade.score,
            confidence: grade.confidence ?? 'medium',
          },
        });
      }
    }

    if (!backfilled.length) {
      return profile;
    }

    profile.recentEvents = [...backfilled, ...profile.recentEvents]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_RECENT_EVENTS);
    return this.applyAggregates(profile, outline);
  }

  private applyAggregates(profile: CourseProfile, outline: CourseOutline | null): CourseProfile {
    const chapters = (outline?.topics ?? []).map((topic) => {
      const existing = profile.chapters.find((chapter) => chapter.topicId === topic.id) ?? this.emptyChapter(topic);
      const events = profile.recentEvents.filter((event) => event.topicId === topic.id);
      const gradeEvents = events.filter((event) => event.type === 'grade');
      const scores = gradeEvents
        .map((event) => Number(event.metadata?.score))
        .filter((value) => Number.isFinite(value));
      const weaknessTags = topItems(
        events.flatMap((event) => event.weaknessTags ?? []),
        4,
      );
      const strengthTags = topItems(
        events.flatMap((event) => event.strengthTags ?? []),
        4,
      );
      const preferenceTags = topItems(
        events.flatMap((event) => event.preferenceTags ?? []),
        4,
      );
      const masteryAverage = average(scores);

      return {
        ...existing,
        topicId: topic.id,
        chapterNumber: topic.chapterNumber,
        title: topic.title,
        // P2-2: 把 gradeCount 传进去，让"做过题但 lesson 还没生成"也能显示 in-progress
        status: inferTopicStatus(topic, gradeEvents.length),
        gradeCount: gradeEvents.length,
        masteryPercent: scores.length >= 2 && masteryAverage !== null ? Math.round(masteryAverage) : null,
        lastStudiedAt: events[0]?.createdAt ?? null,
        weaknessTags,
        strengthTags,
        misconceptions: unique(
          events
            .filter((event) => event.weaknessTags.length > 0)
            .map((event) => compact(event.summary, 120))
            .filter(Boolean),
        ).slice(0, 3),
        preferredScaffolding: scaffoldingHints(preferenceTags, weaknessTags),
        answeringHints: responseHints(preferenceTags, weaknessTags),
      };
    });

    const allWeaknessTags = topItems(
      profile.recentEvents.flatMap((event) => event.weaknessTags ?? []),
      5,
    );
    const allStrengthTags = topItems(
      profile.recentEvents.flatMap((event) => event.strengthTags ?? []),
      5,
    );
    const allPreferenceTags = topItems(
      profile.recentEvents.flatMap((event) => event.preferenceTags ?? []),
      6,
    );
    const chapterMasteryValues = chapters
      .map((chapter) => chapter.masteryPercent)
      .filter((value): value is number => Number.isFinite(value));
    const overallMastery = average(chapterMasteryValues);
    const learnerLevelEstimate = overallMastery === null
      ? 'undetermined'
      : overallMastery < 60
        ? 'beginner'
        : overallMastery < 80
          ? 'developing'
          : 'intermediate';

    return {
      ...profile,
      courseTitle: outline?.title ?? profile.courseTitle,
      updatedAt: new Date().toISOString(),
      chapters,
      overall: {
        learnerLevelEstimate,
        preferredExplanationStyle: explanationStyles(allPreferenceTags),
        commonWeaknessTags: allWeaknessTags,
        commonStrengthTags: allStrengthTags,
        stablePreferences: allPreferenceTags,
        responseHints: responseHints(allPreferenceTags, allWeaknessTags),
        generationHints: generationHints(allPreferenceTags, allWeaknessTags),
      },
      recentEvents: [...profile.recentEvents]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, MAX_RECENT_EVENTS),
    };
  }

  private async saveProfile(subject: Subject, profile: CourseProfile): Promise<void> {
    await writeJson(this.profilePath(subject), profile);
  }

  async getProfile(subject: Subject): Promise<CourseProfile> {
    const outline = await this.courseManager.getCourseOutline(subject);
    const stored = await readJson<CourseProfile>(this.profilePath(subject));
    let profile = this.normalizeProfile(subject, stored, outline);

    if (!stored) {
      profile = await this.backfillGradeEvents(profile, outline);
      await this.saveProfile(subject, profile);
      return profile;
    }

    const next = this.applyAggregates(profile, outline);
    if (JSON.stringify(next) !== JSON.stringify(profile)) {
      await this.saveProfile(subject, next);
      return next;
    }
    return profile;
  }

  async recordEvent(subject: Subject, event: CourseFeedbackEvent): Promise<CourseProfile> {
    const outline = await this.courseManager.getCourseOutline(subject);
    const profile = await this.getProfile(subject);
    const next: CourseProfile = {
      ...profile,
      recentEvents: [event, ...profile.recentEvents]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, MAX_RECENT_EVENTS),
    };
    const aggregated = this.applyAggregates(next, outline);
    await this.saveProfile(subject, aggregated);
    return aggregated;
  }

  async buildPromptContext(subject?: Subject, topicId?: string): Promise<CourseProfilePromptContext> {
    if (!subject) {
      return {
        courseProfile: null,
        chapterProfile: null,
        profileEvidenceSummary: '',
      };
    }

    const profile = await this.getProfile(subject);
    const chapter = topicId
      ? profile.chapters.find((item) => item.topicId === topicId) ?? null
      : null;

    const lines: string[] = [
      `课程画像：${profile.courseTitle}`,
      `- 课程估计水平：${profile.overall.learnerLevelEstimate}`,
    ];

    if (profile.overall.commonWeaknessTags.length) {
      lines.push(`- 常见薄弱点：${profile.overall.commonWeaknessTags.join('、')}`);
    }
    if (profile.overall.commonStrengthTags.length) {
      lines.push(`- 常见优势：${profile.overall.commonStrengthTags.join('、')}`);
    }
    if (profile.overall.preferredExplanationStyle.length) {
      lines.push(`- 偏好讲解风格：${profile.overall.preferredExplanationStyle.join('、')}`);
    }
    if (profile.overall.stablePreferences.length) {
      lines.push(`- 稳定偏好信号：${profile.overall.stablePreferences.join('、')}`);
    }

    if (chapter) {
      lines.push(`- 当前章节：${chapter.title}（状态 ${chapter.status}）`);
      if (chapter.masteryPercent !== null) {
        lines.push(`- 当前章节掌握度：${chapter.masteryPercent}%`);
      }
      if (chapter.weaknessTags.length) {
        lines.push(`- 当前章节薄弱点：${chapter.weaknessTags.join('、')}`);
      }
      if (chapter.preferredScaffolding.length) {
        lines.push(`- 当前章节脚手架偏好：${chapter.preferredScaffolding.join('、')}`);
      }
    }

    const relevantEvents = profile.recentEvents
      .filter((event) => !topicId || !event.topicId || event.topicId === topicId)
      .slice(0, 3);

    if (relevantEvents.length) {
      lines.push('- 近期反馈摘要：');
      relevantEvents.forEach((event) => {
        lines.push(`  - [${event.type}] ${compact(event.summary, 120)}`);
      });
    }

    return {
      courseProfile: profile,
      chapterProfile: chapter,
      profileEvidenceSummary: compact(lines.join('\n'), 1800),
    };
  }
}
