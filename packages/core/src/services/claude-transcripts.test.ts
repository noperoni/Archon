import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claudeProjectDir,
  claudeTranscriptPath,
  listClaudeTranscripts,
  readTranscriptTurns,
  transcriptCwd,
  transcriptCwdsFor,
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

  test('a session opened by a slash command is titled by it until something is typed', async () => {
    write(
      A,
      [
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        {
          type: 'user',
          message: {
            content:
              '<command-message>start-session</command-message>\n<command-name>/start-session</command-name>\n<command-args>the archon work</command-args>',
          },
        },
        { type: 'user', isMeta: true, message: { content: 'Base directory for this skill' } },
      ],
      1000
    );
    const [t] = await listClaudeTranscripts(configDir, CWD);
    expect(t.title).toBe('/start-session the archon work');
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

  test("reads the terminal's turns: prompts and text; tool traffic, meta and the console's SDK lines dropped", async () => {
    const at = (m: number): string => `2026-09-26T10:0${String(m)}:00.000Z`;
    write(
      A,
      [
        { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'fix the gate' } },
        { type: 'user', isMeta: true, timestamp: at(0), message: { content: 'meta noise' } },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: at(1),
          message: { content: [{ type: 'text', text: 'Looking.' }] },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          timestamp: at(1),
          message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
        },
        {
          type: 'user',
          timestamp: at(2),
          message: { content: [{ type: 'tool_result', content: 'out' }] },
        },
        {
          type: 'assistant',
          uuid: 'a3',
          timestamp: at(2),
          message: { content: [{ type: 'text', text: 'Fixed.' }] },
        },
        { type: 'user', timestamp: at(3), message: { content: '<command-name>/clear' } },
        {
          type: 'user',
          uuid: 'u2',
          entrypoint: 'sdk-ts',
          timestamp: at(5),
          message: { content: 'from the console' },
        },
        {
          type: 'assistant',
          uuid: 'a4',
          entrypoint: 'sdk-ts',
          timestamp: at(5),
          message: { content: [{ type: 'text', text: 'console reply' }] },
        },
        {
          type: 'user',
          uuid: 'u3',
          entrypoint: 'cli',
          timestamp: at(7),
          message: { content: 'back in the terminal' },
        },
      ],
      1000
    );
    const turns = await readTranscriptTurns(join(dir, `${A}.jsonl`));
    expect(turns.map(t => [t.id, t.role, t.content])).toEqual([
      ['u1', 'user', 'fix the gate'],
      ['a1', 'assistant', 'Looking.\n\nFixed.'],
      ['u3', 'user', 'back in the terminal'],
    ]);
  });

  test('re-reads a transcript once it grows', async () => {
    const path = join(dir, `${A}.jsonl`);
    const line = (uuid: string, text: string): unknown => ({
      type: 'user',
      uuid,
      timestamp: '2026-09-26T10:00:00.000Z',
      message: { content: text },
    });
    write(A, [line('u1', 'one')], 1000);
    expect((await readTranscriptTurns(path)).length).toBe(1);
    write(A, [line('u1', 'one'), line('u2', 'two')], 2000);
    expect((await readTranscriptTurns(path)).map(t => t.id)).toEqual(['u1', 'u2']);
  });

  test('reads the cwd a transcript was recorded in', async () => {
    write(A, [{ type: 'mode' }, { type: 'user', cwd: CWD, message: { content: 'x' } }], 1000);
    expect(await transcriptCwd(join(dir, `${A}.jsonl`))).toBe(CWD);
  });
  test('finds the transcripts a project left under a symlink it was opened through', async () => {
    const real = join(configDir, 'work', 'HK47');
    const link = join(configDir, 'work', 'personality');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const linkDir = claudeProjectDir(configDir, link);
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(linkDir, `${A}.jsonl`), JSON.stringify({ type: 'user', cwd: link }) + '\n');
    const cwds = await transcriptCwdsFor(configDir, realpathSync(real));
    expect(cwds).toEqual([realpathSync(real), link]);
  });
});
