import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * An incremental index over every Claude Code transcript on the machine
 * (PERS-14). Half a gigabyte of JSONL is too much to parse per request, so each
 * file is parsed once and again only when its size or mtime moves.
 *
 * Two traps shape the schema:
 * - Claude Code writes one line per content block and repeats the message's
 *   usage on each, so usage is keyed by message id, last line wins.
 * - A resumed or forked session copies its history into a new file, so the
 *   same message id appears in several files. Messages and prompts are unique
 *   across the whole index, not per file.
 *
 * The index is its own sqlite file and never touches Archon's database.
 */

const SCHEMA_VERSION = 1;

export interface TranscriptRoot {
  /** Config dir name without the dot, e.g. `claude-personal`. */
  account: string;
  /** The `projects` directory under that config dir. */
  projectsDir: string;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

interface Line {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { id?: string; model?: string; usage?: Usage; content?: unknown };
}

export interface ParsedMessage {
  msgId: string;
  session: string;
  ts: string;
  day: string;
  cwd: string;
  model: string;
  sidechain: boolean;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  webFetch: number;
  tools: string[];
}

export interface ParsedTurn {
  uuid: string;
  session: string;
  day: string;
  cwd: string;
}

/** Local calendar day, because Master's days are CEST days, not UTC ones. */
export function localDay(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isPrompt(line: Line): boolean {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return false;
  const content = line.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const blocks = content as { type?: string; text?: string }[];
  if (blocks.some(b => b.type === 'tool_result')) return false;
  return blocks.some(b => b.type === 'text' && (b.text ?? '').trim().length > 0);
}

export function parseTranscript(text: string): { messages: ParsedMessage[]; turns: ParsedTurn[] } {
  const messages = new Map<string, ParsedMessage>();
  const turns = new Map<string, ParsedTurn>();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue; // a torn final line while the session is still writing
    }
    if (!line.timestamp) continue;
    if (isPrompt(line) && line.uuid) {
      turns.set(line.uuid, {
        uuid: line.uuid,
        session: line.sessionId ?? '',
        day: localDay(line.timestamp),
        cwd: line.cwd ?? '',
      });
      continue;
    }
    const msg = line.message;
    if (line.type !== 'assistant' || !msg?.id || !msg.usage) continue;
    const u = msg.usage;
    const split = u.cache_creation;
    const prior = messages.get(msg.id);
    const tools = prior?.tools ?? [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as { type?: string; name?: string }[]) {
        if (block.type === 'tool_use' && block.name) tools.push(block.name);
      }
    }
    messages.set(msg.id, {
      msgId: msg.id,
      session: line.sessionId ?? '',
      ts: prior?.ts ?? line.timestamp,
      day: prior?.day ?? localDay(line.timestamp),
      cwd: line.cwd ?? '',
      model: msg.model ?? 'unknown',
      sidechain: Boolean(line.isSidechain),
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      // Older lines carry only the total; count it as the 5 minute write.
      cacheWrite5m: split
        ? (split.ephemeral_5m_input_tokens ?? 0)
        : (u.cache_creation_input_tokens ?? 0),
      cacheWrite1h: split?.ephemeral_1h_input_tokens ?? 0,
      webSearch: u.server_tool_use?.web_search_requests ?? 0,
      webFetch: u.server_tool_use?.web_fetch_requests ?? 0,
      tools,
    });
  }
  return { messages: [...messages.values()], turns: [...turns.values()] };
}

function walkJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(path, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path);
  }
}

