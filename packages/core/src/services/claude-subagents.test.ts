import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listSessionSubagents } from './claude-subagents';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-subagents-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function agent(id: string, meta: Record<string, unknown>, lines: string[]): void {
  const dir = join(root, 'sess', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join('\n'));
}

const line = (ts: string, tool?: string): string =>
  JSON.stringify({
    timestamp: ts,
    message: { content: tool ? [{ type: 'tool_use', id: 'toolu_x', name: tool }] : 'hi' },
  });

describe('listSessionSubagents', () => {
  test('reads status from the parent: notification, tool result, silence', async () => {
    const parent = join(root, 'sess.jsonl');
    writeFileSync(
      parent,
      [
        JSON.stringify({
          content: '<task-id>abg</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>failed</status>',
        }),
        JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tfg' }] } }),
      ].join('\n')
    );
    agent(
      'abg',
      {
        description: 'Background one',
        agentType: 'Explore',
        requestShape: 'background',
        toolUseId: 't1',
      },
      [line('2026-09-29T10:00:00.000Z'), line('2026-09-29T10:00:05.000Z', 'Grep')]
    );
    agent(
      'afg',
      { description: 'Foreground one', agentType: 'general-purpose', toolUseId: 'tfg' },
      [line('2026-09-29T11:00:00.000Z', 'Read')]
    );
    agent('arun', { description: 'Still going', requestShape: 'background', toolUseId: 't3' }, [
      line('2026-09-29T12:00:00.000Z', 'Bash'),
    ]);
    agent('aold', { description: 'Died', requestShape: 'background', toolUseId: 't4' }, [
      line('2026-09-29T09:00:00.000Z'),
    ]);
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(root, 'sess', 'subagents', 'agent-aold.jsonl'), old, old);

    const agents = await listSessionSubagents(parent, 'sess');
    const by = new Map(agents.map(a => [a.agentId, a]));

    expect(agents.map(a => a.agentId)).toEqual(['arun', 'afg', 'abg', 'aold']);
    expect(by.get('abg')).toMatchObject({
      status: 'failed',
      background: true,
      toolUses: 1,
      lastTool: 'Grep',
    });
    expect(by.get('afg')).toMatchObject({ status: 'completed', background: false });
    expect(by.get('arun')?.status).toBe('running');
    expect(by.get('aold')?.status).toBe('stale');
  });

  test('a session that never spawned an agent lists none', async () => {
    expect(await listSessionSubagents(join(root, 'none.jsonl'), 'none')).toEqual([]);
  });
});
