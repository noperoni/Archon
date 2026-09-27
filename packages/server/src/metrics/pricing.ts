/**
 * Notional API prices, USD per million tokens, from the claude-api skill's
 * model tables as of 2026-09-27. Notional because Master is on a subscription:
 * these say what the same tokens would cost at API rates, not what was paid.
 *
 * Cache writes are the standard 1.25x (5 minute) and 2x (1 hour) of input.
 * Reads are 0.1x except where a model sets its own rate. Thinking tokens are
 * already inside output_tokens, so they are never priced twice.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

function standard(input: number, output: number, cacheRead = input * 0.1): ModelPrice {
  return { input, output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead };
}

const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': standard(10, 50, 0.25),
  'claude-fable-5': standard(10, 50),
  'claude-mythos-5': standard(10, 50),
  'claude-opus-5-5': standard(4, 20, 0.2),
  'claude-opus-5': standard(5, 25),
  'claude-opus-4-8': standard(5, 25),
  'claude-opus-4-7': standard(5, 25),
  'claude-opus-4-6': standard(5, 25),
  'claude-sonnet-5': standard(2, 10),
  'claude-sonnet-4-6': standard(3, 15),
  'claude-haiku-4-5': standard(1, 5),
};

/** Transcripts write `claude-opus-5[1m]` and dated ids; both price as the base id. */
export function normaliseModel(model: string): string {
  return model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
}

export function priceOf(model: string): ModelPrice | undefined {
  return PRICES[normaliseModel(model)];
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Undefined when the model has no known price, so callers can flag it. */
export function costOf(model: string, t: TokenCounts): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
}
