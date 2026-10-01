import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Components } from 'react-markdown';
import { useConsoleTheme } from '../lib/theme';

/**
 * Fenced `mermaid` and `vega-lite` blocks render as graphics, in chat and in
 * artifacts alike (PERS-14). Both libraries are heavy, so each is imported the
 * first time a page needs it and never before.
 *
 * Replies stream, so a fence is re-parsed as it grows and fails until it
 * closes. Rendering waits for the text to settle, and a parse failure shows the
 * plain code block instead of an error card: a half-written diagram is a code
 * block that is still arriving, not a fault.
 */

const LANGUAGES = new Set(['mermaid', 'vega-lite', 'vegalite']);
const SETTLE_MS = 300;

interface HastNode {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function textOf(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function fenceOf(pre: HastNode | undefined): { lang: string; source: string } | null {
  const code = pre?.children?.find(c => c.tagName === 'code');
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  const lang = list.find(c => c.startsWith('language-'))?.slice('language-'.length);
  return lang && LANGUAGES.has(lang) ? { lang, source: textOf(code) } : null;
}

/** Mermaid and Vega want sRGB, the livery is written in oklch, and the browser
 * is the only reliable converter: paint one pixel and read it back. The tokens
 * live on .console-root, not on :root, so they are read off the graphic's own
 * element. */
function tokenIn(name: string, scope: Element): string {
  const raw = getComputedStyle(scope).getPropertyValue(name).trim();
  const ctx = document.createElement('canvas').getContext('2d');
  if (!raw || !ctx) return '#888888';
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let mermaidTheme = '';

/** Mermaid reads its palette once at initialize(), so a theme switch re-initializes it. */
function loadMermaid(scope: Element): Promise<typeof import('mermaid').default> {
  const token = (name: string): string => tokenIn(name, scope);
  const theme = document.documentElement.dataset.consoleTheme ?? 'dark';
  if (theme !== mermaidTheme) mermaidReady = null;
  mermaidTheme = theme;
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        darkMode: theme !== 'light',
        background: token('--surface'),
        primaryColor: token('--surface-elevated'),
        primaryTextColor: token('--text-primary'),
        primaryBorderColor: token('--accent'),
        secondaryColor: token('--surface-variant'),
        tertiaryColor: token('--surface-inset'),
        lineColor: token('--text-secondary'),
        textColor: token('--text-primary'),
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
    });
    return mermaid;
  });
  return mermaidReady;
}

let renderCount = 0;

async function renderMermaid(el: HTMLElement, source: string): Promise<() => void> {
  const mermaid = await loadMermaid(el);
  // render() on bad input leaves mermaid's own error graphic in the page, so
  // an unclosed fence is refused here, quietly, before it gets that far.
  if (!(await mermaid.parse(source, { suppressErrors: true })))
    throw new Error('mermaid: not yet valid');
  const { svg } = await mermaid.render(`hk47-mermaid-${++renderCount}`, source);
  el.innerHTML = svg; // mermaid's own output, sanitised under securityLevel 'strict'
  return () => {
    el.innerHTML = '';
  };
}

/** Categorical slots in fixed order, validated for CVD separation on the dark
 * surface (dataviz validate_palette.js, 2026-09-27). Status colours are never
 * series colours, so warning and error are deliberately absent. */
const CATEGORY_TOKENS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
];

async function renderVegaSpec(el: HTMLElement, spec: Record<string, unknown>): Promise<() => void> {
  const [{ default: embed }, { loader }] = await Promise.all([
    import('vega-embed'),
    import('vega'),
  ]);
  // PERS-30: a spec comes from agent output, so it may not touch the network.
  // data.url could read /api/* with this origin's standing, and an image mark
  // or href could beacon it anywhere on render. Inline data.values still works.
  const offline = loader();
  offline.load = (): Promise<string> => Promise.reject(new Error('charts take inline data only'));
  offline.sanitize = (): Promise<{ href: string }> =>
    Promise.reject(new Error('charts load no external resources'));
  const token = (name: string): string => tokenIn(name, el);
  const text = token('--text-secondary');
  const grid = token('--border');
  const surface = token('--surface-inset');
  const result = await embed(el, spec, {
    loader: offline,
    // Interpret expressions instead of compiling them with Function(): vega's
    // codegen sandbox has been escaped before (CVE-2025-59840).
    ast: true,
    actions: false,
    renderer: 'svg',
    tooltip: {
      theme: document.documentElement.dataset.consoleTheme === 'light' ? 'light' : 'dark',
    },
    config: {
      background: 'transparent',
      font: getComputedStyle(document.body).fontFamily,
      mark: { color: token('--chart-1'), tooltip: true },
      bar: { cornerRadiusEnd: 4, stroke: surface, strokeWidth: 1 },
      line: { strokeWidth: 2 },
      point: { size: 64 },
      range: { category: CATEGORY_TOKENS.map(token) },
      axis: {
        labelColor: text,
        titleColor: text,
        gridColor: grid,
        domainColor: grid,
        tickColor: grid,
        labelFontSize: 11,
        titleFontSize: 11,
        titleFontWeight: 'normal',
      },
      legend: { labelColor: text, titleColor: text, orient: 'top', symbolType: 'circle' },
      title: { color: token('--text-primary'), anchor: 'start', fontSize: 13, fontWeight: 600 },
      view: { stroke: 'transparent' },
    },
  });
  return () => {
    result.finalize();
  };
}

