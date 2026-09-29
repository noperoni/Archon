import type { ReactElement } from 'react';
import type { ConversationUsage } from '../skills/messages';

// Green below WARN, then orange sliding into red by FULL, red beyond.
const WARN = 200_000;
const FULL = 300_000;
const ORANGE = 'oklch(0.72 0.17 50)';

function colourOf(tokens: number): string {
  if (tokens < WARN) return 'var(--success)';
  const p = Math.min(1, (tokens - WARN) / (FULL - WARN));
  return `color-mix(in oklch, ${ORANGE}, var(--error) ${String(Math.round(p * 100))}%)`;
}

function compact(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * The chat footer's context and cost readout: the prompt size the last call
 * sent, as /context counts it, and the session's notional API cost including
 * its subagents. The bar fills toward FULL.
 */
export function UsageMeter({ usage }: { usage: ConversationUsage }): ReactElement {
  const colour = colourOf(usage.contextTokens);
  const fill = Math.min(1, usage.contextTokens / FULL);
  return (
    <span
      className="flex items-center gap-[8px]"
      title={`Context ${usage.contextTokens.toLocaleString()} tokens${
        usage.model !== null ? ` on ${usage.model}` : ''
      }. Cost at API prices, subagents included${
        usage.unpriced > 0 ? `; ${String(usage.unpriced)} calls on an unpriced model left out` : ''
      }.`}
    >
      <span
        aria-hidden
        className="relative h-[5px] w-[64px] overflow-hidden rounded-full"
        style={{ background: 'var(--border-bright)' }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-500"
          style={{ width: `${String(fill * 100)}%`, background: colour }}
        />
      </span>
      <span style={{ color: colour }}>{compact(usage.contextTokens)} tokens</span>
      <span>·</span>
      <span className="text-text-secondary">${usage.costUsd.toFixed(2)}</span>
    </span>
  );
}
