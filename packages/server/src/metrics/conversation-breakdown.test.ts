import { describe, test, expect } from 'bun:test';
import { gateStops, toolContext } from './conversation-breakdown';

const assistant = (
  id: string,
  context: number,
  output: number,
  tools: [string, string, string][]
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-29T10:00:00Z',
    message: {
      id,
      usage: { input_tokens: context, output_tokens: output },
      content: tools.map(([tid, name, command]) => ({
        type: 'tool_use',
        id: tid,
        name,
        input: { command },
      })),
    },
  });
const result = (tid: string, text: string) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: tid, content: text }] },
  });
const prompt = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });

describe('toolContext', () => {
  test('measures growth to the next step, less output, split by result size', () => {
    const t = [
      assistant('m1', 1000, 100, [
        ['a', 'Bash', 'ls'],
        ['b', 'Bash', 'cat big'],
      ]),
      result('a', 'x'.repeat(100)),
      result('b', 'x'.repeat(300)),
      assistant('m2', 1500, 10, []),
    ].join('\n');
    const { calls, byTool } = toolContext(t);
    expect(calls.map(c => [c.label, c.tokens, c.estimated])).toEqual([
      ['cat big', 300, false],
      ['ls', 100, false],
    ]);
    expect(byTool).toEqual([{ tool: 'Bash', tokens: 400, calls: 2 }]);
  });

  test('estimates from the text when a typed prompt shares the gap, or no step follows', () => {
    const t = [
      assistant('m1', 1000, 0, [['a', 'Read', 'f']]),
      result('a', 'x'.repeat(40)),
      prompt('and another thing'),
      assistant('m2', 9000, 0, [['b', 'Read', 'g']]),
      result('b', 'x'.repeat(8)),
    ].join('\n');
    const { calls } = toolContext(t);
    expect(calls.map(c => [c.label, c.tokens, c.estimated])).toEqual([
      ['f', 10, true],
      ['g', 2, true],
    ]);
  });
});

describe('gateStops', () => {
  const log = (e: Record<string, unknown>) => JSON.stringify({ session: 's1', ...e });
  const stop = { rule: 'rm', segment: 'rm x', command: 'rm x' };

  test('follows each stop to its fate, this session only', () => {
    const text = [
      log({ ...stop, t: '1', verdict: 'ask', stage: 'first-sight' }),
      log({ ...stop, verdict: 'approved', stage: 'answered' }),
      log({ ...stop, verdict: 'ask', stage: 'stand-aside' }),
      log({
        rule: 'kill',
        segment: 'pkill x',
        command: 'pkill x',
        t: '2',
        verdict: 'deny',
        stage: 'refused',
      }),
      log({
        rule: 'mv',
        segment: 'mv a b',
        command: 'mv a b',
        t: '3',
        verdict: 'ask',
        stage: 'first-sight',
      }),
      log({ rule: 'mv', segment: 'mv a b', verdict: 'refused', stage: 'answered' }),
      log({
        rule: 'dd',
        segment: 'dd',
        command: 'dd',
        t: '4',
        verdict: 'ask',
        stage: 'first-sight',
      }),
      JSON.stringify({ ...stop, session: 'other', verdict: 'ask', stage: 'first-sight' }),
    ].join('\n');
    expect(gateStops(text, 's1').map(s => [s.rule, s.outcome])).toEqual([
      ['rm', 'ran after approval'],
      ['kill', 'refused: unrecoverable'],
      ['mv', 'refused by Master'],
      ['dd', 'awaiting an answer'],
    ]);
  });
});