async function renderVega(el: HTMLElement, source: string): Promise<() => void> {
  return renderVegaSpec(el, JSON.parse(source) as Record<string, unknown>);
}

/** A vega-lite spec rendered in the livery, for pages that build charts from data. */
export function VegaChart({ spec }: { spec: Record<string, unknown> }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const theme = useConsoleTheme();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    renderVegaSpec(el, spec)
      .then(done => {
        if (cancelled) done();
        else cleanup = done;
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(e instanceof Error ? e.message : String(e));
      });
    return (): void => {
      cancelled = true;
      cleanup?.();
    };
  }, [spec, theme]);
  return failed ? (
    <p className="text-[12px] text-text-tertiary">Chart failed: {failed}</p>
  ) : (
    <div ref={ref} className="w-full [&_svg]:max-w-full" />
  );
}

function Graphic({
  lang,
  source,
  fallback,
}: {
  lang: string;
  source: string;
  fallback: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  // Until a render succeeds the code block shows, so a streaming fence reads
  // as code arriving rather than as an empty frame.
  const [drawn, setDrawn] = useState(false);
  const theme = useConsoleTheme();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      const render = lang === 'mermaid' ? renderMermaid : renderVega;
      render(el, source)
        .then(done => {
          if (cancelled) done();
          else {
            cleanup = done;
            setDrawn(true);
          }
        })
        .catch(() => {
          if (!cancelled) setDrawn(false);
        });
    }, SETTLE_MS);
    return (): void => {
      cancelled = true;
      clearTimeout(timer);
      cleanup?.();
    };
  }, [lang, source, theme]);

  return (
    <>
      <div
        ref={ref}
        className={
          drawn
            ? 'my-2 overflow-x-auto rounded border border-border bg-surface-inset p-3 [&_svg]:mx-auto [&_svg]:max-w-full'
            : 'hidden'
        }
      />
      {drawn ? null : fallback}
    </>
  );
}

/**
 * A `pre` renderer that draws graphic fences and hands every other block to
 * `plain`. A components map with its own `pre` must build it with this:
 * spreading GRAPHIC_COMPONENTS and then redefining `pre` silently drops the
 * graphics, which is how chat went without them.
 */
export function graphicPre(
  plain: (props: ComponentProps<'pre'>) => ReactElement
): NonNullable<Components['pre']> {
  return ({ node, ...props }) => {
    const fence = fenceOf(node as HastNode | undefined);
    const fallback = plain(props);
    return fence ? (
      <Graphic lang={fence.lang} source={fence.source} fallback={fallback} />
    ) : (
      fallback
    );
  };
}

/**
 * PERS-30: a markdown image from agent output would be fetched the moment the
 * message renders, a zero-click beacon to any host. Same-origin and data:
 * images draw; anything else becomes a link that loads only if clicked.
 */
export const safeImg: NonNullable<Components['img']> = ({ src, alt }) => {
  const url = typeof src === 'string' ? src : '';
  let local = url.startsWith('data:image/');
  try {
    local ||= new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    local = false;
  }
  if (local) return <img src={url} alt={alt ?? ''} className="max-w-full" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline">
      [image{alt ? `: ${alt}` : ''}]
    </a>
  );
};

/** Merge into a react-markdown `components` map that has no `pre` of its own. */
export const GRAPHIC_COMPONENTS: Components = {
  pre: graphicPre(props => <pre {...props} />),
  img: safeImg,
};
