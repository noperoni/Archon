import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useNavigate, useLocation } from 'react-router';
import {
  Settings,
  Workflow,
  PenTool,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  BarChart3,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import { setConsoleTheme, useConsoleTheme } from '../lib/theme';
import { getDisplayName } from '../lib/display-name';
import { ProjectMonogramTile, ProjectRow, projectLabel } from './ProjectRow';
import { EnvVarsDialog } from './EnvVarsDialog';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Account, Project } from '../primitives/project';

interface ProjectRailProps {
  onAddProject: () => void;
}

async function handleRemove(projectId: string): Promise<void> {
  await skill.removeProject(projectId);
  invalidate(K.projects);
}

/** Extract the project id from /console/p/:id (and /console/p/:id/r/:runId). */
function extractProjectId(pathname: string): string | null {
  const m = /^\/console\/p\/([^/]+)/.exec(pathname);
  return m === null ? null : m[1];
}

type SectionKey = Account | 'other';

/** Rail sections in display order. 'other' only renders when a project lands in it. */
const SECTIONS: readonly { key: SectionKey; label: string; stripe: string }[] = [
  { key: 'personal', label: 'Personal', stripe: 'var(--account-personal)' },
  { key: 'work', label: 'Work', stripe: 'var(--account-work)' },
  { key: 'other', label: 'Other account', stripe: 'var(--border-bright)' },
];

const COLLAPSED_KEY = 'archon.console.railCollapsed';

function readCollapsed(): Set<SectionKey> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? (v as SectionKey[]) : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(c: Set<SectionKey>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...c]));
  } catch {
    /* ignore */
  }
}

const RAIL_WIDTH_KEY = 'archon.console.railWidth';
const RAIL_MIN = 232;
const RAIL_MAX = 440;
const RAIL_DEFAULT = 280;

function readRailWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(RAIL_WIDTH_KEY) ?? '', 10);
    return v >= RAIL_MIN && v <= RAIL_MAX ? v : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

function writeRailWidth(w: number): void {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(w));
  } catch {
    /* ignore */
  }
}

type RailSort = 'az' | 'recent';

const SORT_KEY = 'archon.console.railSort';

function readSort(): RailSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'az' ? 'az' : 'recent';
  } catch {
    return 'recent';
  }
}

function writeSort(s: RailSort): void {
  try {
    localStorage.setItem(SORT_KEY, s);
  } catch {
    /* ignore */
  }
}

