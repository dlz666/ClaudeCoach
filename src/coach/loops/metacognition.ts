import { CoachAgent, CoachLoop } from '../coachAgent';
import { CoachEvent } from '../coachEventBus';

/**
 * Loop 4: Metacognition
 *
 * - onEvent('grade-submitted')：score ∈ [30, 80] → 推一条 metacog-question banner
 *   actions: [{ label: '记录反思', command: 'metacogAnswer', args }]
 */

export interface MetacognitionLoopDeps {
  agent: CoachAgent;
}

const SCORE_LOWER = 30;
const SCORE_UPPER = 80;

const QUESTIONS = [
  '你为什么想到这个方法？卡在哪一步了？',
  '换一种角度看，这道题考察的核心知识点是什么？',
  '如果把题目难度降一档，你会先走哪一步？',
];

function pickQuestion(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return QUESTIONS[h % QUESTIONS.length];
}

function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createMetacognitionLoop(deps: MetacognitionLoopDeps): CoachLoop {
  return {
    name: 'metacog',
    async onEvent(event: CoachEvent): Promise<void> {
      if (event.kind !== 'grade-submitted') {
        return;
      }
      try {
        const enabled = await deps.agent.isLoopEnabled('metacog');
        if (!enabled) {
          return;
        }
        const meta = (event.meta ?? {}) as { score?: number };
        const score = typeof meta.score === 'number' ? meta.score : NaN;
        if (!Number.isFinite(score) || score < SCORE_LOWER || score > SCORE_UPPER) {
          return;
        }

        const subject = event.subject;
        const topicId = event.topicId ?? '';
        const lessonId = event.lessonId ?? '';
        if (!subject || !lessonId) {
          return;
        }

        const dateKey = todayKey();
        const question = pickQuestion(`${subject}|${lessonId}|${dateKey}`);

        await deps.agent.pushSuggestion({
          dedupKey: `metacog-${subject}-${lessonId}-${dateKey}`,
          source: 'metacognition',
          channel: 'banner',
          urgency: 'low',
          status: 'preview',
          title: '想一想这一题',
          body: question,
          subject,
          topicId: topicId || undefined,
          lessonId,
          payload: {
            question,
            actionLabel: '记录反思',
            command: 'metacogAnswer',
            commandArgs: {
              subject,
              topicId,
              lessonId,
              question,
            },
          },
        } as unknown as Parameters<CoachAgent['pushSuggestion']>[0]);
      } catch (err) {
        console.error('[MetacognitionLoop] onEvent error:', err);
      }
    },
  };
}
