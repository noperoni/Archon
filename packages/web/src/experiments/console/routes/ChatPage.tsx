import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer } from '../components/ChatComposer';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { WorkingIndicator } from '../components/WorkingIndicator';
import { WorkflowDock } from '../components/WorkflowDock';
import { QuestionCard } from '../components/QuestionCard';
import { EmptyState } from '../components/EmptyState';
import { UsageMeter } from '../components/UsageMeter';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import type { Message } from '../primitives/message';
import { QUESTION_POLL_MS, type ConversationUsage, type PendingQuestion } from '../skills/messages';
import type { ConversationSummary } from '../primitives/conversation';
import type { ClaudeSession, SlashCommand } from '../skills/conversations';

const NEW_CONVERSATION = '__new';
const TERMINAL_PREFIX = 'claude:';

// While a turn is active, refetch messages on this cadence so streamed replies
// still surface if a per-conversation SSE event is dropped (cross-origin
// EventSource in dev can miss bursts). Mirrors RunDetailPage's safety-net poll.
const ACTIVE_POLL_MS = 3000;
// Distance from the bottom (px) within which we treat the scroll as "at bottom"
// — drives both auto-scroll stickiness and the jump-to-bottom button's visibility.
const NEAR_BOTTOM_PX = 120;
// The trace toggle outlives a reload; it defaults on, as the terminal shows it.
const TRACE_KEY = 'hk47.chat.trace';

/**
 * Project-scoped agent chat. A tab peer of the runs view under a project.
 *
 * MVP conversation model: one active conversation per project — the most-recent
 * web conversation, or created lazily on first send. No multi-conversation
 * sidebar yet (spike decision #3, deferred).
 *
 * Data flow mirrors RunDetailPage: load messages via useEntity(K.messages),
 * keep live via useConversationSSE (invalidate → refetch), render with the
 * shared MessageItem/ToolCallItem cards inside a StreamContextProvider.
 */
