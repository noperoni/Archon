/**
 * HK-47 fork: one conversation's context and cost, for the chat's footer.
 *
 * Context is what the terminal's /context counts: the prompt the last main-line
 * call sent (input + cache read + cache write). Cost is every call in the
 * session's transcript plus its subagents' transcripts, at the notional API
 * prices the Metrics page uses, so a subscription session shows what it would
 * have cost, not what it did.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { costOf } from './pricing';
import { parseTranscript } from './transcript-index';

export interface ConversationUsage {
  sessionId: string;
  model: string | null;
  contextTokens: number;
  costUsd: number;
  /** Calls whose model has no price, left out of costUsd. */
  unpriced: number;
}

function files(transcript: string): string[] {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let subagents: string[] = [];
  try {
    subagents = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(dir, f));
  } catch {
    // No subagent ever ran in this session.
  }
  return [transcript, ...subagents];
}

// Keyed by transcript; valid while no file in the set has changed size.
const cache = new Map<string, { stamp: string; usage: ConversationUsage }>();

export function conversationUsage(transcript: string, sessionId: string): ConversationUsage {
  const paths = files(transcript);
  const stamp = paths.map(p => `${p}:${String(statSync(p).size)}`).join('|');
  const hit = cache.get(transcript);
  if (hit?.stamp === stamp) return hit.usage;

  let costUsd = 0;
  let unpriced = 0;
  let last: { ts: string; tokens: number; model: string } | null = null;
  for (const path of paths) {
    const { messages } = parseTranscript(readFileSync(path, 'utf8'));
    for (const m of messages) {
      const cost = costOf(m.model, m);
      if (cost === undefined) unpriced++;
      else costUsd += cost;
      if (path !== transcript || m.sidechain) continue;
      if (last === null || m.ts >= last.ts) {
        last = {
          ts: m.ts,
          tokens: m.input + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h,
          model: m.model,
        };
      }
    }
  }
  const usage: ConversationUsage = {
    sessionId,
    model: last?.model ?? null,
    contextTokens: last?.tokens ?? 0,
    costUsd,
    unpriced,
  };
  cache.set(transcript, { stamp, usage });
  return usage;
}