export class TranscriptIndex {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'")
      .get();
    if (row?.value === String(SCHEMA_VERSION)) return;
    this.db.exec(`
      DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS msgs;
      DROP TABLE IF EXISTS tool_uses; DROP TABLE IF EXISTS turns;
      CREATE TABLE files (path TEXT PRIMARY KEY, account TEXT, size INTEGER, mtime INTEGER);
      CREATE TABLE msgs (
        msg_id TEXT PRIMARY KEY, file TEXT, session TEXT, ts TEXT, day TEXT, account TEXT,
        cwd TEXT, model TEXT, sidechain INTEGER, input INTEGER, output INTEGER, thinking INTEGER,
        cache_read INTEGER, cache_w5 INTEGER, cache_w1h INTEGER, web_search INTEGER, web_fetch INTEGER);
      CREATE INDEX msgs_day ON msgs(day); CREATE INDEX msgs_file ON msgs(file);
      CREATE TABLE tool_uses (msg_id TEXT, idx INTEGER, tool TEXT, PRIMARY KEY (msg_id, idx));
      CREATE TABLE turns (uuid TEXT PRIMARY KEY, file TEXT, session TEXT, day TEXT, account TEXT, cwd TEXT);
      CREATE INDEX turns_day ON turns(day); CREATE INDEX turns_file ON turns(file);
    `);
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", [
      String(SCHEMA_VERSION),
    ]);
  }

  private forget(path: string): void {
    this.db.run('DELETE FROM tool_uses WHERE msg_id IN (SELECT msg_id FROM msgs WHERE file = ?)', [
      path,
    ]);
    this.db.run('DELETE FROM msgs WHERE file = ?', [path]);
    this.db.run('DELETE FROM turns WHERE file = ?', [path]);
    this.db.run('DELETE FROM files WHERE path = ?', [path]);
  }

  private ingest(path: string, account: string, size: number, mtime: number): void {
    const { messages, turns } = parseTranscript(readFileSync(path, 'utf8'));
    const insertMsg = this.db.prepare(
      'INSERT OR IGNORE INTO msgs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const insertTool = this.db.prepare('INSERT OR IGNORE INTO tool_uses VALUES (?,?,?)');
    const insertTurn = this.db.prepare('INSERT OR IGNORE INTO turns VALUES (?,?,?,?,?,?)');
    this.db.transaction(() => {
      this.forget(path);
      for (const m of messages) {
        const inserted = insertMsg.run(
          m.msgId,
          path,
          m.session,
          m.ts,
          m.day,
          account,
          m.cwd,
          m.model,
          m.sidechain ? 1 : 0,
          m.input,
          m.output,
          m.thinking,
          m.cacheRead,
          m.cacheWrite5m,
          m.cacheWrite1h,
          m.webSearch,
          m.webFetch
        );
        // A message another file already owns keeps that file's tool rows.
        if (inserted.changes) m.tools.forEach((tool, i) => insertTool.run(m.msgId, i, tool));
      }
      for (const t of turns) insertTurn.run(t.uuid, path, t.session, t.day, account, t.cwd);
      this.db.run('INSERT INTO files VALUES (?,?,?,?)', [path, account, size, mtime]);
    })();
  }

  /** Bring the index up to date with the disk; returns how many files were (re)parsed. */
  refresh(roots: TranscriptRoot[]): number {
    const known = new Map(
      this.db
        .query<{ path: string; size: number; mtime: number }, []>(
          'SELECT path, size, mtime FROM files'
        )
        .all()
        .map(r => [r.path, r])
    );
    let parsed = 0;
    const seen = new Set<string>();
    for (const root of roots) {
      const files: string[] = [];
      walkJsonl(root.projectsDir, files);
      for (const path of files) {
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        seen.add(path);
        const mtime = Math.floor(st.mtimeMs);
        const prior = known.get(path);
        if (prior?.size === st.size && prior.mtime === mtime) continue;
        this.ingest(path, root.account, st.size, mtime);
        parsed++;
      }
    }
    for (const path of known.keys())
      if (!seen.has(path))
        this.db.transaction(() => {
          this.forget(path);
        })();
    return parsed;
  }

  fileCount(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files').get()?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

export function accountOfConfigDir(dir: string): string {
  return basename(dir).replace(/^\./, '');
}
