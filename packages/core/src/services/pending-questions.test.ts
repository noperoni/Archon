import { describe, test, expect } from 'bun:test';
import { waitForAnswer, answerQuestion, listQuestions } from './pending-questions';

const ask = (toolUseId: string, controller = new AbortController()) => ({
  toolUseId,
  input: { questions: [] },
  signal: controller.signal,
});

describe('pending questions', () => {
  test('an answer settles the waiter and clears the entry', async () => {
    const waiting = waitForAnswer('conv-a', ask('t1'));
    expect(listQuestions('conv-a').map(q => q.toolUseId)).toEqual(['t1']);
    expect(answerQuestion('conv-a', 't1', { answers: { Q: 'A' } })).toBe(true);
    expect(await waiting).toEqual({ answers: { Q: 'A' } });
    expect(listQuestions('conv-a')).toEqual([]);
  });

  test('another conversation can neither see nor answer it', async () => {
    const waiting = waitForAnswer('conv-a', ask('t2'));
    expect(listQuestions('conv-b')).toEqual([]);
    expect(answerQuestion('conv-b', 't2', { answers: {} })).toBe(false);
    expect(answerQuestion('conv-a', 'nope', { answers: {} })).toBe(false);
    answerQuestion('conv-a', 't2', { answers: {} });
    await waiting;
  });

  test('an abort settles null and drops the question', async () => {
    const controller = new AbortController();
    const waiting = waitForAnswer('conv-a', ask('t3', controller));
    controller.abort();
    expect(await waiting).toBeNull();
    expect(answerQuestion('conv-a', 't3', { answers: {} })).toBe(false);
  });
});
