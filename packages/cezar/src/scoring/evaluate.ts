import type { Scorer } from '../factory/scorers.ts';
import type { JudgeTranscript } from './transcript.ts';
import { judgeRubric, validateJudgeReply, type JudgeVerdict } from './verdict.ts';

export const JUDGE_TIMEOUT_MS = 180_000;
export const JUDGE_OUTAGE_RETRY_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export type JudgeCall = (input: { systemPrompt: string; userPrompt: string; timeoutMs: number }) =>
  Promise<{ text: string } | { unavailable: true } | { timedOut: true }>;

export type JudgeEvaluation =
  | { status: 'scored'; verdict: JudgeVerdict; transcriptChars: number; shortened: boolean }
  | { status: 'unavailable' }
  | { status: 'error'; reason: string };

export async function evaluateScorer(scorer: Scorer, transcript: JudgeTranscript, call: JudgeCall): Promise<JudgeEvaluation> {
  if ('error' in transcript) return { status: 'error', reason: transcript.error };
  const rubric = judgeRubric(scorer);
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const systemPrompt = attempt === 0 ? rubric : `${rubric}\n\nThe previous reply was rejected: ${reason}`;
    const response = await call({ systemPrompt, userPrompt: transcript.text, timeoutMs: JUDGE_TIMEOUT_MS });
    if ('unavailable' in response) return { status: 'unavailable' };
    if ('timedOut' in response) {
      reason = 'The judge exceeded the reply timeout.';
      continue;
    }
    const verdict = validateJudgeReply(response.text, scorer, transcript.text);
    if ('error' in verdict) {
      reason = verdict.error;
      continue;
    }
    return { status: 'scored', verdict, transcriptChars: transcript.text.length, shortened: transcript.shortened };
  }
  return { status: 'error', reason };
}