const FOLDED_KEY = 'archon.console.railFolded';
const RAIL_FOLDED_WIDTH = 60;

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFolded(f: boolean): void {
  try {
    localStorage.setItem(FOLDED_KEY, f ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Epoch ms of a project's newest transcript write; 0 when it has none. */
function lastActivityMs(
  activity: Record<string, skill.ProjectActivity> | undefined,
  id: string
): number {
  const at = activity?.[id]?.lastActivity;
  return at == null ? 0 : Date.parse(at);
}

const RAIL_NAV_LINK_CLASS =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary';

const RAIL_ICON_BUTTON_CLASS =
  'flex h-9 cursor-pointer w-9 items-center justify-center rounded-[10px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary';

/** A row in the rail's bottom nav menu (Builder / Metrics / Settings / Workflows). */
function RailNavLink({
  to,
  icon: Icon,
  label,
  title,
  badge,
  iconOnly = false,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  title?: string;
  /** Optional pill after the label (rail-header "console" pill styling). */
  badge?: string;
  /** Folded rail: the icon alone, named by its title. */
  iconOnly?: boolean;
}): ReactElement {
  if (iconOnly) {
    return (
      <Link to={to} title={title ?? label} aria-label={label} className={RAIL_ICON_BUTTON_CLASS}>
        <Icon aria-hidden className="h-4 w-4 shrink-0" />
      </Link>
    );
  }
  return (
    <Link to={to} title={title} className={RAIL_NAV_LINK_CLASS}>
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {badge !== undefined ? (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Left rail, design v2: header with count pill, filter input, projects
 * grouped into collapsible Personal / Work sections by the Claude account
 * their runs use (so the rail and the run can never disagree), and a drag
 * handle on the right edge (232–440px, persisted).
 *
 * HK-47 fork: rows sort A-Z or by latest Claude Code activity, a live pulse
 * marks projects with a terminal open in them (polled every 10s and nudged by
 * transcript SSE), and the rail folds to a monogram strip (both persisted).
 *
 * Note: ProjectRail mounts outside the inner `<Routes>` (sibling to the
 * <main> that hosts them), so `useParams()` returns `{}` here even on a
 * project URL. We extract the project id from the pathname directly.
 */
export function ProjectRail({ onAddProject }: ProjectRailProps): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = extractProjectId(location.pathname) ?? 'all';
  const [envProject, setEnvProject] = useState<Project | null>(null);
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState<number>(readRailWidth);
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(readCollapsed);
  const [resizing, setResizing] = useState(false);
  const [sort, setSort] = useState<RailSort>(readSort);
  const [folded, setFolded] = useState<boolean>(readFolded);
  const widthRef = useRef(width);
  widthRef.current = width;

  const { data: projects, error } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  // A failed poll leaves the last answer in place; with none, nothing is live
  // and "Recent" falls back to name order.
  const { data: activity } = useEntity(K.projectActivity, () => skill.projectActivity());

  useEffect(() => {
    const id = setInterval(() => {
      invalidate(K.projectActivity);
    }, 10_000);
    return (): void => {
      clearInterval(id);
    };
  }, []);

  const allSelected = scope === 'all';

  // The folded rail has no filter input, so a leftover query must not hide tiles.
  const activeQuery = folded ? '' : query.trim().toLowerCase();

  const filtered = useMemo(() => {
    const list = projects ?? [];
    if (activeQuery.length === 0) return list;
    return list.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(activeQuery));
  }, [projects, activeQuery]);

  const groups = useMemo(() => {
    const byName = (a: Project, b: Project): number =>
      projectLabel(a, getDisplayName(a.id, a.name)).localeCompare(
        projectLabel(b, getDisplayName(b.id, b.name)),
        undefined,
        { sensitivity: 'base' }
      );
    // Recent: newest activity first; projects with none sink, in name order.
    const compare =
      sort === 'az'
        ? byName
        : (a: Project, b: Project): number =>
            lastActivityMs(activity, b.id) - lastActivityMs(activity, a.id) || byName(a, b);
    return SECTIONS.map(sec => ({
      ...sec,
      items: filtered.filter(p => (p.account ?? 'other') === sec.key).sort(compare),
    })).filter(g => g.key !== 'other' || g.items.length > 0);
  }, [filtered, sort, activity]);

  const isLive = (id: string): boolean => activity?.[id]?.live === true;

  const chooseSort = (next: RailSort): void => {
    setSort(next);
    writeSort(next);
  };

  const toggleFolded = (): void => {
    setFolded(prev => {
      writeFolded(!prev);
      return !prev;
    });
  };

  const toggleSection = (key: SectionKey): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      writeCollapsed(next);
      return next;
    });
  };

  // A filter searches inside collapsed sections too, or its hits would hide.
  const filtering = activeQuery.length > 0;

  // Pointer-driven resize; width clamps to [RAIL_MIN, RAIL_MAX] and persists
  // on release. Pointer capture keeps the drag alive outside the handle.
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    let latest = startW;
    setResizing(true);
    const move = (ev: PointerEvent): void => {
      latest = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + (ev.clientX - startX)));
      setWidth(latest);
    };
    const up = (): void => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writeRailWidth(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const railWidth = folded ? RAIL_FOLDED_WIDTH : width;

  return (
    <nav
      aria-label="Projects"
      style={{ width: railWidth, flexBasis: railWidth }}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface-inset"
    >
      {/* Header: brand + label + count + sort + filter; the logo alone when folded */}
      {folded ? (
        <div className="flex justify-center pb-3 pt-4">
          <img
            src="/hk47.svg"
            alt="HK-47"
            title="HK-47 console"
            width={24}
            height={24}
            className="shrink-0 select-none"
            draggable={false}
          />
        </div>
      ) : (
        <div className="px-3.5 pb-2.5 pt-4">
          <div className="flex items-center gap-2.5 px-1 pb-4">
            <img
              src="/hk47.svg"
              alt=""
              aria-hidden="true"
              width={22}
              height={22}
              className="shrink-0 select-none"
              draggable={false}
            />
            <span className="brand-text text-base font-semibold tracking-tight">HK-47</span>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
              console
            </span>
            <ThemeToggle />
          </div>
          <div className="flex items-center gap-2 px-1 pb-3">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
              Projects
            </span>
            <span className="rounded-full border border-border bg-surface-elevated px-2 py-px font-mono text-[10.5px] font-bold text-text-secondary">
              {(projects ?? []).length}
            </span>
            <SortToggle value={sort} onChange={chooseSort} />
          </div>
          <div
            className="flex h-[34px] items-center gap-2 rounded-[9px] border bg-surface px-2.5 text-text-tertiary transition-colors focus-within:text-text-secondary"
            style={{ borderColor: 'var(--border)' }}
          >
            <span aria-hidden className="font-mono text-[12px] leading-none">
              ⌕
            </span>
            <input
              value={query}
              onChange={e => {
                setQuery(e.target.value);
              }}
              placeholder="Filter projects…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                }}
                title="Clear"
                aria-label="Clear filter"
                className="cursor-pointer rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <span aria-hidden className="text-[11px] leading-none">
                  ✕
                </span>
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* ALL scope */}
      {folded ? (
        <div className="flex justify-center pb-1">
          <button
            type="button"
            onClick={() => {
              navigate('/console');
            }}
            title="All projects"
            aria-label="All projects"
            aria-pressed={allSelected}
            className={`relative ${RAIL_ICON_BUTTON_CLASS} ${
              allSelected ? 'bg-surface-elevated text-text-primary' : ''
            }`}
          >
            {allSelected ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute -left-[11px] bottom-[9px] top-[9px] w-[3px] rounded-r-[3px]"
              />
            ) : null}
            <LayoutGrid aria-hidden className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="px-2.5">
          <button
            type="button"
            onClick={() => {
              navigate('/console');
            }}
            title="All projects"
            aria-label="All projects"
            aria-pressed={allSelected}
            className={`cursor-pointer relative flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${
              allSelected
                ? 'bg-surface-elevated text-text-primary'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            {allSelected ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute -left-px bottom-[9px] top-[9px] w-[3px] rounded-r-[3px]"
              />
            ) : null}
            <span>All projects</span>
          </button>
        </div>
      )}

      {/* Grouped project list */}
      {folded ? (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto overflow-x-hidden pb-3 pt-2 [scrollbar-width:none]">
          {error !== undefined ? (
            <span
              title={error.message}
              aria-label={`Projects failed to load: ${error.message}`}
              className="rounded border border-error/40 bg-error/10 px-1.5 font-mono text-[10px] text-error"
            >
              !
            </span>
          ) : null}
          {groups.map(g => (
            <div key={g.key} className="flex flex-col items-center gap-1.5">
              <span
                title={`${g.label} · ${String(g.items.length)}`}
                className="flex flex-col items-center gap-0.5 font-mono text-[10px] font-bold uppercase"
                style={{ color: g.stripe }}
              >
                {g.label[0]}
                <span
                  aria-hidden
                  className="h-0.5 w-5 rounded-full"
                  style={{ background: g.stripe }}
                />
              </span>
              {g.items.map(p => (
                <ProjectMonogramTile
                  key={p.id}
                  project={p}
                  selected={scope === p.id}
                  live={isLive(p.id)}
                  onClick={() => {
                    navigate(`/console/p/${p.id}`);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3 pt-1">
          {error !== undefined ? (
            <span
              title={error.message}
              className="mx-2 rounded border border-error/40 bg-error/10 px-2 py-1 font-mono text-[10px] text-error"
            >
              {error.message}
            </span>
          ) : null}
          {groups.map(g => {
            const open = filtering || !collapsed.has(g.key);
            return (
              <div key={g.key} className="mb-2 border-l-2 pl-1" style={{ borderColor: g.stripe }}>
                <button
                  type="button"
                  onClick={() => {
                    toggleSection(g.key);
                  }}
                  aria-expanded={open}
                  title={open ? `Collapse ${g.label}` : `Expand ${g.label}`}
                  className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 pb-1 pt-2 text-left text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  <span
                    aria-hidden
                    className="font-mono text-[10.5px] font-semibold"
                    style={{ color: g.stripe }}
                  >
                    {open ? '[-]' : '[+]'}
                  </span>
                  <span className="truncate font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em]">
                    {g.label}
                  </span>
                  <span className="font-mono text-[10px]">{g.items.length}</span>
                  <span aria-hidden className="h-px flex-1 bg-border/60" />
                </button>
                {open
                  ? g.items.map(p => (
                      <ProjectRow
                        key={p.id}
                        project={p}
                        selected={scope === p.id}
                        live={isLive(p.id)}
                        onClick={() => {
                          navigate(`/console/p/${p.id}`);
                        }}
                        onRemove={() => {
                          void handleRemove(p.id);
                          if (scope === p.id) navigate('/console');
                        }}
                        onEditEnv={() => {
                          setEnvProject(p);
                        }}
                      />
                    ))
                  : null}
              </div>
            );
          })}
          {filtered.length === 0 && error === undefined ? (
            <div className="px-3 py-6 text-center text-[12.5px] text-text-tertiary">
              No projects match “{query}”.
            </div>
          ) : null}
        </div>
      )}

      {/* Add project */}
      <div className={`border-t border-border ${folded ? 'flex justify-center py-3' : 'p-3'}`}>
        {folded ? (
          <button
            type="button"
            onClick={onAddProject}
            title="Add project"
            aria-label="Add project"
            className="cursor-pointer flex h-9 w-9 items-center justify-center rounded-[10px] border border-border bg-surface text-base font-semibold leading-none text-accent-bright transition-colors hover:border-accent-bright/50 hover:bg-surface-hover"
          >
            <span aria-hidden="true">+</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddProject}
            title="Add project"
            aria-label="Add project"
            className="cursor-pointer flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface px-3 py-2.5 text-left text-[13px] font-semibold text-text-secondary transition-colors hover:border-accent-bright/50 hover:bg-surface-hover hover:text-text-primary"
          >
            <span aria-hidden="true" className="text-base leading-none text-accent-bright">
              +
            </span>
            <span>Add project</span>
          </button>
        )}
      </div>

      {/* Nav menu, under Add project and separated from it by the border-t
          divider; the fold control sits last. */}
      <div
        className={`flex flex-col gap-0.5 border-t border-border py-2 ${
          folded ? 'items-center' : 'px-2.5'
        }`}
      >
        <RailNavLink
          to="/console/builder"
          icon={PenTool}
          label="Workflow Builder"
          title="Visual workflow builder (beta)"
          badge="beta"
          iconOnly={folded}
        />
        <RailNavLink
          to="/console/metrics"
          icon={BarChart3}
          label="Metrics"
          title="Tokens, cost, sessions, workflows, gate and queue"
          iconOnly={folded}
        />
        <RailNavLink
          to="/console/settings"
          icon={Settings}
          label="Settings"
          title="Settings ( , )"
          iconOnly={folded}
        />
        <RailNavLink
          to="/legacy/workflows"
          icon={Workflow}
          label="Workflows"
          title="Workflows (classic UI)"
          iconOnly={folded}
        />
        {folded ? (
          <button
            type="button"
            onClick={toggleFolded}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className={RAIL_ICON_BUTTON_CLASS}
          >
            <PanelLeftOpen aria-hidden className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleFolded}
            title="Collapse sidebar"
            className={RAIL_NAV_LINK_CLASS}
          >
            <PanelLeftClose aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Collapse</span>
          </button>
        )}
      </div>

      {/* Resize handle; a folded rail has one width */}
      {folded ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          onPointerDown={startResize}
          className="group absolute -right-1 top-0 z-10 flex h-full w-[9px] cursor-col-resize items-center justify-center"
        >
          <span
            aria-hidden
            className={`w-[2px] rounded-sm transition-all ${
              resizing
                ? 'h-full bg-accent-bright'
                : 'h-9 bg-transparent group-hover:h-14 group-hover:bg-accent-bright/60'
            }`}
          />
        </div>
      )}

      <EnvVarsDialog
        projectId={envProject?.id ?? ''}
        projectName={envProject?.name ?? ''}
        open={envProject !== null}
        onClose={() => {
          setEnvProject(null);
        }}
      />
    </nav>
  );
}

const SORT_OPTIONS: readonly { value: RailSort; label: string; title: string }[] = [
  { value: 'az', label: 'A-Z', title: 'Sort projects by name' },
  { value: 'recent', label: 'Recent', title: 'Sort projects by latest Claude Code activity' },
];

/** Two-state sort switch beside the project count, pill-styled like it. */
function SortToggle({
  value,
  onChange,
}: {
  value: RailSort;
  onChange: (next: RailSort) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="Sort projects"
      className="ml-auto flex items-center rounded-full border p-px"
      style={{ borderColor: 'var(--border)' }}
    >
      {SORT_OPTIONS.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => {
            onChange(o.value);
          }}
          aria-pressed={value === o.value}
          title={o.title}
          className={`cursor-pointer rounded-full px-2 py-px font-mono text-[10px] font-bold uppercase tracking-[0.06em] transition-colors ${
            value === o.value
              ? 'bg-surface-elevated text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ThemeToggle(): ReactElement {
  const theme = useConsoleTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => {
        setConsoleTheme(next);
      }}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className="cursor-pointer rounded-full border border-border p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-accent-bright"
    >
      {theme === 'dark' ? (
        <Sun size={12} strokeWidth={2} aria-hidden />
      ) : (
        <Moon size={12} strokeWidth={2} aria-hidden />
      )}
    </button>
  );
}
