import { requestJson } from '../lib/http';
import { toMessage, type Message } from '../primitives/message';

export async function listMessages(conversationId: string, limit = 500): Promise<Message[]> {
  const raw = await requestJson<Parameters<typeof toMessage>[0][]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit.toString()}`
  );
  return raw.map(toMessage);
}

/** HK-47 fork: a turn is running or queued, read from the server's lock. */
export async function isRunning(conversationId: string): Promise<boolean> {
  const res = await requestJson<{ running: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/running`
  );
  return res.running;
}

/** How often an open chat or live run page re-reads its pending questions. */
export const QUESTION_POLL_MS = 5000;

/** An AskUserQuestion call parked in a running turn, waiting on the user. */
export interface PendingQuestion {
  toolUseId: string;
  input: Record<string, unknown>;
  /** Asked by a workflow run this conversation launched, not by its own turn. */
  fromRun: boolean;
}

export async function listQuestions(conversationId: string): Promise<PendingQuestion[]> {
  return requestJson<PendingQuestion[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/questions`
  );
}

export async function answerQuestion(
  conversationId: string,
  toolUseId: string,
  answers: Record<string, string>
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(toolUseId)}/answer`,
    { method: 'POST', body: JSON.stringify({ answers }) }
  );
}

/** Refuse a pending question and end its turn, as the terminal's Esc does. */
export async function dismissQuestion(conversationId: string, toolUseId: string): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(toolUseId)}/dismiss`,
    { method: 'POST' }
  );
}

/** Context and notional cost of a conversation's Claude session (HK47 fork). */
export interface ConversationUsage {
  sessionId: string;
  model: string | null;
  contextTokens: number;
  costUsd: number;
  unpriced: number;
}

export async function getUsage(conversationId: string): Promise<ConversationUsage | null> {
  const res = await requestJson<{ usage: ConversationUsage | null }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/usage`
  );
  return res.usage;
}
