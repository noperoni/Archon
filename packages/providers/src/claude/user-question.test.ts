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
    expect((await dismissed('AskUserQuestion', input, ctx()))?.behavior).toBe('deny');
    const broken = buildUserQuestionPrompt(async () => {
      throw new Error('boom');
    });
    expect((await broken('AskUserQuestion', input, ctx()))?.behavior).toBe('deny');
  });

  // A permission prompt (auto classifier, settings rule, or the danger gate's
  // failure path) becomes a two-option question; only an explicit Allow runs it.
  describe('permission prompts for other tools', () => {
    const bash = { command: 'ls ~/x' };
    const reason = 'HK-47 danger gate failed';

    const ask = async (
      reply: (question: string) => Record<string, string> | null
    ): Promise<{
      result: Awaited<ReturnType<ReturnType<typeof buildUserQuestionPrompt>>>;
      seen: Record<string, unknown> | undefined;
    }> => {
      let seen: Record<string, unknown> | undefined;
      const prompt = buildUserQuestionPrompt(async q => {
        seen = q.input;
        const question = (q.input.questions as { question: string }[])[0].question;
        const answers = reply(question);
        return answers === null ? null : { answers };
      });
      const result = await prompt('Bash', bash, ctx({ decisionReason: reason }));
      return { result, seen };
    };

    test('shows the command and the reason, and allows on Allow with the input untouched', async () => {
      const { result, seen } = await ask(q => ({ [q]: 'Allow' }));
      const q = (seen?.questions as { question: string; options: { label: string }[] }[])[0];
      expect(q.question).toContain('ls ~/x');
      expect(q.question).toContain(reason);
      expect(q.options.map(o => o.label)).toEqual(['Allow', 'Deny']);
      expect(result).toEqual({ behavior: 'allow', updatedInput: bash });
    });

    test('denies on Deny, on dismissal, on a mismatched answer, and on a broken channel', async () => {
      expect((await ask(q => ({ [q]: 'Deny' }))).result?.behavior).toBe('deny');
      expect((await ask(() => null)).result?.behavior).toBe('deny');
      expect((await ask(() => ({ 'another question': 'Allow' }))).result?.behavior).toBe('deny');
      const broken = buildUserQuestionPrompt(async () => {
        throw new Error('boom');
      });
      expect((await broken('Bash', bash, ctx()))?.behavior).toBe('deny');
    });

    test('free text denies and is passed back to the model', async () => {
      const { result } = await ask(q => ({ [q]: 'use trash-put instead' }));
      expect(result?.behavior).toBe('deny');
      expect(result?.behavior === 'deny' && result.message).toContain('use trash-put instead');
    });
  });
});
