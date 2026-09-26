/**
 * AskUserQuestion calls parked until a human answers them in the web UI.
 *
 * The Claude provider's prompt surface awaits `waitForAnswer`; the server's
 * answer route settles it with `answerQuestion`. Keyed by the tool_use id, which
 * the UI already holds from the `tool_call` event, and checked against the
 * conversation so one chat cannot answer another's question. A workflow run's
 * question also shows in the chat that launched the run (`parentConversationId`),
 * and either may answer it.
 *
 * ponytail: in-memory, so a server restart drops every pending question (the
 * turn dies with the restart anyway). Persist only if runs ever outlive it.
 */
import type { UserQuestion, UserQuestionAnswer } from '@archon/providers/types';

interface Pending {
  conversationId: string;
  parentConversationId?: string;
  input: Record<string, unknown>;
  settle: (answer: UserQuestionAnswer | null) => void;
}

const pending = new Map<string, Pending>();

export function waitForAnswer(
  conversationId: string,
  question: UserQuestion,
  parentConversationId?: string
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
    pending.set(toolUseId, { conversationId, parentConversationId, input, settle });
  });
}

/** False when nothing is pending under that id in this conversation. */
export function answerQuestion(
  conversationId: string,
  toolUseId: string,
  answer: UserQuestionAnswer | null
): boolean {
  const entry = pending.get(toolUseId);
  if (entry === undefined || !visibleIn(entry, conversationId)) return false;
  entry.settle(answer);
  return true;
}

function visibleIn(entry: Pending, conversationId: string): boolean {
  return entry.conversationId === conversationId || entry.parentConversationId === conversationId;
}

/**
 * Questions still waiting in this conversation, oldest first. `fromRun` marks
 * one asked by a workflow run this conversation launched.
 */
export function listQuestions(
  conversationId: string
): { toolUseId: string; input: Record<string, unknown>; fromRun: boolean }[] {
  return [...pending]
    .filter(([, p]) => visibleIn(p, conversationId))
    .map(([toolUseId, p]) => ({
      toolUseId,
      input: p.input,
      fromRun: p.conversationId !== conversationId,
    }));
}
