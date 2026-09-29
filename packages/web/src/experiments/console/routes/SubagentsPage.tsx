import { useEffect, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { LiveDot } from '../components/LiveDot';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import type { Subagent } from '../skills/conversations';

// Agents write their transcript as they work, so a short poll follows them.
const POLL_MS = 3000;

const STATUS_COLOUR: Record<Subagent['status'], string> = {
  running: 'var(--running)',
  completed: 'var(--success)',
  failed: 'var(--error)',
  stopped: 'var(--warning)',
  stale: 'var(--text-tertiary)',
};

function duration(from: string, to: string): string {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
}

/**
 * The subagents the project's Claude sessions spawned in the last week, console
 * and terminal alike, running ones first: what the terminal shows as its agent
 * rows, read from the transcripts Claude Code writes for each agent.
 */
export function SubagentsPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );
  const { data: agents, error } = useEntity<Subagent[]>(
    projectId !== undefined ? K.subagents(projectId) : 'noop:no-project-agents',
    () => (projectId !== undefined ? skill.listSubagents(projectId) : Promise.resolve([]))
  );
  useEffect(() => {
    if (projectId === undefined) return;
    const id = setInterval(() => {
      invalidate(K.subagents(projectId));
    }, POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [projectId]);

  if (projectId === undefined) return <EmptyState title="No project selected." />;
  const list = agents ?? [];

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-text-primary">
            {project?.name ?? 'Project'}
          </h1>
          <p className="text-xs text-text-tertiary">{project?.path ?? 'Loading…'}</p>
        </div>
        <ProjectViewTabs projectId={projectId} active="agents" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-[30px] py-[20px]">
        <div className="mx-auto flex max-w-[940px] flex-col gap-[6px]">
          {error !== undefined ? (
            <p className="font-mono text-[11px] text-error">Failed to load: {error.message}</p>
          ) : null}
          {agents !== undefined && list.length === 0 ? (
            <EmptyState
              title="No subagents this week."
              hint="Agents a session spawns show here while they run and after they finish."
            />
          ) : null}
          {list.map(a => (
            <div
              key={`${a.sessionId}:${a.agentId}`}
              className="flex items-center gap-3 rounded border border-border bg-surface-elevated px-3 py-2"
            >
              <span className="flex w-[14px] shrink-0 justify-center">
                {a.status === 'running' ? (
                  <LiveDot />
                ) : (
                  <span
                    className="h-[7px] w-[7px] rounded-full"
                    style={{ background: STATUS_COLOUR[a.status] }}
                  />
                )}
              </span>
              <span className="shrink-0 rounded border border-border px-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                {a.agentType}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] text-text-primary">{a.description}</span>
                <span className="truncate text-[11px] text-text-tertiary">
                  {a.sessionTitle}
                  {a.background ? ' · background' : ''}
                </span>
              </span>
              <span className="shrink-0 text-right font-mono text-[11px] text-text-secondary">
                <span style={{ color: STATUS_COLOUR[a.status] }}>{a.status}</span>
                {' · '}
                {duration(
                  a.startedAt,
                  a.status === 'running' ? new Date().toISOString() : a.lastActivity
                )}
                {' · '}
                {a.toolUses} tools
                {a.status === 'running' && a.lastTool !== null ? ` · ${a.lastTool}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
