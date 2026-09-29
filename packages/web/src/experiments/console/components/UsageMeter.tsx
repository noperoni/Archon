import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  getBreakdown,
  type ConversationBreakdown,
  type ConversationUsage,
} from '../skills/messages';

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

const OUTCOME_COLOUR: Record<string, string> = {
  'ran after approval': 'var(--warning)',
  'approved, not retried': 'var(--text-secondary)',
  'awaiting an answer': 'var(--text-tertiary)',
};

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * HK-47 fork: behind the meter, what filled the context, by tool and by call,
 * and every stop the danger gate made this session with its fate. Read on open.
 */
function Breakdown({
  conversationId,
  contextTokens,
  onClose,
}: {
  conversationId: string;
  contextTokens: number;
  onClose: () => void;
}): ReactElement {
  const [data, setData] = useState<ConversationBreakdown | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    getBreakdown(conversationId).then(
      d => {
        if (alive) setData(d);
      },
      (e: unknown) => {
        if (alive) setFailed(e instanceof Error ? e.message : 'Failed to read the breakdown.');
      }
    );
    return (): void => {
      alive = false;
    };
  }, [conversationId]);

  // Esc and a click outside close it. Capture phase, so the chat's Esc-to-stop
  // never sees the key that was meant for this window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    return (): void => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const top = data?.byTool[0]?.tokens ?? 0;
  const tools = data?.byTool.reduce((n, t) => n + t.tokens, 0) ?? 0;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Context breakdown"
      className="absolute bottom-full left-0 z-20 mb-2 max-h-[60vh] w-[560px] max-w-[90vw] overflow-y-auto rounded-[10px] border bg-surface-elevated p-4 font-mono text-[11px] text-text-secondary shadow-xl"
      style={{ borderColor: 'var(--border-bright)' }}
    >
      {failed !== null ? (
        <p className="text-error">{failed}</p>
      ) : data === undefined ? (
        <p>Reading the transcript…</p>
      ) : data === null ? (
        <p>No transcript yet: the first turn has not written one.</p>
      ) : (
        <>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
            Context by tool
          </h3>
          {data.byTool.length === 0 ? <p>No tool has returned yet.</p> : null}
          {tools > 0 ? (
            <p className="mb-2 text-text-tertiary">
              Tool results hold {compact(tools)} of {compact(contextTokens)}; the rest is the system
              prompt and the conversation itself.
            </p>
          ) : null}
          {data.byTool.map(t => (
            <div key={t.tool} className="mb-[3px] flex items-center gap-2">
              <span className="w-[150px] truncate text-text-primary" title={t.tool}>
                {t.tool}
              </span>
              <span className="relative h-[5px] flex-1 overflow-hidden rounded-full">
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{
                    width: `${String(top > 0 ? (t.tokens / top) * 100 : 0)}%`,
                    background: 'var(--brand-magenta)',
                  }}
                />
              </span>
              <span className="w-[58px] text-right">{compact(t.tokens)}</span>
              <span className="w-[52px] text-right text-text-tertiary">×{t.calls}</span>
            </div>
          ))}

          {data.calls.length > 0 ? (
            <>
              <h3 className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
                Heaviest calls
              </h3>
              {data.calls.map((c, i) => (
                <div key={i} className="mb-[3px] flex gap-2" title={c.label}>
                  <span
                    className="w-[58px] shrink-0 text-right"
                    title={c.estimated ? 'Estimated from the result text' : 'Measured'}
                  >
                    {c.estimated ? '~' : ''}
                    {compact(c.tokens)}
                  </span>
                  <span className="w-[70px] shrink-0 truncate text-text-primary">{c.tool}</span>
                  <span className="truncate">{c.label}</span>
                </div>
              ))}
            </>
          ) : null}

          <h3 className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
            Danger gate
          </h3>
          {data.gate.length === 0 ? <p>Nothing stopped this session.</p> : null}
          {data.gate.map((g, i) => (
            <div key={i} className="mb-[3px] flex gap-2" title={g.command}>
              <span className="w-[40px] shrink-0 text-text-tertiary">{clock(g.ts)}</span>
              <span className="w-[70px] shrink-0 truncate text-text-primary">{g.rule}</span>
              <span className="min-w-0 flex-1 truncate">{g.command}</span>
              <span
                className="shrink-0"
                style={{ color: OUTCOME_COLOUR[g.outcome] ?? 'var(--error)' }}
              >
                {g.outcome}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The chat footer's context and cost readout: the prompt size the last call
 * sent, as /context counts it, and the session's notional API cost including
 * its subagents. The bar fills toward FULL; a click opens the breakdown.
 */
export function UsageMeter({
  usage,
  conversationId,
}: {
  usage: ConversationUsage;
  conversationId: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const colour = colourOf(usage.contextTokens);
  const fill = Math.min(1, usage.contextTokens / FULL);
  return (
    <span className="relative">
      {open ? (
        <Breakdown
          conversationId={conversationId}
          contextTokens={usage.contextTokens}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(v => !v);
        }}
        className="flex items-center gap-[8px] rounded px-1 hover:bg-[color:var(--surface-hover)]"
        title={`Context ${usage.contextTokens.toLocaleString()} tokens${
          usage.model !== null ? ` on ${usage.model}` : ''
        }. Cost at API prices, subagents included${
          usage.unpriced > 0
            ? `; ${String(usage.unpriced)} calls on an unpriced model left out`
            : ''
        }. Click for the breakdown.`}
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
      </button>
    </span>
  );
}
