import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { costOf, normaliseModel, type TokenCounts } from './pricing';
import { localDay, TranscriptIndex, type TranscriptRoot } from './transcript-index';

/**
 * Everything the console's Metrics page charts (PERS-14), aggregated from five
 * sources: Claude Code transcripts (through the incremental index), Archon's
 * own sessions and workflow runs, the HK-47 danger gate logs, and the HK-47
 * queue. Every source is read, none is written.
 */

export const RANGES = ['7', '30', '90', 'all'] as const;
export type Range = (typeof RANGES)[number];

const TOP = 12;
const OTHER = 'Other';

export interface ArchonSources {
  /** assistant_session_id of every session Archon has driven. */
  consoleSessions(): Promise<Set<string>>;
  workflowRuns(): Promise<WorkflowRunRow[]>;
  workflowEvents(): Promise<WorkflowEventRow[]>;
}

export interface WorkflowRunRow {
  id: string;
  workflow_name: string;
  status: string;
  started_at: string | Date;
  completed_at: string | Date | null;
}

export interface WorkflowEventRow {
  workflow_run_id: string;
  event_type: string;
  data: unknown;
}

export interface MetricsConfig {
  /** Config dirs, e.g. ~/.claude-personal; transcripts live in <dir>/projects. */
  configDirs: string[];
  queueDir: string;
  archon: ArchonSources;
  index: TranscriptIndex;
  /** Injected for tests; defaults to now. */
  today?: string;
}

export function defaultConfigDirs(): string[] {
  const home = homedir();
  return ['.claude-personal', '.claude-work', '.claude']
    .map(d => join(home, d))
    .filter(d => existsSync(d));
}

export function defaultQueueDir(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(state, 'hk47', 'queue');
}

function accountOf(dir: string): string {
  return basename(dir).replace(/^\./, '');
}

export function sinceDay(range: Range, today: string): string | null {
  if (range === 'all') return null;
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - (Number(range) - 1));
  return localDay(d.toISOString());
}

const projectNames = new Map<string, string>();

/** PROJECT.json name, falling back to the directory, as the rest of HK-47 does. */
export function projectOf(cwd: string): string {
  if (!cwd) return 'unknown';
  const cached = projectNames.get(cwd);
  if (cached) return cached;
  let name = basename(cwd) || cwd;
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, '.claude', 'PROJECT.json'), 'utf8')) as {
      project?: { name?: string };
    };
    if (parsed.project?.name) name = parsed.project.name;
  } catch {
    // no PROJECT.json: the directory name stands
  }
  projectNames.set(cwd, name);
  return name;
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // torn line
    }
  }
  return out;
}

