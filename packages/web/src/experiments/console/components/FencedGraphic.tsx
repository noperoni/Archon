import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';

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

function loadMermaid(scope: Element): Promise<typeof import('mermaid').default> {
  const token = (name: string): string => tokenIn(name, scope);
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        darkMode: true,
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

async function renderVega(el: HTMLElement, source: string): Promise<() => void> {
  const spec = JSON.parse(source) as Record<string, unknown>;
  const { default: embed } = await import('vega-embed');
  const token = (name: string): string => tokenIn(name, el);
  const text = token('--text-secondary');
  const grid = token('--border');
  const result = await embed(el, spec, {
    actions: false,
    renderer: 'svg',
    config: {
      background: 'transparent',
      mark: { color: token('--accent') },
      range: {
        category: [
          '--accent',
          '--brand-teal',
          '--brand-violet',
          '--warning',
          '--error',
          '--running',
        ].map(token),
      },
      axis: {
        labelColor: text,
        titleColor: text,
        gridColor: grid,
        domainColor: grid,
        tickColor: grid,
      },
      legend: { labelColor: text, titleColor: text },
      title: { color: token('--text-primary') },
      view: { stroke: 'transparent' },
    },
  });
  return () => {
    result.finalize();
  };
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
  }, [lang, source]);

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

/** Merge into any react-markdown `components` map. */
export const GRAPHIC_COMPONENTS: Components = {
  pre: ({ node, children, ...props }) => {
    const fence = fenceOf(node as HastNode | undefined);
    const plain = <pre {...props}>{children}</pre>;
    return fence ? <Graphic lang={fence.lang} source={fence.source} fallback={plain} /> : plain;
  },
};
