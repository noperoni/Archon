/**
 * HK-47 fork: UI zoom per screen, not per site.
 *
 * The browser's own zoom is stored per origin, so every console window shares
 * one level: 100% reads small on the 4K screen, and zooming in there overzooms
 * the Full HD one. The console takes over the zoom keys (Ctrl + = / - / 0 and
 * Ctrl + wheel) and remembers a level per screen, keyed by its size and pixel
 * ratio, re-applied whenever the window lands on another screen.
 *
 * Applied as CSS `zoom` on <html> so portalled dialogs and menus scale too;
 * theme.css divides `.console-root`'s viewport size by the same factor, since
 * a zoomed 100vh would otherwise overflow the window.
 */
import { useEffect } from 'react';

const STORAGE_KEY = 'console.uiZoom';
// Chrome's own ladder, so the steps feel like the ones they replace.
const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

function screenKey(): string {
  return `${String(window.screen.width)}x${String(window.screen.height)}@${String(window.devicePixelRatio)}`;
}

function readLevels(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function apply(level: number): void {
  const root = document.documentElement;
  root.style.setProperty('zoom', String(level));
  root.style.setProperty('--ui-zoom', String(level));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(level: number): void {
  let el = document.getElementById('ui-zoom-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ui-zoom-toast';
    el.className = 'ui-zoom-toast';
    document.body.appendChild(el);
  }
  el.textContent = `${String(Math.round(level * 100))}% on ${String(window.screen.width)}×${String(window.screen.height)}`;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (el) el.style.opacity = '0';
  }, 1200);
}

export function useScreenZoom(): void {
  useEffect(() => {
    let key = screenKey();
    const current = (): number => readLevels()[key] ?? 1;
    apply(current());

    const set = (level: number): void => {
      // 100% is the default, so it is dropped rather than stored.
      const levels = Object.fromEntries(
        Object.entries({ ...readLevels(), [key]: level }).filter(([, v]) => v !== 1)
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(levels));
      apply(level);
      toast(level);
    };
    const step = (dir: 1 | -1): void => {
      const now = current();
      const next =
        dir > 0 ? STEPS.find(s => s > now + 1e-3) : [...STEPS].reverse().find(s => s < now - 1e-3);
      if (next !== undefined) set(next);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === '=' || e.key === '+') step(1);
      else if (e.key === '-' || e.key === '_') step(-1);
      else if (e.key === '0') set(1);
      else return;
      e.preventDefault();
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    };
    // Moving the window to another screen resizes it (and changes the pixel
    // ratio when the scales differ); re-key and re-apply when the screen changed.
    const onResize = (): void => {
      const next = screenKey();
      if (next === key) return;
      key = next;
      apply(current());
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);
    return (): void => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
    };
  }, []);
}
