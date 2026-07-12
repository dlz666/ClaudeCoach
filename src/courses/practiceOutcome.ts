import { Exercise, GradeResult, Subject, WrongQuestion } from '../types';
import { CourseManager } from './courseManager';

interface PracticeOutcomeMeta {
  topicTitle?: string;
  lessonTitle?: string;
  lessonId?: string;
}

export async function recordPracticeOutcome(
  courseManager: CourseManager,
  exercise: Exercise,
  studentAnswer: string,
  subject: Subject,
  topicId: string,
  sessionId: string,
  gradeResult: GradeResult,
  meta?: PracticeOutcomeMeta,
): Promise<void> {
  const lessonId = meta?.lessonId ?? sessionId;
  const topicTitle = meta?.topicTitle ?? topicId;
  const lessonTitle = meta?.lessonTitle ?? sessionId;
  const wrongId = `wrong-${subject}-${topicId}-${sessionId}-${exercise.id}`;
  const sourceWrongQuestionId = exercise.sourceWrongQuestionIds?.[0];
  const identity = exercise.generationId ? `${wrongId}-${exercise.generationId}` : wrongId;
  const score = Number(gradeResult.score) || 0;
  const weaknesses = gradeResult.weaknesses ?? [];
  const usedHints = Math.max(0, Number(gradeResult.hintsUsed) || 0);
  let inferredExistingId: string | undefined;

  // Backwards compatibility for exercises created before source lineage existed:
  // an 80-89 result should keep a matching unresolved item scheduled.
  if (!sourceWrongQuestionId && score >= 80 && score < 90) {
    const unresolved = await courseManager.listWrongQuestions(subject, {
      topicId,
      lessonId,
      onlyUnresolved: true,
    });
    inferredExistingId = unresolved.find((question) =>
      question.id === identity
      || (!!exercise.generationId
        && question.generationId === exercise.generationId
        && question.exerciseId === exercise.id)
    )?.id;
  }
  const reviewSourceId = sourceWrongQuestionId ?? inferredExistingId;
  // New work is added to the review queue only when mastery is genuinely weak.
  // A review item needs >=90 to count as a successful retrieval; 80-89 keeps it
  // scheduled without treating minor AI feedback as a brand-new wrong answer.
  const isWrong = score < 80 || (!!reviewSourceId && (score < 90 || usedHints > 0));

  if (isWrong) {
    const gradedAtMs = Date.parse(gradeResult.gradedAt);
    const reviewBaseMs = Number.isFinite(gradedAtMs) ? gradedAtMs : Date.now();
    const difficulty = Math.max(1, Math.min(5, Math.round(Number(exercise.difficulty) || 3)));
    const reviewIntervalDays = score < 50 || difficulty >= 4 ? 1 : 2;
    const nextReviewAt = new Date(reviewBaseMs + reviewIntervalDays * 24 * 60 * 60 * 1000).toISOString();
    const question: WrongQuestion = {
      id: reviewSourceId ?? identity,
      exerciseId: exercise.id,
      subject,
      topicId,
      topicTitle,
      lessonId,
      lessonTitle,
      prompt: exercise.prompt,
      studentAnswer,
      score,
      feedback: gradeResult.feedback,
      weaknesses,
      weaknessTags: gradeResult.weaknessTags ?? [],
      attempts: 1,
      firstFailedAt: gradeResult.gradedAt,
      lastAttemptedAt: gradeResult.gradedAt,
      resolved: false,
      generationId: exercise.generationId,
      sourceWrongQuestionId: reviewSourceId,
      reviewIntervalDays,
      nextReviewAt,
      successfulReviews: 0,
      difficulty,
    };
    await courseManager.upsertWrongQuestion(subject, question);
    return;
  }

  if (score < 90) return;

  const existing = await courseManager.listWrongQuestions(subject, {
    topicId,
    lessonId,
    onlyUnresolved: true,
  });
  const match = sourceWrongQuestionId
    ? existing.find((question) => question.id === sourceWrongQuestionId)
    : existing.find((question) =>
        question.id === identity
        || (!!exercise.generationId
          && question.generationId === exercise.generationId
          && question.exerciseId === exercise.id)
      );
  if (match) {
    await courseManager.recordSuccessfulWrongQuestionReview(subject, match.id, score);
  }
}
