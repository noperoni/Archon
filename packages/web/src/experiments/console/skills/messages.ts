import { requestJson } from '../lib/http';
import { toMessage, type Message } from '../primitives/message';

export async function listMessages(conversationId: string, limit = 500): Promise<Message[]> {
  const raw = await requestJson<Parameters<typeof toMessage>[0][]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit.toString()}`
  );
  return raw.map(toMessage);
}

/** An AskUserQuestion call parked in a running turn, waiting on the user. */
export interface PendingQuestion {
  toolUseId: string;
  input: Record<string, unknown>;
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
