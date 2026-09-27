import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';
import { VegaChart } from '../components/FencedGraphic';

/**
 * Metrics (PERS-14): every Claude session on the machine, terminal and console,
 * plus Archon's workflows, the HK-47 danger gate and the HK-47 queue. Served by
 * GET /api/hk47/metrics, which keeps an incremental index over the transcripts.
 *
 * Costs are notional: API list prices applied to subscription usage.
 */

type Metrics = components['schemas']['MetricsResponse'];
type Spec = Record<string, unknown>;

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All' },
] as const;

const TOKEN_KINDS = ['Cache read', 'Cache write 1h', 'Cache write 5m', 'Output', 'Input'];
const TOKENS = '.3~s';
const USD = '$,.2f';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const pct = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });

function sized(spec: Spec, height = 220): Spec {
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 'container',
    height,
    ...spec,
  };
}

/** Horizontal bars for a ranked breakdown: long labels read, and rank reads top down. */
function ranked(
  values: object[],
  label: string,
  field: string,
  title: string,
  format = TOKENS
): Spec {
  return sized(
    {
      data: { values },
      mark: 'bar',
      encoding: {
        y: { field: label, type: 'nominal', sort: '-x', title: null },
        x: { field, type: 'quantitative', title, axis: { format } },
        tooltip: [
          { field: label, type: 'nominal' },
          { field, type: 'quantitative', format, title },
        ],
      },
    },
    Math.max(80, values.length * 22)
  );
}

function stackedDaily(
  values: object[],
  series: string,
  domain: string[],
  title: string,
  format = ',d'
): Spec {
  return sized({
    data: { values },
    mark: 'bar',
    encoding: {
      x: { field: 'day', type: 'ordinal', title: null, axis: { labelAngle: -45 } },
      y: { field: 'count', type: 'quantitative', stack: 'zero', title, axis: { format } },
      color: { field: series, type: 'nominal', scale: { domain }, title: null },
      tooltip: [
        { field: 'day', type: 'ordinal' },
        { field: series, type: 'nominal' },
        { field: 'count', type: 'quantitative', format, title },
      ],
    },
  });
}

