/**
 * HK-47 fork: what filled a conversation's context, and what the danger gate
 * stopped, for the window behind the chat's usage meter.
 *
 * Context per tool call is measured, not guessed: the growth in prompt size from
 * the step that issued the call to the step after its result, less the issuing
 * step's own output, shared across that step's parallel calls by result size.
 * A call with no measurable next step (the last one, or a gap that also holds a
 * typed prompt) falls back to four characters a token and is flagged.
 *
 * The gate's fate for each stop comes from its own trail: `first-sight`, then an
 * `answered` approve or refuse, then `stand-aside` when the approved retry ran.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolContext {
  tool: string;
  label: string;
  tokens: number;
  /** No measurable next step: sized from the result text instead. */
  estimated: boolean;
  ts: string;
}

export type GateOutcome =
  | 'ran after approval'
  | 'approved, not retried'
  | 'refused by Master'
  | 'refused: unrecoverable'
  | 'refused: no dialog in this mode'
  | 'awaiting an answer';

export interface GateStop {
  ts: string;
  rule: string;
  command: string;
  outcome: GateOutcome;
}

export interface ConversationBreakdown {
  byTool: { tool: string; tokens: number; calls: number }[];
  calls: ToolContext[];
  gate: GateStop[];
}

const CHARS_PER_TOKEN = 4;
const TOP_CALLS = 25;
const LABEL_CHARS = 140;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

interface Line {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface Step {
  context: number;
  output: number;
  toolIds: string[];
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  return blocks(content).reduce((n, b) => n + (typeof b.text === 'string' ? b.text.length : 0), 0);
}

/** What the call was about, as the terminal's trace would name it. */
function labelOf(input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const text =
    pick('command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill') ??
    Object.values(input).find((v): v is string => typeof v === 'string') ??
    '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS - 1)}…` : flat;
}

export function toolContext(transcriptText: string): Omit<ConversationBreakdown, 'gate'> {
  const steps: Step[] = [];
  const stepById = new Map<string, Step>();
  const calls = new Map<string, { tool: string; label: string; ts: string; step: number }>();
  const chars = new Map<string, number>();
  // Whether a typed prompt landed in the gap before each step: gapPrompt[i + 1]
  // covers the gap after step i.
  const gapPrompt: boolean[] = [false];

  for (const raw of transcriptText.split('\n')) {
    if (raw.length === 0) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue; // a line cut short by a write in progress
    }
    if (line.isSidechain === true || line.message === undefined) continue;
    const content = line.message.content;
    if (line.type === 'assistant') {
      const id = line.message.id ?? '';
      let step = stepById.get(id);
      if (step === undefined) {
        const u = line.message.usage ?? {};
        step = {
          context:
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0,
          toolIds: [],
        };
        stepById.set(id, step);
        steps.push(step);
        gapPrompt.push(false);
      }
      for (const b of blocks(content)) {
        if (b.type !== 'tool_use' || b.id === undefined) continue;
        const tool = b.name ?? 'tool';
        step.toolIds.push(b.id);
        calls.set(b.id, {
          tool,
          label: labelOf(b.input ?? {}),
          ts: line.timestamp ?? '',
          step: steps.length - 1,
        });
      }
    } else if (line.type === 'user') {
      const results = blocks(content).filter(b => b.type === 'tool_result');
      for (const b of results) {
        if (b.tool_use_id === undefined) continue;
        chars.set(b.tool_use_id, resultChars(b.content));
      }
      if (results.length === 0 && line.isMeta !== true) gapPrompt[gapPrompt.length - 1] = true;
    }
  }

  const tokens = new Map<string, { tokens: number; estimated: boolean }>();
  for (let i = 0; i < steps.length; i++) {
    const ids = steps[i].toolIds.filter(id => chars.has(id));
    if (ids.length === 0) continue;
    const next = steps[i + 1] as Step | undefined;
    const measurable = next !== undefined && !gapPrompt[i + 1];
    const grown = measurable ? next.context - steps[i].context - steps[i].output : -1;
    const total = ids.reduce((n, id) => n + (chars.get(id) ?? 0), 0);
    for (const id of ids) {
      const c = chars.get(id) ?? 0;
      if (grown >= 0) {
        const share = total > 0 ? c / total : 1 / ids.length;
        tokens.set(id, { tokens: Math.round(grown * share), estimated: false });
      } else {
        tokens.set(id, { tokens: Math.ceil(c / CHARS_PER_TOKEN), estimated: true });
      }
    }
  }

  const all: ToolContext[] = [];
  const byTool = new Map<string, { tokens: number; calls: number }>();
  for (const [id, call] of calls) {
    const t = tokens.get(id);
    if (t === undefined) continue; // no result yet: still running, or stopped
    all.push({ tool: call.tool, label: call.label, ts: call.ts, ...t });
    const agg = byTool.get(call.tool) ?? { tokens: 0, calls: 0 };
    agg.tokens += t.tokens;
    agg.calls += 1;
    byTool.set(call.tool, agg);
  }
  return {
    byTool: [...byTool].map(([tool, a]) => ({ tool, ...a })).sort((a, b) => b.tokens - a.tokens),
    calls: all.sort((a, b) => b.tokens - a.tokens).slice(0, TOP_CALLS),
  };
}

interface GateLine {
  t?: string;
  session?: string;
  verdict?: string;
  stage?: string | null;
  rule?: string;
  command?: string;
  segment?: string;
}

/** Every stop the gate made in this session, each with its fate. */
export function gateStops(logText: string, sessionId: string): GateStop[] {
  const stops = new Map<string, GateStop & { approved: boolean }>();
  for (const raw of logText.split('\n')) {
    if (raw.length === 0) continue;
    let e: GateLine;
    try {
      e = JSON.parse(raw) as GateLine;
    } catch {
      continue;
    }
    if (e.session !== sessionId) continue;
    const key = `${e.rule ?? ''}\u0000${e.segment ?? e.command ?? ''}`;
    const known = stops.get(key);
    const stage = e.stage ?? '';
    if (known === undefined) {
      if (stage === 'answered' || stage === 'stand-aside') continue; // stop predates the trail
      stops.set(key, {
        ts: e.t ?? '',
        rule: e.rule ?? '',
        command: e.command ?? '',
        approved: false,
        outcome:
          e.verdict === 'deny'
            ? 'refused: unrecoverable'
            : stage === 'mode-refused'
              ? 'refused: no dialog in this mode'
              : 'awaiting an answer',
      });
      continue;
    }
    if (stage === 'answered') {
      known.approved = e.verdict === 'approved';
      known.outcome = known.approved ? 'approved, not retried' : 'refused by Master';
    } else if (stage === 'stand-aside' && known.approved) {
      known.outcome = 'ran after approval';
    } else if (stage === 'master-refused') {
      known.outcome = 'refused by Master';
    }
  }
  return [...stops.values()].map(({ approved: _approved, ...s }) => s);
}

// Keyed by path; valid while the file's size is unchanged.
const cache = new Map<string, { size: number; value: unknown }>();

function cachedRead<T>(path: string, parse: (text: string) => T): T | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit?.size === size) return hit.value as T;
  const value = parse(readFileSync(path, 'utf8'));
  cache.set(path, { size, value });
  return value;
}

export function conversationBreakdown(
  transcript: string,
  sessionId: string,
  configDir: string
): ConversationBreakdown {
  const context = cachedRead(transcript, toolContext) ?? { byTool: [], calls: [] };
  const gateLog = cachedRead(join(configDir, 'hk47-danger-gate.log'), text => text);
  return { ...context, gate: gateLog === null ? [] : gateStops(gateLog, sessionId) };
}
