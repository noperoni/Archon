import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claudeProjectDir,
  claudeTranscriptPath,
  listClaudeTranscripts,
} from './claude-transcripts';

const CWD = '/nfs/ops-center/Personal/mods/The Spotter : Dig or Die';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('claude transcripts', () => {
  let configDir: string;
  let dir: string;

  const write = (id: string, lines: unknown[], mtime: number): void => {
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(path, mtime, mtime);
  };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'archon-transcripts-test-'));
    dir = claudeProjectDir(configDir, CWD);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test('encodes the cwd the way Claude Code does', () => {
    expect(claudeProjectDir('/c', CWD)).toBe(
      '/c/projects/-nfs-ops-center-Personal-mods-The-Spotter---Dig-or-Die'
    );
  });

  test('lists most recent first, titled by the latest ai-title', async () => {
    write(A, [{ type: 'user', message: { content: 'older work' } }], 1000);
    write(
      B,
      [
        { type: 'mode', sessionId: B },
        { type: 'user', message: { content: 'fix the gate' } },
        { type: 'ai-title', aiTitle: 'First title' },
        { type: 'ai-title', aiTitle: 'Gate false positives' },
      ],
      2000
    );
    const list = await listClaudeTranscripts(configDir, CWD);
    expect(list.map(t => t.sessionId)).toEqual([B, A]);
    expect(list[0].title).toBe('Gate false positives');
    expect(list[1].title).toBe('older work');
  });

  test('falls back to the first real prompt, skipping meta and command wrappers', async () => {
    write(
      A,
      [
        { type: 'user', isMeta: true, message: { content: 'caveat' } },
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { content: [{ type: 'text', text: 'what is next' }] } },
      ],
      1000
    );
    const [t] = await listClaudeTranscripts(configDir, CWD);
    expect(t.title).toBe('what is next');
  });

  test('skips files that never got a prompt, and non-session files', async () => {
    write(A, [{ type: 'mode', sessionId: A }], 1000);
    writeFileSync(join(dir, 'notes.jsonl'), '{}\n');
    expect(await listClaudeTranscripts(configDir, CWD)).toEqual([]);
  });

  test('a project with no transcript directory has none', async () => {
    expect(await listClaudeTranscripts(configDir, '/nowhere')).toEqual([]);
  });

  test('refuses a session id that is not a uuid', () => {
    expect(claudeTranscriptPath(configDir, CWD, '../../etc/passwd')).toBeNull();
    expect(claudeTranscriptPath(configDir, CWD, A)).toBe(join(dir, `${A}.jsonl`));
  });
});