/** Log fields are untyped JSON; anything but a string reads as empty. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date
    ? v.toISOString()
    : new Date(v.replace(' ', 'T') + (v.includes('Z') ? '' : 'Z')).toISOString();
}

function topN<T extends { tokens: number }>(rows: T[], key: keyof T, n = TOP): T[] {
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n - 1);
  const rest = sorted.slice(n - 1);
  const other = rest.reduce(
    (acc, r) => {
      for (const [k, v] of Object.entries(r))
        if (typeof v === 'number')
          (acc as Record<string, number>)[k] = ((acc as Record<string, number>)[k] ?? 0) + v;
      return acc;
    },
    { [key]: OTHER } as unknown as T
  );
  return [...head, other];
}

interface Group extends TokenCounts {
  day: string;
  cwd: string;
  account: string;
  model: string;
  sidechain: number;
  session: string;
  messages: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
}

export interface MetricsReport {
  range: Range;
  account: string | null;
  since: string | null;
  today: string;
  indexedFiles: number;
  reparsedFiles: number;
  accounts: string[];
  unpricedModels: string[];
  totals: {
    tokens: number;
    input: number;
    output: number;
    thinking: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    messages: number;
    sessions: number;
    turns: number;
    cacheHitRatio: number;
    webSearches: number;
    webFetches: number;
    workflowRuns: number;
    gateStops: number;
    queueWaits: number;
  };
  daily: {
    day: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    costUsd: number;
    sessions: number;
    turns: number;
    cacheHitRatio: number;
  }[];
  byProject: { project: string; tokens: number; costUsd: number; sessions: number }[];
  byModel: { model: string; tokens: number; costUsd: number; messages: number }[];
  byAccount: { account: string; tokens: number; costUsd: number; sessions: number }[];
  byOrigin: { origin: string; tokens: number; sessions: number }[];
  bySidechain: { kind: string; tokens: number; messages: number }[];
  tools: { tool: string; calls: number }[];
  workflows: {
    runs: {
      id: string;
      name: string;
      status: string;
      startedAt: string;
      durationMs: number | null;
      costUsd: number;
      tokens: number;
    }[];
    byStatus: { status: string; count: number }[];
  };
  gate: {
    daily: { day: string; verdict: string; count: number }[];
    rules: { rule: string; count: number }[];
  };
  queue: {
    daily: { day: string; flag: string; count: number }[];
    picks: number;
    pickedAtHead: number;
  };
}

function tokensOf(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

export async function buildMetrics(
  cfg: MetricsConfig,
  range: Range,
  account: string | null
): Promise<MetricsReport> {
  const today = cfg.today ?? localDay(new Date().toISOString());
  const since = sinceDay(range, today);
  const roots: TranscriptRoot[] = cfg.configDirs.map(d => ({
    account: accountOf(d),
    projectsDir: join(d, 'projects'),
  }));
  const reparsedFiles = cfg.index.refresh(roots);

  const where = ['1=1'];
  const params: string[] = [];
  if (since) {
    where.push('day >= ?');
    params.push(since);
  }
  if (account) {
    where.push('account = ?');
    params.push(account);
  }
  const filter = where.join(' AND ');

  const groups = cfg.index.db
    .query<Group, string[]>(
      `SELECT day, cwd, account, model, sidechain, session, COUNT(*) AS messages,
        SUM(input) AS input, SUM(output) AS output, SUM(thinking) AS thinking, SUM(cache_read) AS cacheRead,
        SUM(cache_w5) AS cacheWrite5m, SUM(cache_w1h) AS cacheWrite1h,
        SUM(web_search) AS webSearch, SUM(web_fetch) AS webFetch
       FROM msgs WHERE ${filter} GROUP BY day, cwd, account, model, sidechain, session`
    )
    .all(...params);
  const turnRows = cfg.index.db
    .query<
      { day: string; session: string; n: number },
      string[]
    >(`SELECT day, session, COUNT(*) AS n FROM turns WHERE ${filter} GROUP BY day, session`)
    .all(...params);
  const toolRows = cfg.index.db
    .query<{ tool: string; calls: number }, string[]>(
      `SELECT t.tool AS tool, COUNT(*) AS calls FROM tool_uses t JOIN msgs m ON m.msg_id = t.msg_id
       WHERE ${filter.replaceAll('day', 'm.day').replaceAll('account', 'm.account')}
       GROUP BY t.tool ORDER BY calls DESC LIMIT ${TOP}`
    )
    .all(...params);
  const accounts = cfg.index.db
    .query<{ account: string }, []>('SELECT DISTINCT account FROM files ORDER BY account')
    .all()
    .map(r => r.account);

  const consoleSessions = await cfg.archon.consoleSessions();
  const unpriced = new Set<string>();

  const daily = new Map<string, MetricsReport['daily'][number] & { sessionSet: Set<string> }>();
  const projects = new Map<
    string,
    { project: string; tokens: number; costUsd: number; sessionSet: Set<string> }
  >();
  const models = new Map<string, MetricsReport['byModel'][number]>();
  const accts = new Map<
    string,
    { account: string; tokens: number; costUsd: number; sessionSet: Set<string> }
  >();
  const origins = new Map<string, { origin: string; tokens: number; sessionSet: Set<string> }>();
  const sidechains = new Map<string, MetricsReport['bySidechain'][number]>();
  const totals = {
    tokens: 0,
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    messages: 0,
    sessions: 0,
    turns: 0,
    cacheHitRatio: 0,
    webSearches: 0,
    webFetches: 0,
    workflowRuns: 0,
    gateStops: 0,
    queueWaits: 0,
  };
  const allSessions = new Set<string>();

  for (const g of groups) {
    const tokens = tokensOf(g);
    const cost = costOf(g.model, g);
    if (cost === undefined && tokens > 0) unpriced.add(normaliseModel(g.model));
    const usd = cost ?? 0;
    const project = projectOf(g.cwd);
    const origin = consoleSessions.has(g.session) ? 'console' : 'terminal';
    allSessions.add(g.session);

    const d = daily.get(g.day) ?? {
      day: g.day,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      costUsd: 0,
      sessions: 0,
      turns: 0,
      cacheHitRatio: 0,
      sessionSet: new Set<string>(),
    };
    d.input += g.input;
    d.output += g.output;
    d.cacheRead += g.cacheRead;
    d.cacheWrite5m += g.cacheWrite5m;
    d.cacheWrite1h += g.cacheWrite1h;
    d.costUsd += usd;
    d.sessionSet.add(g.session);
    daily.set(g.day, d);

    const p = projects.get(project) ?? {
      project,
      tokens: 0,
      costUsd: 0,
      sessionSet: new Set<string>(),
    };
    p.tokens += tokens;
    p.costUsd += usd;
    p.sessionSet.add(g.session);
    projects.set(project, p);

    const modelKey = normaliseModel(g.model);
    const m = models.get(modelKey) ?? { model: modelKey, tokens: 0, costUsd: 0, messages: 0 };
    m.tokens += tokens;
    m.costUsd += usd;
    m.messages += g.messages;
    models.set(modelKey, m);

    const a = accts.get(g.account) ?? {
      account: g.account,
      tokens: 0,
      costUsd: 0,
      sessionSet: new Set<string>(),
    };
    a.tokens += tokens;
    a.costUsd += usd;
    a.sessionSet.add(g.session);
    accts.set(g.account, a);

    const o = origins.get(origin) ?? { origin, tokens: 0, sessionSet: new Set<string>() };
    o.tokens += tokens;
    o.sessionSet.add(g.session);
    origins.set(origin, o);

    const kind = g.sidechain ? 'subagent' : 'main';
    const s = sidechains.get(kind) ?? { kind, tokens: 0, messages: 0 };
    s.tokens += tokens;
    s.messages += g.messages;
    sidechains.set(kind, s);

    totals.tokens += tokens;
    totals.input += g.input;
    totals.output += g.output;
    totals.thinking += g.thinking;
    totals.cacheRead += g.cacheRead;
    totals.cacheWrite += g.cacheWrite5m + g.cacheWrite1h;
    totals.costUsd += usd;
    totals.messages += g.messages;
    totals.webSearches += g.webSearch;
    totals.webFetches += g.webFetch;
  }
  for (const t of turnRows) {
    totals.turns += t.n;
    const d = daily.get(t.day);
    if (d) d.turns += t.n;
  }
  totals.sessions = allSessions.size;
  const promptInput = totals.input + totals.cacheRead + totals.cacheWrite;
  totals.cacheHitRatio = promptInput ? totals.cacheRead / promptInput : 0;

  // --- Archon workflows -------------------------------------------------------
  const runs = await cfg.archon.workflowRuns();
  const events = await cfg.archon.workflowEvents();
  const perRun = new Map<string, { costUsd: number; tokens: number }>();
  for (const e of events) {
    if (e.event_type !== 'node_completed') continue;
    const data = (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as {
      cost_usd?: number;
      tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    };
    const r = perRun.get(e.workflow_run_id) ?? { costUsd: 0, tokens: 0 };
    r.costUsd += data.cost_usd ?? 0;
    const t = data.tokens ?? {};
    r.tokens += (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
    perRun.set(e.workflow_run_id, r);
  }
  const runList = runs
    .map(r => {
      const startedAt = toIso(r.started_at) ?? '';
      const completedAt = toIso(r.completed_at);
      return {
        id: r.id,
        name: r.workflow_name,
        status: r.status,
        startedAt,
        durationMs: completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null,
        costUsd: perRun.get(r.id)?.costUsd ?? 0,
        tokens: perRun.get(r.id)?.tokens ?? 0,
      };
    })
    .filter(r => !since || localDay(r.startedAt) >= since)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const statusCounts = new Map<string, number>();
  for (const r of runList) statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  totals.workflowRuns = runList.length;

  // --- danger gate --------------------------------------------------------------
  const gateDaily = new Map<string, number>();
  const gateRules = new Map<string, number>();
  for (const dir of cfg.configDirs) {
    if (account && accountOf(dir) !== account) continue;
    for (const g of readJsonl(join(dir, 'hk47-danger-gate.log'))) {
      const t = str(g.t);
      const day = t.slice(0, 10);
      const verdict = str(g.verdict);
      if (!day || (since && day < since) || !['ask', 'deny', 'approved'].includes(verdict))
        continue;
      const key = `${day}|${verdict}`;
      gateDaily.set(key, (gateDaily.get(key) ?? 0) + 1);
      if (verdict !== 'approved') {
        const rule = str(g.rule) || 'unknown';
        gateRules.set(rule, (gateRules.get(rule) ?? 0) + 1);
        totals.gateStops++;
      }
    }
  }

  // --- HK-47 queue --------------------------------------------------------------
  const queueDaily = new Map<string, number>();
  for (const e of readJsonl(join(cfg.queueDir, 'events.jsonl'))) {
    const flag = str(e.flag);
    const day = str(e.t).slice(0, 10);
    if (!day || flag === 'clear' || (since && day < since)) continue;
    if (account && e.account !== account) continue;
    const key = `${day}|${flag}`;
    queueDaily.set(key, (queueDaily.get(key) ?? 0) + 1);
    totals.queueWaits++;
  }
  let picks = 0;
  let pickedAtHead = 0;
  for (const l of readJsonl(join(cfg.queueDir, 'labels.jsonl'))) {
    const day = str(l.t).slice(0, 10);
    if (l.picked === undefined || (since && day < since)) continue;
    picks++;
    if (l.rank === 1) pickedAtHead++;
  }

  const split = (m: Map<string, number>, name: string): { day: string; count: number }[] =>
    [...m].map(([k, count]) => {
      const [day, v] = k.split('|');
      return { day, [name]: v, count } as { day: string; count: number };
    });

  return {
    range,
    account,
    since,
    today,
    indexedFiles: cfg.index.fileCount(),
    reparsedFiles,
    accounts,
    unpricedModels: [...unpriced].sort(),
    totals,
    daily: [...daily.values()]
      .map(({ sessionSet, ...d }) => {
        const prompt = d.input + d.cacheRead + d.cacheWrite5m + d.cacheWrite1h;
        return {
          ...d,
          sessions: sessionSet.size,
          cacheHitRatio: prompt ? d.cacheRead / prompt : 0,
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day)),
    byProject: topN(
      [...projects.values()].map(({ sessionSet, ...p }) => ({ ...p, sessions: sessionSet.size })),
      'project'
    ),
    byModel: [...models.values()].filter(m => m.tokens > 0).sort((a, b) => b.tokens - a.tokens),
    byAccount: [...accts.values()].map(({ sessionSet, ...a }) => ({
      ...a,
      sessions: sessionSet.size,
    })),
    byOrigin: [...origins.values()].map(({ sessionSet, ...o }) => ({
      ...o,
      sessions: sessionSet.size,
    })),
    bySidechain: [...sidechains.values()],
    tools: toolRows,
    workflows: {
      runs: runList,
      byStatus: [...statusCounts].map(([status, count]) => ({ status, count })),
    },
    gate: {
      daily: split(gateDaily, 'verdict') as MetricsReport['gate']['daily'],
      rules: [...gateRules]
        .map(([rule, count]) => ({ rule, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP),
    },
    queue: {
      daily: split(queueDaily, 'flag') as MetricsReport['queue']['daily'],
      picks,
      pickedAtHead,
    },
  };
}
