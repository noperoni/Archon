import { memo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { graphicPre } from './FencedGraphic';
import { AgentAvatar } from './AgentAvatar';
import { CopyButton, useCopy } from './CopyButton';
import { formatClock } from '../lib/format';
import type { Message } from '../primitives/message';

interface MessageItemProps {
  message: Message;
  /**
   * `chat` (default) — Direction-B chat card. `log` — run-log styling
   * (design v3 .log-agent-card): violet left accent + mono body, no avatar.
   */
  variant?: 'chat' | 'log';
  /** A continuation of the same turn: no header, the avatar column kept as a gutter. */
  compact?: boolean;
}

/** A fenced block with the copy button the terminal's selection stands in for. */
function CodeBlock({ children }: { children?: ReactNode }): ReactElement {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group relative my-2">
      <pre
        ref={ref}
        className="overflow-x-auto rounded border border-border bg-surface-inset p-2 pr-10 text-[12px] leading-relaxed"
      >
        {children}
      </pre>
      <CopyButton
        getText={() => ref.current?.textContent ?? ''}
        className="absolute top-1.5 right-1.5 opacity-60 group-hover:opacity-100"
      />
    </div>
  );
}

/** Inline code copies on a plain click; a drag still selects as text. */
function InlineCode({ children }: { children?: ReactNode }): ReactElement {
  const [state, copy] = useCopy();
  return (
    <code
      title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy refused' : 'Click to copy'}
      onClick={e => {
        if (window.getSelection()?.isCollapsed === false) return;
        copy(e.currentTarget.textContent ?? '');
      }}
      className="cursor-copy rounded bg-surface-inset px-1 py-[1px] font-mono text-[12px] text-text-primary transition-colors"
      style={
        state === 'copied'
          ? { background: 'color-mix(in oklch, var(--success), transparent 75%)' }
          : undefined
      }
    >
      {children}
    </code>
  );
}

const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-text-tertiary/50 underline-offset-2 transition-colors hover:text-accent-bright hover:decoration-accent-bright"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // A fence without a language has no class, so a newline tells it apart.
    const isBlock =
      className?.startsWith('language-') === true ||
      (typeof children === 'string' && children.includes('\n'));
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return <InlineCode>{children}</InlineCode>;
  },
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1.5 text-[14px] font-semibold text-text-primary">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 text-[13px] font-semibold text-text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-1.5 mb-0.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1 ml-5 list-disc space-y-0.5 marker:text-text-tertiary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 ml-5 list-decimal space-y-0.5 marker:text-text-tertiary">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  pre: graphicPre(({ children }) => <CodeBlock>{children}</CodeBlock>),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2 text-text-secondary">
      {children}
    </blockquote>
  ),
  // Tables: Tailwind's reset strips every border and alignment, which is what
  // made a GFM table read as loose columns of text. Alignment from the
  // markdown (:--:) arrives as the cell's style and is passed through.
  table: ({ children }) => (
    <div className="md-table my-2 overflow-x-auto rounded-[9px] border border-border">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-inset">{children}</thead>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-border px-3 py-1.5 text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap text-text-tertiary"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-t border-border px-3 py-1.5 align-top leading-snug">
      {children}
    </td>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  del: ({ children }) => <del className="text-text-tertiary">{children}</del>,
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly
      className="mr-1.5 translate-y-[1px] accent-[var(--accent)]"
    />
  ),
};

const ERROR_BLOCK = (msg: string): ReactElement => (
  <div className="mt-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[12px] text-error">
    {msg}
  </div>
);

/**
 * Direction-B chat row. Role-branched:
 *  - `user` → meta line + right-aligned outlined-magenta bubble (all lengths).
 *  - `assistant`/`system` → meta line + 30px gradient-ring avatar + soft
 *    surface-elevated card containing the markdown body.
 *
 * Borders use inline `style.borderColor` because the console scope has a
 * wildcard `border-color: var(--border)` rule that would repaint Tailwind's
 * border-utility colors otherwise (see `theme.css`, mirrored in
 * `StreamCard.tsx`).
 */
