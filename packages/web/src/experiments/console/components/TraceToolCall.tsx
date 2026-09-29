import { memo, useState, type ReactElement, type ReactNode } from 'react';
import { CopyButton } from './CopyButton';
import type { InlineToolCall } from '../primitives/message';

/**
 * One tool call in the chat trace, drawn the way the terminal draws it:
 * `● Name(argument)` with the full argument, then a `⎿` result folded to its
 * first lines, a diff for an edit, a checklist for a todo write. The run log
 * keeps its own ToolCallItem; this is the chat's.
 */

const PREVIEW_LINES = 4;
const DIFF_PREVIEW_LINES = 12;
const MAX_LINES = 400;

// The terminal's display names, so a row reads the same in both places.
const DISPLAY: Record<string, string> = {
  Edit: 'Update',
  MultiEdit: 'Update',
  Grep: 'Search',
  Glob: 'Search',
  WebFetch: 'Fetch',
  WebSearch: 'Web Search',
  TodoWrite: 'Update Todos',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function displayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp !== null) return `${mcp[1] ?? ''} - ${mcp[2] ?? ''} (MCP)`;
  return DISPLAY[name] ?? name;
}

/** What goes inside the parentheses. */
function argument(call: InlineToolCall): string {
  const i = call.input;
  switch (call.name) {
    case 'Bash':
      return str(i.command) ?? '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str(i.file_path) ?? '';
    case 'NotebookEdit':
      return str(i.notebook_path) ?? '';
    case 'Grep':
    case 'Glob':
      return [
        `pattern: "${str(i.pattern) ?? ''}"`,
        str(i.path) !== undefined ? `path: "${str(i.path) ?? ''}"` : '',
      ]
        .filter(Boolean)
        .join(', ');
    case 'WebFetch':
      return str(i.url) ?? '';
    case 'WebSearch':
      return str(i.query) ?? '';
    case 'Skill':
      return [str(i.skill), str(i.args)].filter(Boolean).join(' ');
    case 'Agent':
    case 'Task':
      return str(i.description) ?? '';
    case 'TodoWrite':
      return '';
    default: {
      const keys = Object.keys(i);
      return keys
        .slice(0, 3)
        .map(k => {
          const v = i[k];
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}: ${s.length > 80 ? `${s.slice(0, 80)}…` : s}`;
        })
        .join(', ');
    }
  }
}

function failed(output: string | undefined): boolean {
  return (
    output !== undefined && /^(<tool_use_error>|Error:|Exit code [1-9])/.test(output.trimStart())
  );
}

/**
 * The SDK stores a tool's structured response as JSON (`{"stdout": ...}` for
 * Bash, `{"type":"text","file":{...}}` for Read). The terminal shows what is
 * inside it, so unwrap the shapes it knows and pass anything else through.
 */
function plainOutput(name: string, output: string): string {
  const t = output.trimStart();
  if (!t.startsWith('{')) return output;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return output;
  }
  if (name === 'Bash' && typeof o.stdout === 'string') {
    const err = typeof o.stderr === 'string' ? o.stderr : '';
    const both = [o.stdout, err].filter(x => x.length > 0).join('\n');
    return o.interrupted === true ? `${both}\nInterrupted` : both;
  }
  if (name === 'Skill' && o.success === true) return 'Successfully loaded skill';
  const file = o.file as { content?: unknown; numLines?: unknown } | undefined;
  if (name === 'Read' && typeof file?.content === 'string') return file.content;
  if (typeof o.content === 'string') return o.content;
  if (Array.isArray(o.filenames)) return (o.filenames as unknown[]).map(String).join('\n');
  return output;
}

function lineCount(s: string): number {
  return s.length === 0 ? 0 : s.replace(/\n$/, '').split('\n').length;
}

function Folded({
  lines,
  preview,
  render,
}: {
  lines: string[];
  preview: number;
  render: (shown: string[]) => ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const shown = open ? lines.slice(0, MAX_LINES) : lines.slice(0, preview);
  const hidden = lines.length - shown.length;
  return (
    <>
      {render(shown)}
      {hidden > 0 || open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(v => !v);
          }}
          className="text-text-tertiary hover:text-text-primary"
        >
          {open
            ? lines.length > MAX_LINES
              ? `… ${String(lines.length - MAX_LINES)} more lines not shown · fold`
              : '▴ fold'
            : `… +${String(hidden)} lines`}
        </button>
      ) : null}
    </>
  );
}

/** Lines between the common head and tail, which is the change an edit made. */
function diffLines(before: string, after: string): { sign: '-' | '+' | ' '; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const context = (s: string): { sign: ' '; text: string } => ({ sign: ' ', text: s });
  return [
    ...a.slice(Math.max(0, head - 1), head).map(context),
    ...a.slice(head, a.length - tail).map(text => ({ sign: '-' as const, text })),
    ...b.slice(head, b.length - tail).map(text => ({ sign: '+' as const, text })),
    ...a.slice(a.length - tail, a.length - tail + 1).map(context),
  ];
}

function Diff({ edits }: { edits: { old: string; next: string }[] }): ReactElement {
  const rows = edits.flatMap((e, i) => [
    ...(i > 0 ? [{ sign: ' ' as const, text: '…' }] : []),
    ...diffLines(e.old, e.next),
  ]);
  const added = rows.filter(r => r.sign === '+').length;
  const removed = rows.filter(r => r.sign === '-').length;
  return (
    <div>
      <div className="text-text-secondary">
        {[
          added > 0 ? `Added ${String(added)} line${added === 1 ? '' : 's'}` : '',
          removed > 0 ? `removed ${String(removed)} line${removed === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(', ') || 'No line changes'}
      </div>
      <Folded
        lines={rows.map(r => `${r.sign}${r.text}`)}
        preview={DIFF_PREVIEW_LINES}
        render={shown => (
          <div className="overflow-x-auto">
            {shown.map((l, i) => (
              <div
                key={i}
                className="whitespace-pre"
                style={
                  l.startsWith('+')
                    ? {
                        color: 'var(--success)',
                        background: 'color-mix(in oklch, var(--success), transparent 90%)',
                      }
                    : l.startsWith('-')
                      ? {
                          color: 'var(--error)',
                          background: 'color-mix(in oklch, var(--error), transparent 90%)',
                        }
                      : { color: 'var(--text-tertiary)' }
                }
              >
                {l.slice(0, 1)} {l.slice(1)}
              </div>
            ))}
          </div>
        )}
      />
    </div>
  );
}

// A plain function, not a component: the caller needs to know when there is
// nothing to draw, so the `⎿` gutter is not left hanging.
function body(call: InlineToolCall): ReactElement | null {
  const i = call.input;
  if (call.name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string')
    return <Diff edits={[{ old: i.old_string, next: i.new_string }]} />;
  if (call.name === 'MultiEdit' && Array.isArray(i.edits)) {
    const edits = (i.edits as { old_string?: unknown; new_string?: unknown }[]).map(e => ({
      old: typeof e.old_string === 'string' ? e.old_string : '',
      next: typeof e.new_string === 'string' ? e.new_string : '',
    }));
    return <Diff edits={edits} />;
  }
  if (call.name === 'Write' && typeof i.content === 'string')
    return <div className="text-text-secondary">Wrote {String(lineCount(i.content))} lines</div>;
  if (call.name === 'TodoWrite' && Array.isArray(i.todos)) {
    return (
      <div>
        {(i.todos as { content?: unknown; status?: unknown }[]).map((t, n) => (
          <div
            key={n}
            className={t.status === 'completed' ? 'text-text-tertiary line-through' : ''}
            style={t.status === 'in_progress' ? { color: 'var(--running)' } : undefined}
          >
            {t.status === 'completed' ? '☒' : '☐'} {typeof t.content === 'string' ? t.content : ''}
          </div>
        ))}
      </div>
    );
  }
  if (call.output === undefined) return null;
  const output = plainOutput(call.name, call.output);
  if (call.name === 'Read' && !failed(output))
    return <div className="text-text-secondary">Read {String(lineCount(output))} lines</div>;
  const lines = output.replace(/\n$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '')
    return <div className="text-text-tertiary">(No output)</div>;
  return (
    <Folded
      lines={lines}
      preview={PREVIEW_LINES}
      render={shown => (
        <div className="overflow-x-auto whitespace-pre-wrap break-words text-text-secondary">
          {shown.join('\n')}
        </div>
      )}
    />
  );
}

function TraceToolCallView({ call }: { call: InlineToolCall }): ReactElement {
  const arg = argument(call);
  const running = call.output === undefined && call.durationMs === undefined;
  const bad = failed(call.output);
  const dot = running ? 'var(--running)' : bad ? 'var(--error)' : 'var(--success)';
  const detail = body(call);
  return (
    <div className="group relative font-mono text-[12.5px] leading-[1.55]">
      <div className="flex gap-2">
        <span
          aria-hidden
          className={running ? 'animate-pulse' : ''}
          style={{ color: dot, lineHeight: 'inherit' }}
        >
          ●
        </span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          <span className="font-bold text-text-primary">{displayName(call.name)}</span>
          {arg.length > 0 ? <span className="text-text-secondary">({arg})</span> : null}
          {call.durationMs !== undefined && call.durationMs >= 1000 ? (
            <span className="ml-2 text-[11px] text-text-tertiary">
              {(call.durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
        </div>
        {call.name === 'Bash' && arg.length > 0 ? (
          <CopyButton getText={() => arg} className="shrink-0 opacity-0 group-hover:opacity-100" />
        ) : null}
      </div>
      {detail !== null ? (
        <div className="flex gap-2 pl-[3px]">
          <span aria-hidden className="shrink-0 text-text-tertiary">
            ⎿
          </span>
          <div className="min-w-0 flex-1">{detail}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Refetches rebuild every call object; only a real change re-renders a row. */
const traceToolCall = memo(
  TraceToolCallView,
  (a, b) =>
    a.call.name === b.call.name &&
    a.call.output === b.call.output &&
    a.call.durationMs === b.call.durationMs &&
    JSON.stringify(a.call.input) === JSON.stringify(b.call.input)
);
export { traceToolCall as TraceToolCall };
