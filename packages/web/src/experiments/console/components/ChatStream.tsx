import { Fragment, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { TraceToolCall } from './TraceToolCall';
import { ConsoleWorkflowResultCard } from './ConsoleWorkflowResultCard';
import { isSystemCategory, type Message } from '../primitives/message';
import { elapsedSince, formatClock } from '../lib/format';

interface ChatStreamProps {
  messages: Message[];
  /**
   * The terminal's view (default on): every tool call inline in the order it
   * ran, with its argument and folded result, plus framework rows. Off, the
   * chat reads as prose only and the working indicator stands in for activity.
   */
  showTools?: boolean;
  /** A turn is still running, so the last one gets no "worked for" line yet. */
  live?: boolean;
}

function worked(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${String(m)}m ${String(s % 60)}s` : `${String(s)}s`;
}

/**
 * Message stream for the chat view. Each message renders as a MessageItem, its
 * tool calls follow it as trace rows, and every finished turn closes with the
 * terminal's "worked for" line.
 *
 * Wrap in <StreamContextProvider> upstream (ChatPage) so StreamCard timestamps
 * resolve — pass runStartedAt: null for wall-clock display.
 */
export function ChatStream({
  messages,
  showTools = true,
  live = false,
}: ChatStreamProps): ReactElement {
  // `workflow_result` messages are normally swept up by `isSystemCategory` (the
  // `workflow_` prefix), but they carry the run summary + a completion card — let
  // them through explicitly. Other `workflow_*` narration stays suppressed.
  const visible = messages.filter(
    m =>
      m.category === 'workflow_result' ||
      (showTools
        ? m.content.trim().length > 0 || m.toolCalls.length > 0 || m.error !== null
        : !isSystemCategory(m.category) && m.content.trim().length > 0)
  );

  let turnStart: string | null = null;
  let headerShown = false;

  return (
    <div className="flex flex-col gap-[14px]">
      {visible.map((message, index) => {
        if (message.role === 'user') {
          turnStart = message.timestamp;
          headerShown = false;
        }
        const next = visible[index + 1];
        const turnEnds =
          message.role !== 'user' && (next === undefined ? !live : next.role === 'user');
        const hasText = message.content.trim().length > 0 || message.error !== null;
        // One header per turn: later agent rows of the same turn go without.
        const compact = message.role !== 'user' && headerShown;
        if (message.role !== 'user' && hasText) headerShown = true;
        return (
          <Fragment key={message.id}>
            {message.category === 'workflow_result' && message.workflowResult !== null ? (
              <ConsoleWorkflowResultCard
                runId={message.workflowResult.runId}
                workflowName={message.workflowResult.workflowName}
                summary={message.content}
              />
            ) : hasText || message.role === 'user' ? (
              <MessageItem message={message} compact={compact} />
            ) : null}
            {showTools && message.toolCalls.length > 0 ? (
              <div className="flex flex-col gap-[10px] pl-[43px]">
                {message.toolCalls.map((call, i) => (
                  <TraceToolCall key={`${message.id}:tool:${i.toString()}`} call={call} />
                ))}
              </div>
            ) : null}
            {turnEnds && turnStart !== null ? (
              <div className="pl-[43px] font-mono text-[11px] text-text-tertiary">
                ✻ Worked for {worked(elapsedSince(turnStart, message.timestamp))} · done{' '}
                {formatClock(message.timestamp)}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
