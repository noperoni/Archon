/**
 * Claude Code's own conversation transcripts for a project, as a terminal sees
 * them: `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`. HK47 fork
 * (PERS-18): lets a project's terminal conversations be resumed from the console,
 * read in place and never copied.
 */
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ClaudeTranscript {
  sessionId: string;
  title: string;
  /** File mtime, ISO 8601. */
  lastActivity: string;
  sizeBytes: number;
}

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Transcripts run to megabytes; the first prompt sits near the top, and the
// ai-title line is re-emitted all the way through, so the tail has the latest.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const TITLE_MAX = 80;

/**
 * The directory Claude Code keeps a project's transcripts in: every
 * non-alphanumeric character of the cwd becomes `-`.
 * ponytail: Claude Code hashes very long paths (200+ chars); none of Master's
 * projects come close, so that branch is not reproduced.
 */
export function claudeProjectDir(configDir: string, cwd: string): string {
  return join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Path of one session's transcript, or null for an id that is not a session uuid. */
export function claudeTranscriptPath(
  configDir: string,
  cwd: string,
  sessionId: string
): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  return join(claudeProjectDir(configDir, cwd), `${sessionId}.jsonl`);
}

async function readSlice(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Parse the whole lines of a slice; the partial ones at either edge fail and are skipped. */
function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // edge of the slice
    }
  }
  return out;
}

/** The first thing the user actually typed: not meta, not a command wrapper. */
function firstPrompt(lines: Record<string, unknown>[]): string | null {
  for (const line of lines) {
    if (line.type !== 'user' || line.isMeta === true || line.isSidechain === true) continue;
    const content = (line.message as { content?: unknown } | undefined)?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as { type?: string; text?: string }[]).find(p => p.type === 'text')?.text
          : undefined;
    if (text?.trim() && !text.trimStart().startsWith('<')) return text.trim();
  }
  return null;
}

function lastAiTitle(lines: Record<string, unknown>[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()) {
      return line.aiTitle.trim();
    }
  }
  return null;
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}...` : oneLine;
}

async function describe(path: string, sessionId: string): Promise<ClaudeTranscript | null> {
  const info = await stat(path);
  const head = parseLines(await readSlice(path, 0, HEAD_BYTES));
  const tail =
    info.size > HEAD_BYTES
      ? parseLines(await readSlice(path, Math.max(0, info.size - TAIL_BYTES), TAIL_BYTES))
      : head;
  const prompt = firstPrompt(head);
  const title = lastAiTitle(tail) ?? lastAiTitle(head) ?? (prompt ? clip(prompt) : null);
  // A file with neither is a session that never got a prompt: nothing to resume.
  if (!title) return null;
  return { sessionId, title, lastActivity: info.mtime.toISOString(), sizeBytes: info.size };
}

export interface TranscriptTurn {
  /** The transcript line's own uuid, stable across reads. */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO 8601. */
  timestamp: string;
}

/** The text a line carries, or null for tool traffic, meta and command wrappers. */
function turnText(line: Record<string, unknown>): string | null {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as { type?: string; text?: string }[])
            .filter(p => p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n')
        : '';
  if (!text.trim()) return null;
  if (line.type === 'user' && text.trimStart().startsWith('<')) return null;
  return text.trim();
}

const turnCache = new Map<string, TranscriptTurn[]>();
const TURN_CACHE_MAX = 32;

/**
 * The conversation a transcript held before `before`: the user's prompts and
 * the assistant's text, consecutive assistant lines merged into one turn.
 * Everything earlier than `before` is history the file will never rewrite, so
 * the result is cached per path and cut-off.
 * ponytail: FIFO cache of 32 cut-offs; a real LRU if many resumed conversations
 * are open at once.
 */
export async function readTranscriptTurns(path: string, before: Date): Promise<TranscriptTurn[]> {
  const key = `${path}|${before.toISOString()}`;
  const cached = turnCache.get(key);
  if (cached) return cached;

  const turns: TranscriptTurn[] = [];
  for (const line of parseLines(await readFile(path, 'utf8'))) {
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (line.isMeta === true || line.isSidechain === true) continue;
    const at = typeof line.timestamp === 'string' ? new Date(line.timestamp) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    if (at >= before) break;
    const text = turnText(line);
    if (text === null) continue;
    const role = line.type;
    const last = turns[turns.length - 1];
    if (role === 'assistant' && last?.role === 'assistant') {
      last.content += `\n\n${text}`;
      continue;
    }
    turns.push({
      id: typeof line.uuid === 'string' ? line.uuid : String(turns.length),
      role,
      content: text,
      timestamp: at.toISOString(),
    });
  }

  if (turnCache.size >= TURN_CACHE_MAX) {
    const oldest = turnCache.keys().next().value;
    if (oldest !== undefined) turnCache.delete(oldest);
  }
  turnCache.set(key, turns);
  return turns;
}

/** A project's transcripts, most recent first. Missing directory means none. */
export async function listClaudeTranscripts(
  configDir: string,
  cwd: string,
  limit = 100
): Promise<ClaudeTranscript[]> {
  const dir = claudeProjectDir(configDir, cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found = await Promise.all(
    names.map(async name => {
      const match = SESSION_FILE.exec(name);
      if (!match) return null;
      try {
        return await describe(join(dir, name), match[1]);
      } catch {
        return null;
      }
    })
  );
  return found
    .filter((t): t is ClaudeTranscript => t !== null)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, limit);
}
