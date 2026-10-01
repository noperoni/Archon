/**
 * HK-47 fork, PERS-30 F11: a click before the model's own commands act.
 *
 * The model can start workflows, register projects and decide human gates by
 * emitting /invoke-workflow or /register-project, or by calling manage_run.
 * Text it reads (a README, an issue, a page) can ask it to, so none of these
 * may run on the model's word alone. Each goes to the human as an Allow/Deny
 * card over the console's parked-question channel, with the whole payload in
 * the preview, and runs only on an explicit Allow. Dismissal, abort, free text
 * and the absence of a channel (every platform but web) all refuse.
 */
import { randomUUID } from 'crypto';
import type { AgentRequestOptions } from '@archon/providers/types';

export type AskHuman = AgentRequestOptions['onUserQuestion'];

const ALLOW = 'Allow';
const DENY = 'Deny';

export async function confirmWithHuman(
  ask: AskHuman,
  question: string,
  detail: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  if (ask === undefined) return false;
  const preview = JSON.stringify(detail, null, 2);
  // Unanswered cards end when the user dismisses them or sends a new message
  // (the console dismisses open questions on send), so no signal is needed to
  // free the conversation lock; one is passed where the turn has it.
  const answer = await ask({
    toolUseId: `confirm-${randomUUID()}`,
    input: {
      questions: [
        {
          question,
          header: 'Confirm',
          multiSelect: false,
          options: [
            { label: ALLOW, description: 'Run it once.', preview },
            { label: DENY, description: 'Refuse it; nothing runs.', preview },
          ],
        },
      ],
    },
    signal: signal ?? new AbortController().signal,
  }).catch(() => null);
  return answer?.answers[question] === ALLOW;
}