export function ChatPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );

  const { data: conversations, error: conversationsError } = useEntity<ConversationSummary[]>(
    projectId !== undefined ? K.conversations(projectId) : 'noop:no-project-convs',
    () => (projectId !== undefined ? skill.listConversations(projectId) : Promise.resolve([]))
  );

  // The project's terminal transcripts, resumable here (HK47 fork, PERS-18).
  const { data: claudeSessions, error: claudeSessionsError } = useEntity<ClaudeSession[]>(
    projectId !== undefined ? K.claudeSessions(projectId) : 'noop:no-project-sessions',
    () => (projectId !== undefined ? skill.listClaudeSessions(projectId) : Promise.resolve([]))
  );
  // A fetch that lands mid server reload fails, and nothing else refetches the
  // list until a transcript is written, so the project reads as having no
  // history. Retry instead.
  useEffect(() => {
    if (projectId === undefined || claudeSessionsError === undefined) return;
    const id = setTimeout(() => {
      invalidate(K.claudeSessions(projectId));
    }, 3000);
    return (): void => {
      clearTimeout(id);
    };
  }, [projectId, claudeSessionsError]);

  // Slash autocomplete: the skills and commands this project's terminal offers.
  const { data: commands } = useEntity<SlashCommand[]>(
    projectId !== undefined ? K.commands(projectId) : 'noop:no-project-commands',
    () => (projectId !== undefined ? skill.listCommands(projectId) : Promise.resolve([]))
  );

  // Active conversation: most-recent web conversation, else null until first send.
  // `picked` stops that default from overriding an explicit "New conversation".
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (activeConvId !== null || picked) return;
    const web = (conversations ?? []).find(c => c.platformType === 'web');
    if (web !== undefined) setActiveConvId(web.id);
  }, [conversations, activeConvId, picked]);

  const onPick = (value: string): void => {
    if (projectId === undefined) return;
    setPicked(true);
    setError(null);
    setEcho(null);
    if (value === NEW_CONVERSATION) {
      setActiveConvId(null);
      return;
    }
    if (!value.startsWith(TERMINAL_PREFIX)) {
      setActiveConvId(value);
      return;
    }
    void (async (): Promise<void> => {
      try {
        const conv = await skill.resumeClaudeSession(
          projectId,
          value.slice(TERMINAL_PREFIX.length)
        );
        setActiveConvId(conv.conversationId);
        invalidate(K.conversations(projectId));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Resume failed.');
      }
    })();
  };

  // One timeline: every transcript once, opening the console conversation that
  // resumed it if one has, then console conversations with no transcript yet;
  // newest first by the transcript's own activity, whoever wrote last.
  const timeline = useMemo(() => {
    const items: { value: string; label: string; at: string }[] = [];
    const shown = new Set<string>();
    for (const t of claudeSessions ?? []) {
      if (t.conversationId !== undefined && shown.has(t.conversationId)) continue;
      if (t.conversationId !== undefined) shown.add(t.conversationId);
      items.push({
        value: t.conversationId ?? `${TERMINAL_PREFIX}${t.sessionId}`,
        label: `${t.lastActivity.slice(0, 10)} ${t.title}${t.conversationId === undefined ? ' · terminal' : ''}`,
        at: t.lastActivity,
      });
    }
    for (const c of conversations ?? []) {
      if (c.platformType !== 'web' || shown.has(c.id)) continue;
      const at = (c.lastActivityAt ?? '').replace(' ', 'T');
      items.push({ value: c.id, label: `${at.slice(0, 10)} ${c.title ?? 'Untitled'}`, at });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [claudeSessions, conversations]);

  // The open conversation's transcript moved (a terminal continuing the same
  // session, most likely): its merged history changed with it.
  const activeActivity = (claudeSessions ?? []).find(
    t => activeConvId !== null && t.conversationId === activeConvId
  )?.lastActivity;
  useEffect(() => {
    if (activeConvId !== null && activeActivity !== undefined) invalidate(K.messages(activeConvId));
  }, [activeConvId, activeActivity]);

  const { data: messages, error: messagesError } = useEntity<Message[]>(
    activeConvId !== null ? K.messages(activeConvId) : 'noop:no-conv',
    () => (activeConvId !== null ? skill.listMessages(activeConvId) : Promise.resolve([]))
  );

  const { data: usage } = useEntity<ConversationUsage | null>(
    activeConvId !== null ? K.usage(activeConvId) : 'noop:no-conv-usage',
    () => (activeConvId !== null ? skill.getUsage(activeConvId) : Promise.resolve(null))
  );
  // Every change to the message list is a call that moved the transcript.
  const lastMessageId = messages?.[messages.length - 1]?.id;
  const messageCount = messages?.length ?? 0;
  useEffect(() => {
    if (activeConvId !== null) invalidate(K.usage(activeConvId));
  }, [activeConvId, lastMessageId, messageCount]);

  const { data: questions } = useEntity<PendingQuestion[]>(
    activeConvId !== null ? K.questions(activeConvId) : 'noop:no-conv-questions',
    () => (activeConvId !== null ? skill.listQuestions(activeConvId) : Promise.resolve([]))
  );

  // A workflow run launched from this chat can ask while the chat itself is
  // idle, and no turn of ours is polling then, so questions get their own poll.
  // ponytail: a fixed 5s poll of an in-memory endpoint; push it over SSE if the
  // console ever grows many open chats.
  useEffect(() => {
    if (activeConvId === null) return;
    const id = setInterval(() => {
      invalidate(K.questions(activeConvId));
    }, QUESTION_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [activeConvId]);

  // `busy` = a turn is running or queued → composer disabled + live poll.
  // HK-47 fork: read from the server's conversation lock, not inferred from the
  // messages. The old settle guess (trailing reply stable for 6s) cleared on any
  // tool call longer than that and read a reload mid-turn as idle, which left a
  // working session looking dead. The SSE lock event is a fast path on top.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-error advisory (distinct channel from `error` so it doesn't read as a
  // send failure).
  const [notice, setNotice] = useState<string | null>(null);
  // A send in flight holds `busy`: the lock is not taken until the POST lands.
  const sendingRef = useRef(false);

  const applyRunning = useCallback((running: boolean): void => {
    if (running) setBusy(true);
    else if (!sendingRef.current) setBusy(false);
  }, []);

  // Must be useCallback-stable — the SSE hook's effect depends on it, so an
  // inline lambda would reconnect the EventSource on every render.
  const onLockChange = useCallback(
    (locked: boolean): void => {
      applyRunning(locked);
    },
    [applyRunning]
  );
  useConversationSSE(activeConvId, onLockChange);

  // Ask the lock on open and then on a cadence: fast while a turn runs, when it
  // also refetches in case an SSE event was dropped; slow while idle, so a turn
  // started from another tab or before a reload still shows.
  useEffect(() => {
    if (activeConvId === null) {
      setBusy(false);
      return;
    }
    let alive = true;
    const check = (): void => {
      skill.isRunning(activeConvId).then(
        r => {
          if (alive) applyRunning(r);
        },
        () => undefined
      );
    };
    check();
    const id = setInterval(
      () => {
        check();
        if (busy) {
          invalidate(K.messages(activeConvId));
          invalidate(K.questions(activeConvId));
        }
      },
      busy ? ACTIVE_POLL_MS : QUESTION_POLL_MS
    );
    return (): void => {
      alive = false;
      clearInterval(id);
    };
  }, [busy, activeConvId, applyRunning]);

  // HK-47 fork: Stop ends the turn and keeps the session, as Esc does in the
  // terminal. The composer is disabled while busy, so Esc is caught at the
  // window, and left alone when some other field (a question card) has focus.
  const onStop = useCallback((): void => {
    if (activeConvId === null) return;
    skill.stopTurn(activeConvId).then(
      () => {
        invalidate(K.messages(activeConvId));
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : 'Stop failed.');
      }
    );
  }, [activeConvId]);
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      onStop();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [busy, onStop]);

  // The inline tool trace, as the terminal draws it. On unless turned off.
  const [showTools, setShowTools] = useState(() => localStorage.getItem(TRACE_KEY) !== 'off');
  const toggleTrace = (): void => {
    setShowTools(v => {
      localStorage.setItem(TRACE_KEY, v ? 'off' : 'on');
      return !v;
    });
  };

  // The sent message shows at once, as the terminal echoes it, until the
  // refetched history carries it. `after` is how many rows existed at send.
  const [echo, setEcho] = useState<{
    text: string;
    display: string | null;
    at: string;
    after: number;
  } | null>(null);

  const onSend = (text: string, files?: File[], display?: string): void => {
    if (projectId === undefined) return;
    setError(null);
    setNotice(null);
    setBusy(true); // optimistic: disable the composer immediately
    sendingRef.current = true;
    setEcho({
      text,
      display: display ?? null,
      at: new Date().toISOString(),
      after: activeConvId === null ? 0 : (messages ?? []).length,
    });
    scrollToBottom();
    void (async (): Promise<void> => {
      try {
        if (activeConvId === null) {
          // createConversation is JSON-only and keeps no typed form, so a first
          // message carrying files or paste tokens opens the conversation empty
          // and then sends like any other.
          const viaSend = (files !== undefined && files.length > 0) || display !== undefined;
          const conv = await skill.createConversation(projectId, viaSend ? undefined : text);
          if (viaSend) await skill.sendMessage(conv.conversationId, text, files, display);
          setActiveConvId(conv.conversationId);
          invalidate(K.conversations(projectId));
          invalidate(K.messages(conv.conversationId));
        } else {
          // A message sent over this turn's own question is the terminal's Esc
          // then a new prompt: without the dismissal the turn stays parked on
          // the question and the message waits in the lock queue unseen. A
          // workflow run's question is left alone; its node is not this turn.
          await Promise.all(
            (questions ?? [])
              .filter(q => !q.fromRun)
              .map(q => skill.dismissQuestion(activeConvId, q.toolUseId).catch(() => undefined))
          );
          invalidate(K.questions(activeConvId));
          await skill.sendMessage(activeConvId, text, files, display);
          invalidate(K.messages(activeConvId));
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setEcho(null);
        setBusy(false); // unblock so the user can retry
      } finally {
        sendingRef.current = false;
      }
      // On success `busy` stays true until the lock reads free.
    })();
  };

  // Inline auto-scroll, mirroring RunDetailPage: follow intent belongs to user
  // scrolling, not post-render geometry, and a ResizeObserver on the content
  // follows a reply as it grows, not only when a new message row appears.
  //
  // Both sides are watched. The content grows as a reply arrives; the viewport
  // shrinks when a question card, the workflow dock, a notice or a growing
  // composer takes room below it, and nothing scrolls then, so without this the
  // bottom of the stream slid out of sight behind whatever had appeared.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const pinToBottom = useCallback((): void => {
    if (!lastBottomRef.current) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, []);
  const observe = useCallback(
    (node: HTMLDivElement | null): (() => void) | undefined => {
      if (node === null) return undefined;
      const observer = new ResizeObserver(pinToBottom);
      observer.observe(node);
      return () => {
        observer.disconnect();
      };
    },
    [pinToBottom]
  );
  const contentRef = observe;
  const viewportRef = useCallback(
    (node: HTMLDivElement | null): (() => void) | undefined => {
      scrollRef.current = node;
      return observe(node);
    },
    [observe]
  );

  // A switched conversation or a sent message always resumes following.
  useEffect(() => {
    lastBottomRef.current = true;
    setAtBottom(true);
  }, [activeConvId]);

  // Jump-to-bottom affordance: `atBottom` (state) drives the button's visibility;
  // `lastBottomRef` (above) drives the auto-scroll stickiness. Keep them in sync.
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    lastBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    lastBottomRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  if (projectId === undefined) {
    return <EmptyState title="No project selected." />;
  }

  const fetched = messages ?? [];
  const echoed =
    echo !== null &&
    fetched.slice(echo.after).some(m => m.role === 'user' && m.content.trim() === echo.text);
  const messageList: Message[] =
    echo === null || echoed
      ? fetched
      : [
          ...fetched,
          {
            id: 'echo',
            role: 'user',
            content: echo.text,
            display: echo.display,
            timestamp: echo.at,
            toolCalls: [],
            error: null,
            category: null,
            dispatch: null,
            workflowResult: null,
          },
        ];

  // Surface a failed (re)load of the conversation list or message history — a
  // revalidation can fail silently (network blip, server restart) and otherwise
  // leave stale/empty data with no signal. Send errors take precedence.
  const loadError = messagesError ?? conversationsError;

  // Current activity for the working indicator: the latest tool the agent
  // invoked in the in-flight turn (walk back to the last user message).
  const currentActivity = useMemo<string | null>(() => {
    for (let i = messageList.length - 1; i >= 0; i--) {
      const m = messageList[i];
      if (m === undefined) continue;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && m.toolCalls.length > 0) {
        return m.toolCalls[m.toolCalls.length - 1]?.name ?? null;
      }
    }
    return null;
  }, [messageList]);

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {project?.name ?? 'Project'}
            </h1>
            <p className="text-xs text-text-tertiary">{project?.path ?? 'Loading…'}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleTrace}
              aria-pressed={showTools}
              title={
                showTools ? 'Hide the tool trace' : 'Show every tool call, as the terminal does'
              }
              className="rounded border border-border bg-surface-elevated px-2 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:text-text-primary"
            >
              {showTools ? '● trace' : '○ trace'}
            </button>
            <select
              aria-label="Conversation"
              value={activeConvId ?? NEW_CONVERSATION}
              disabled={busy}
              onChange={e => {
                onPick(e.target.value);
              }}
              className="max-w-[320px] shrink-0 truncate rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary"
            >
              <option value={NEW_CONVERSATION}>New conversation</option>
              {timeline.map(item => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ProjectViewTabs projectId={projectId} active="chat" />
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-[30px] pt-[26px] pb-[18px]"
        >
          {/* Match the composer's centered 940px column (design: .stream-inner) */}
          <div ref={contentRef} className="mx-auto max-w-[940px]">
            {messageList.length === 0 && !busy ? (
              <EmptyState
                title="No messages yet."
                hint={
                  activeConvId === null && timeline.length > 0
                    ? 'Start a new conversation, or pick up an earlier one.'
                    : 'Ask the agent about this project, or tell it what to run.'
                }
                // A project with only terminal history opens on a new conversation,
                // and the picker alone reads as "no history": offer it here.
                action={
                  activeConvId === null && timeline.length > 0 ? (
                    <div className="flex flex-col items-stretch gap-1.5">
                      {timeline.slice(0, 6).map(item => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => {
                            onPick(item.value);
                          }}
                          className="max-w-[520px] truncate rounded border border-border bg-surface-elevated px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  ) : undefined
                }
              />
            ) : (
              <StreamContextProvider value={{ runStartedAt: null }}>
                <ChatStream messages={messageList} showTools={showTools} live={busy} />
                {/* Questions sit at the end of the stream, where the terminal puts
                    them, and scroll with it, so the history above stays readable. */}
                {activeConvId !== null
                  ? (questions ?? []).map(q => (
                      <div key={q.toolUseId} className="mt-[14px]">
                        <QuestionCard
                          pending={q}
                          onAnswer={async (answers): Promise<void> => {
                            await skill.answerQuestion(activeConvId, q.toolUseId, answers);
                            invalidate(K.questions(activeConvId));
                            invalidate(K.messages(activeConvId));
                          }}
                          onDismiss={async (): Promise<void> => {
                            await skill.dismissQuestion(activeConvId, q.toolUseId);
                            invalidate(K.questions(activeConvId));
                            invalidate(K.messages(activeConvId));
                          }}
                        />
                      </div>
                    ))
                  : null}
                {busy ? (
                  <WorkingIndicator
                    activity={currentActivity}
                    expanded={showTools}
                    onToggle={toggleTrace}
                  />
                ) : null}
              </StreamContextProvider>
            )}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Jump to bottom"
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] text-text-secondary shadow-md transition-colors hover:text-text-primary"
          >
            <span aria-hidden>↓</span>
            Jump to bottom
          </button>
        ) : null}
      </div>

      <WorkflowDock projectId={projectId} />

      {notice !== null ? (
        <div className="shrink-0 border-t border-warning/30 bg-warning/[0.06] px-6 py-2 font-mono text-[11px] text-warning">
          {notice}
        </div>
      ) : null}

      {error !== null || loadError !== undefined ? (
        <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-6 py-2 font-mono text-[11px] text-error">
          {error ?? `Failed to load chat: ${loadError?.message ?? 'unknown error'}`}
        </div>
      ) : null}

      <ChatComposer
        onSend={onSend}
        disabled={busy}
        onStop={onStop}
        commands={commands}
        status={usage !== null && usage !== undefined ? <UsageMeter usage={usage} /> : null}
      />
    </section>
  );
}
