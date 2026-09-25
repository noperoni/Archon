/**
 * AskUserQuestion calls parked until a human answers them in the web UI.
 *
 * The Claude provider's prompt surface awaits `waitForAnswer`; the server's
 * answer route settles it with `answerQuestion`. Keyed by the tool_use id, which
 * the UI already holds from the `tool_call` event, and checked against the
 * conversation so one chat cannot answer another's question.
 *
 * ponytail: in-memory, so a server restart drops every pending question (the
 * turn dies with the restart anyway). Persist only if runs ever outlive it.
 */
import type { UserQuestion, UserQuestionAnswer } from '@archon/providers/types';

interface Pending {
  conversationId: string;
  input: Record<string, unknown>;
  settle: (answer: UserQuestionAnswer | null) => void;
}

const pending = new Map<string, Pending>();

export function waitForAnswer(
  conversationId: string,
  question: UserQuestion
): Promise<UserQuestionAnswer | null> {
  const { toolUseId, input, signal } = question;
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const onAbort = (): void => {
      settle(null);
    };
    const settle = (answer: UserQuestionAnswer | null): void => {
      pending.delete(toolUseId);
      signal.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.set(toolUseId, { conversationId, input, settle });
  });
}

/** False when nothing is pending under that id in this conversation. */
export function answerQuestion(
  conversationId: string,
  toolUseId: string,
  answer: UserQuestionAnswer | null
): boolean {
  const entry = pending.get(toolUseId);
  if (entry?.conversationId !== conversationId) return false;
  entry.settle(answer);
  return true;
}

/** Questions still waiting in this conversation, oldest first. */
export function listQuestions(
  conversationId: string
): { toolUseId: string; input: Record<string, unknown> }[] {
  return [...pending]
    .filter(([, p]) => p.conversationId === conversationId)
    .map(([toolUseId, p]) => ({ toolUseId, input: p.input }));
}