function specs(m: Metrics): Record<string, Spec> {
  const tokenDays = m.daily.flatMap(d => [
    { day: d.day, kind: 'Input', count: d.input },
    { day: d.day, kind: 'Output', count: d.output },
    { day: d.day, kind: 'Cache read', count: d.cacheRead },
    { day: d.day, kind: 'Cache write 5m', count: d.cacheWrite5m },
    { day: d.day, kind: 'Cache write 1h', count: d.cacheWrite1h },
  ]);
  const activity = m.daily.flatMap(d => [
    { day: d.day, series: 'Sessions', count: d.sessions },
    { day: d.day, series: 'Prompts', count: d.turns },
  ]);
  return {
    tokens: stackedDaily(tokenDays, 'kind', TOKEN_KINDS, 'Tokens', TOKENS),
    output: sized({
      data: { values: m.daily },
      mark: 'bar',
      encoding: {
        x: { field: 'day', type: 'ordinal', title: null, axis: { labelAngle: -45 } },
        y: {
          field: 'output',
          type: 'quantitative',
          title: 'Output tokens',
          axis: { format: TOKENS },
        },
        tooltip: [
          { field: 'day' },
          { field: 'output', type: 'quantitative', format: ',d', title: 'Output tokens' },
        ],
      },
    }),
    cost: sized({
      data: { values: m.daily },
      mark: 'bar',
      encoding: {
        x: { field: 'day', type: 'ordinal', title: null, axis: { labelAngle: -45 } },
        y: {
          field: 'costUsd',
          type: 'quantitative',
          title: 'Notional USD',
          axis: { format: '$,.0f' },
        },
        tooltip: [
          { field: 'day' },
          { field: 'costUsd', type: 'quantitative', format: USD, title: 'Notional USD' },
        ],
      },
    }),
    cache: sized({
      data: { values: m.daily },
      mark: { type: 'line', point: true },
      encoding: {
        x: { field: 'day', type: 'ordinal', title: null, axis: { labelAngle: -45 } },
        y: {
          field: 'cacheHitRatio',
          type: 'quantitative',
          title: 'Prompt tokens served from cache',
          scale: { domain: [0, 1] },
          axis: { format: '%' },
        },
        tooltip: [
          { field: 'day' },
          { field: 'cacheHitRatio', type: 'quantitative', format: '.1%', title: 'Cache hit' },
        ],
      },
    }),
    activity: sized({
      data: { values: activity },
      mark: { type: 'line', point: true },
      encoding: {
        x: { field: 'day', type: 'ordinal', title: null, axis: { labelAngle: -45 } },
        y: { field: 'count', type: 'quantitative', title: 'Count' },
        color: {
          field: 'series',
          type: 'nominal',
          scale: { domain: ['Prompts', 'Sessions'] },
          title: null,
        },
        tooltip: [{ field: 'day' }, { field: 'series' }, { field: 'count', type: 'quantitative' }],
      },
    }),
    projects: ranked(m.byProject, 'project', 'tokens', 'Tokens'),
    projectCost: ranked(m.byProject, 'project', 'costUsd', 'Notional USD', '$,.0f'),
    models: ranked(m.byModel, 'model', 'tokens', 'Tokens'),
    accounts: ranked(m.byAccount, 'account', 'tokens', 'Tokens'),
    origin: ranked(m.byOrigin, 'origin', 'tokens', 'Tokens'),
    subagents: ranked(m.bySidechain, 'kind', 'tokens', 'Tokens'),
    tools: ranked(m.tools, 'tool', 'calls', 'Calls', ',d'),
    workflowDuration: sized({
      data: { values: m.workflows.runs.filter(r => r.durationMs !== null) },
      mark: 'bar',
      encoding: {
        x: {
          field: 'startedAt',
          type: 'ordinal',
          title: null,
          axis: { labels: false, ticks: false },
        },
        y: {
          field: 'durationMs',
          type: 'quantitative',
          title: 'Duration (s)',
          axis: { labelExpr: 'datum.value / 1000' },
        },
        color: {
          field: 'status',
          type: 'nominal',
          scale: { domain: ['completed', 'failed', 'cancelled', 'running'] },
          title: null,
        },
        tooltip: [
          { field: 'name', title: 'Workflow' },
          { field: 'status' },
          { field: 'startedAt', type: 'temporal', format: '%Y-%m-%d %H:%M' },
          { field: 'durationMs', type: 'quantitative', format: ',d', title: 'ms' },
          { field: 'costUsd', type: 'quantitative', format: '$,.3f', title: 'Cost' },
          { field: 'tokens', type: 'quantitative', format: ',d' },
        ],
      },
    }),
    workflowStatus: ranked(m.workflows.byStatus, 'status', 'count', 'Runs', ',d'),
    gate: stackedDaily(m.gate.daily, 'verdict', ['ask', 'deny', 'approved'], 'Gate events'),
    gateRules: ranked(m.gate.rules, 'rule', 'count', 'Stops', ',d'),
    queue: stackedDaily(m.queue.daily, 'flag', ['waiting', 'question', 'permission'], 'Waits'),
  };
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): ReactElement {
  return (
    <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">
        {value}
      </div>
      {note ? <div className="mt-0.5 text-[11px] text-text-tertiary">{note}</div> : null}
    </div>
  );
}

