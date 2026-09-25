import { describe, test, expect } from 'bun:test';
import { buildUserQuestionPrompt } from './provider';

type Ctx = Parameters<ReturnType<typeof buildUserQuestionPrompt>>[2];

const ctx = (extra: Partial<Ctx> = {}): Ctx =>
  ({
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'req_1',
    ...extra,
  }) as Ctx;

const input = { questions: [{ question: 'Which colour?', options: [] }] };

describe('buildUserQuestionPrompt', () => {
  test('merges the answer into the AskUserQuestion input', async () => {
    const prompt = buildUserQuestionPrompt(async q => {
      expect(q.toolUseId).toBe('toolu_1');
      return { answers: { 'Which colour?': 'Blue' } };
    });
    expect(await prompt('AskUserQuestion', input, ctx())).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which colour?': 'Blue' } },
    });
  });

  test('denies when the question is dismissed or the handler throws', async () => {
    const dismissed = buildUserQuestionPrompt(async () => null);
    expect((await dismissed('AskUserQuestion', input, ctx())).behavior).toBe('deny');
    const broken = buildUserQuestionPrompt(async () => {
      throw new Error('boom');
    });
    expect((await broken('AskUserQuestion', input, ctx())).behavior).toBe('deny');
  });

  // The danger gate's own failure path answers `ask`; allowing here would run
  // the command the gate could not judge.
  test('denies every other tool without consulting the handler, quoting the reason', async () => {
    let asked = false;
    const prompt = buildUserQuestionPrompt(async () => {
      asked = true;
      return { answers: {} };
    });
    const result = await prompt(
      'Bash',
      { command: 'rm -r ~/x' },
      ctx({ decisionReason: 'HK-47 danger gate failed' })
    );
    expect(asked).toBe(false);
    expect(result.behavior).toBe('deny');
    expect(result.behavior === 'deny' && result.message).toContain('HK-47 danger gate failed');
  });
});