// Past this many lines a sent message folds, the way the terminal folds a paste.
const FOLD_OVER_LINES = 14;
const FOLD_SHOW_LINES = 8;
const IMAGE_TOKEN = /(\[Image #\d+\])/;

function UserText({ content }: { content: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const lines = content.split('\n');
  const folded = !open && lines.length > FOLD_OVER_LINES;
  const shown = folded ? lines.slice(0, FOLD_SHOW_LINES).join('\n') : content;
  return (
    <>
      <span className="whitespace-pre-wrap">
        {shown.split(IMAGE_TOKEN).map((part, i) =>
          IMAGE_TOKEN.test(part) ? (
            <span
              key={i}
              className="rounded px-[5px] py-[1px] font-mono text-[12px]"
              style={{ background: 'color-mix(in oklch, var(--brand-magenta), transparent 80%)' }}
            >
              {part}
            </span>
          ) : (
            part
          )
        )}
      </span>
      {lines.length > FOLD_OVER_LINES ? (
        <button
          type="button"
          onClick={() => {
            setOpen(v => !v);
          }}
          className="mt-1 block font-mono text-[11px] text-text-tertiary hover:text-text-primary"
        >
          {open ? '▴ fold' : `… +${String(lines.length - FOLD_SHOW_LINES)} lines`}
        </button>
      ) : null}
    </>
  );
}

const messageItem = memo(
  MessageItemView,
  (a, b) =>
    a.variant === b.variant &&
    a.compact === b.compact &&
    a.message.id === b.message.id &&
    a.message.role === b.message.role &&
    a.message.content === b.message.content &&
    a.message.timestamp === b.message.timestamp &&
    a.message.error?.message === b.message.error?.message
);
export { messageItem as MessageItem };

function MessageItemView({
  message,
  variant = 'chat',
  compact = false,
}: MessageItemProps): ReactElement {
  const kind = message.role;
  const content = message.content.trim();
  const clock = formatClock(message.timestamp);
  const log = variant === 'log';

  if (kind === 'user') {
    return (
      <div className="flex flex-col items-end">
        <header className="mb-2 flex flex-row-reverse items-center gap-[9px] font-mono">
          <span
            className="rounded px-[7px] py-[2px] text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{
              color: 'var(--brand-magenta)',
              background: 'color-mix(in oklch, var(--brand-magenta), transparent 88%)',
            }}
          >
            You
          </span>
          <time
            dateTime={message.timestamp}
            title={clock}
            className="text-[11px] tracking-[0.3px] text-text-tertiary"
          >
            {clock}
          </time>
        </header>
        <div
          className="max-w-[76%] self-end rounded-[14px_14px_4px_14px] px-[17px] py-[13px] text-[14.5px] leading-[1.5] break-words"
          style={{
            background: 'color-mix(in oklch, var(--brand-magenta), transparent 94%)',
            border: '1px solid color-mix(in oklch, var(--brand-magenta), transparent 50%)',
            color: 'color-mix(in oklch, var(--text-primary), var(--brand-magenta) 12%)',
            boxShadow: '0 0 0 4px color-mix(in oklch, var(--brand-magenta), transparent 95%)',
          }}
        >
          <UserText content={content} />
        </div>
        {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
      </div>
    );
  }

  const label = kind === 'system' ? 'System' : 'HK47';

  return (
    <div className="flex flex-col">
      {compact ? null : (
        <header className="mb-2 flex items-center gap-[9px] font-mono">
          <span
            className="rounded px-[7px] py-[2px] text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{
              color: 'var(--brand-teal)',
              background: 'color-mix(in oklch, var(--brand-teal), transparent 88%)',
            }}
          >
            {label}
          </span>
          <time
            dateTime={message.timestamp}
            title={clock}
            className="text-[11px] tracking-[0.3px] text-text-tertiary"
          >
            {clock}
          </time>
        </header>
      )}
      <div className="flex max-w-full items-start gap-[13px]">
        {log ? null : (
          <div className="w-[30px] shrink-0">{compact ? null : <AgentAvatar size={30} />}</div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="rounded-[12px] border bg-[color:var(--surface-elevated)] px-4 py-[14px]"
            style={
              log
                ? {
                    borderColor: 'var(--border)',
                    borderLeft: '3px solid var(--brand-violet)',
                  }
                : { borderColor: 'var(--border)' }
            }
          >
            {content.length > 0 ? (
              <div
                className={
                  log
                    ? 'max-w-none font-mono text-[12px] leading-[1.7] text-text-secondary'
                    : 'max-w-none text-[14.5px] leading-[1.62] text-text-primary'
                }
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  rehypePlugins={[rehypeHighlight]}
                  components={MD_COMPONENTS}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : null}
            {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