function Panel({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}): ReactElement {
  return (
    <section
      className={`rounded-[10px] border border-border bg-surface p-4 ${wide ? 'lg:col-span-2' : ''}`}
    >
      <h2 className="mb-2 text-[13px] font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors ${
        active
          ? 'border-accent bg-accent-soft text-text-primary'
          : 'border-border text-text-secondary hover:border-accent-bright/50 hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

export function MetricsPage(): ReactElement {
  const [range, setRange] = useState<string>('30');
  const [account, setAccount] = useState<string>('');
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ range });
    if (account) qs.set('account', account);
    requestJson<Metrics>(`/api/hk47/metrics?${qs.toString()}`)
      .then(m => {
        if (!cancelled) {
          setData(m);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [range, account]);

  const charts = useMemo(() => (data ? specs(data) : null), [data]);
  const t = data?.totals;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 px-10 pt-[22px]">
        <h1 className="text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">Metrics</h1>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {RANGES.map(r => (
            <Chip
              key={r.value}
              active={range === r.value}
              onClick={() => {
                setRange(r.value);
              }}
            >
              {r.label}
            </Chip>
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <Chip
            active={account === ''}
            onClick={() => {
              setAccount('');
            }}
          >
            All accounts
          </Chip>
          {(data?.accounts ?? []).map(a => (
            <Chip
              key={a}
              active={account === a}
              onClick={() => {
                setAccount(a);
              }}
            >
              {a}
            </Chip>
          ))}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        {error ? <p className="text-[13px] text-error">Metrics failed: {error}</p> : null}
        {!data && loading ? (
          <p className="text-[13px] text-text-tertiary">
            Indexing transcripts. The first load reads all of them once.
          </p>
        ) : null}
        {data && t && charts ? (
          <div className={`flex flex-col gap-4 ${loading ? 'opacity-60' : ''}`}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <Tile
                label="Tokens"
                value={compact.format(t.tokens)}
                note={`${compact.format(t.output)} output`}
              />
              <Tile label="Notional cost" value={money.format(t.costUsd)} note="API list prices" />
              <Tile label="Cache hit" value={pct.format(t.cacheHitRatio)} note="of prompt tokens" />
              <Tile
                label="Sessions"
                value={compact.format(t.sessions)}
                note={`${compact.format(t.messages)} replies`}
              />
              <Tile
                label="Prompts"
                value={compact.format(t.turns)}
                note={`${compact.format(t.thinking)} thinking tokens`}
              />
              <Tile label="Workflow runs" value={String(t.workflowRuns)} />
              <Tile label="Gate stops" value={String(t.gateStops)} />
              <Tile
                label="Queue waits"
                value={String(t.queueWaits)}
                note={`${data.queue.picks} picks, ${data.queue.pickedAtHead} at head`}
              />
              <Tile
                label="Web"
                value={`${t.webSearches} / ${t.webFetches}`}
                note="searches / fetches"
              />
              <Tile
                label="Transcripts"
                value={String(data.indexedFiles)}
                note={`${data.reparsedFiles} re-read this load`}
              />
            </div>
            {data.unpricedModels.length ? (
              <p className="text-[12px] text-warning">
                Unpriced models, cost excluded: {data.unpricedModels.join(', ')}
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Panel title="Tokens per day, by kind" wide>
                <VegaChart spec={charts.tokens} />
              </Panel>
              <Panel title="Output tokens per day">
                <VegaChart spec={charts.output} />
              </Panel>
              <Panel title="Notional cost per day">
                <VegaChart spec={charts.cost} />
              </Panel>
              <Panel title="Cache hit ratio">
                <VegaChart spec={charts.cache} />
              </Panel>
              <Panel title="Sessions and prompts per day">
                <VegaChart spec={charts.activity} />
              </Panel>
              <Panel title="Tokens by project">
                <VegaChart spec={charts.projects} />
              </Panel>
              <Panel title="Notional cost by project">
                <VegaChart spec={charts.projectCost} />
              </Panel>
              <Panel title="Tokens by model">
                <VegaChart spec={charts.models} />
              </Panel>
              <Panel title="Tokens by account">
                <VegaChart spec={charts.accounts} />
              </Panel>
              <Panel title="Console against terminal">
                <VegaChart spec={charts.origin} />
              </Panel>
              <Panel title="Main thread against subagents">
                <VegaChart spec={charts.subagents} />
              </Panel>
              <Panel title="Top tools">
                <VegaChart spec={charts.tools} />
              </Panel>
              <Panel title="Workflow runs by status">
                <VegaChart spec={charts.workflowStatus} />
              </Panel>
              <Panel title="Workflow run durations" wide>
                <VegaChart spec={charts.workflowDuration} />
              </Panel>
              <Panel title="Danger gate per day">
                <VegaChart spec={charts.gate} />
              </Panel>
              <Panel title="Danger gate, top rules">
                <VegaChart spec={charts.gateRules} />
              </Panel>
              <Panel title="HK-47 queue waits per day" wide>
                <VegaChart spec={charts.queue} />
              </Panel>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
