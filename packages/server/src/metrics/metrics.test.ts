import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMetrics, type ArchonSources, type MetricsConfig } from './metrics';
import { costOf } from './pricing';
import { parseTranscript, TranscriptIndex } from './transcript-index';

const TODAY = '2026-09-27';

function assistant(
  id: string,
  session: string,
  ts: string,
  usage: object,
  extra: object = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: session,
    cwd: '/nonexistent/hk47',
    message: { id, model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'x' }] },
    ...extra,
  });
}

function prompt(uuid: string, session: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    sessionId: session,
    cwd: '/nonexistent/hk47',
    message: { role: 'user', content: 'do the thing' },
  });
}

const U = {
  input_tokens: 10,
  output_tokens: 100,
  cache_read_input_tokens: 1000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
};

const noArchon = (consoleIds: string[] = []): ArchonSources => ({
  consoleSessions: async () => new Set(consoleIds),
  workflowRuns: async () => [],
  workflowEvents: async () => [],
});

let root: string;
let cfg: MetricsConfig;
let transcript: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hk47-metrics-'));
  const personal = join(root, '.claude-personal');
  const work = join(root, '.claude-work');
  mkdirSync(join(personal, 'projects', 'p'), { recursive: true });
  mkdirSync(join(work, 'projects', 'w'), { recursive: true });
  transcript = join(personal, 'projects', 'p', 's1.jsonl');
  writeFileSync(
    transcript,
    [
      prompt('u1', 's1', '2026-09-27T08:00:00Z'),
      // one message written as three content-block lines: usage must count once
      assistant('m1', 's1', '2026-09-27T08:00:01Z', U),
      assistant('m1', 's1', '2026-09-27T08:00:02Z', U, {}),
      assistant('m1', 's1', '2026-09-27T08:00:03Z', U),
      prompt('u-old', 's1', '2026-08-01T08:00:00Z'),
      assistant('m-old', 's1', '2026-08-01T08:00:01Z', U),
    ].join('\n') + '\n'
  );
  // a resumed copy of s1 repeats m1 and u1 under a new session file
  writeFileSync(
    join(personal, 'projects', 'p', 's2.jsonl'),
    [
      prompt('u1', 's1', '2026-09-27T08:00:00Z'),
      assistant('m1', 's1', '2026-09-27T08:00:01Z', U),
    ].join('\n') + '\n'
  );
  writeFileSync(
    join(work, 'projects', 'w', 's3.jsonl'),
    [
      prompt('u3', 's3', '2026-09-27T09:00:00Z'),
      assistant('m3', 's3', '2026-09-27T09:00:01Z', U, { isSidechain: true }),
    ].join('\n') + '\n'
  );
  cfg = {
    configDirs: [personal, work],
    queueDir: join(root, 'queue'),
    archon: noArchon(['s3']),
    index: new TranscriptIndex(join(root, 'metrics.db')),
    today: TODAY,
  };
});

afterAll(() => {
  cfg.index.close();
  rmSync(root, { recursive: true, force: true });
});

describe('parseTranscript', () => {
  test('dedupes repeated content-block lines by message id', () => {
    const lines = [
      assistant('m1', 's', '2026-09-27T08:00:01Z', U),
      assistant('m1', 's', '2026-09-27T08:00:02Z', U),
    ];
    expect(parseTranscript(lines.join('\n')).messages).toHaveLength(1);
  });

  test('tool results are not prompts', () => {
    const toolResult = JSON.stringify({
      type: 'user',
      uuid: 'x',
      timestamp: '2026-09-27T08:00:00Z',
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    });
    expect(parseTranscript(toolResult).turns).toHaveLength(0);
  });
});

describe('buildMetrics', () => {
  test('counts a message once across lines and across copied files', async () => {
    const r = await buildMetrics(cfg, '7', null);
    expect(r.totals.messages).toBe(2); // m1 and m3; m-old is out of range
    expect(r.totals.output).toBe(200);
    expect(r.totals.turns).toBe(2); // u1 once, u3
  });

  test('range filter excludes older days, all includes them', async () => {
    const all = await buildMetrics(cfg, 'all', null);
    expect(all.totals.messages).toBe(3);
    expect(all.daily.map(d => d.day)).toEqual(['2026-08-01', '2026-09-27']);
  });

  test('account filter', async () => {
    const r = await buildMetrics(cfg, 'all', 'claude-work');
    expect(r.totals.messages).toBe(1);
    expect(r.byAccount).toEqual([
      { account: 'claude-work', tokens: 1310, costUsd: expect.any(Number), sessions: 1 },
    ]);
  });

  test('origin joins Archon sessions, sidechain splits subagents', async () => {
    const r = await buildMetrics(cfg, '7', null);
    const origin = Object.fromEntries(r.byOrigin.map(o => [o.origin, o.sessions]));
    expect(origin).toEqual({ terminal: 1, console: 1 });
    expect(r.bySidechain.find(s => s.kind === 'subagent')?.tokens).toBe(1310);
  });

  test('notional cost uses the model rates', async () => {
    const r = await buildMetrics(cfg, '7', null);
    const one = costOf('claude-opus-5', {
      input: 10,
      output: 100,
      cacheRead: 1000,
      cacheWrite5m: 0,
      cacheWrite1h: 200,
    })!;
    expect(r.totals.costUsd).toBeCloseTo(one * 2, 10);
    expect(r.unpricedModels).toEqual([]);
  });

  test('reindexes only changed files', async () => {
    const first = await buildMetrics(cfg, '7', null);
    expect(first.reparsedFiles).toBe(0);
    appendFileSync(transcript, assistant('m2', 's1', '2026-09-27T10:00:00Z', U) + '\n');
    utimesSync(transcript, new Date(), new Date(Date.now() + 5000));
    const second = await buildMetrics(cfg, '7', null);
    expect(second.reparsedFiles).toBe(1);
    expect(second.totals.messages).toBe(3);
  });
});
