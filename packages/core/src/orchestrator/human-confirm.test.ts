import { describe, test, expect, mock } from 'bun:test';
import type { UserQuestion } from '@archon/providers/types';
import { confirmWithHuman } from './human-confirm';

const Q = 'Run workflow plan on proj?';

function asker(answer: Record<string, string> | null) {
  return mock((_q: UserQuestion) => Promise.resolve(answer === null ? null : { answers: answer }));
}

describe('confirmWithHuman (PERS-30 F11)', () => {
  test('no channel refuses without asking', async () => {
    expect(await confirmWithHuman(undefined, Q, {})).toBe(false);
  });

  test('an explicit Allow is the only yes', async () => {
    expect(await confirmWithHuman(asker({ [Q]: 'Allow' }), Q, {})).toBe(true);
    expect(await confirmWithHuman(asker({ [Q]: 'Deny' }), Q, {})).toBe(false);
    expect(await confirmWithHuman(asker({ [Q]: 'sure, go ahead' }), Q, {})).toBe(false);
    expect(await confirmWithHuman(asker({}), Q, {})).toBe(false);
    expect(await confirmWithHuman(asker(null), Q, {})).toBe(false);
  });

  test('a broken channel refuses', async () => {
    const ask = mock((_q: UserQuestion) => Promise.reject(new Error('gone')));
    expect(await confirmWithHuman(ask, Q, {})).toBe(false);
  });

  test('the card carries the whole payload as its preview, under a fresh id', async () => {
    const ask = asker({ [Q]: 'Allow' });
    await confirmWithHuman(ask, Q, { prompt: 'p' });
    await confirmWithHuman(ask, Q, { prompt: 'p' });
    const [a, b] = ask.mock.calls.map(c => c[0]);
    expect(a.toolUseId).toStartWith('confirm-');
    expect(a.toolUseId).not.toBe(b.toolUseId);
    const q = (a.input.questions as { options: { label: string; preview: string }[] }[])[0];
    expect(q.options.map(o => o.label)).toEqual(['Allow', 'Deny']);
    expect(JSON.parse(q.options[0].preview)).toEqual({ prompt: 'p' });
  });
});
