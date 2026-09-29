import { useSyncExternalStore } from 'react';

/**
 * Console light/dark switch. The mode lives on <html data-console-theme> rather
 * than on .console-root, because portals (WorkflowPicker) mount their own
 * .console-root outside the app's tree and must follow the same switch.
 */

export type ConsoleTheme = 'dark' | 'light';

const KEY = 'archon.console.theme';
const EVENT = 'archon-console-theme';

function read(): ConsoleTheme {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

export function applyConsoleTheme(theme: ConsoleTheme = read()): void {
  document.documentElement.dataset.consoleTheme = theme;
}

export function setConsoleTheme(theme: ConsoleTheme): void {
  localStorage.setItem(KEY, theme);
  applyConsoleTheme(theme);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return (): void => {
    window.removeEventListener(EVENT, onChange);
  };
}

export function useConsoleTheme(): ConsoleTheme {
  return useSyncExternalStore(subscribe, read);
}
