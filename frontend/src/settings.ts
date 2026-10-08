import { store } from './lib/storage';

export type Theme = 'paper' | 'dark' | 'eink' | 'analogue' | 'analogue-dark';

export const THEMES: readonly Theme[] = ['paper', 'dark', 'eink', 'analogue', 'analogue-dark'];

/** Per-device preferences. Nothing here is document content. */
export interface Settings {
  theme: Theme;
  typewriter: boolean;
  wordCount: boolean;
  /** Rolled-up word counts in the library (kinds that show them). */
  libraryCounts: boolean;
  timer: boolean;
  timerMinutes: number;
  sidebar: boolean | null; // null = default for screen size
  autolockMinutes: number;
  /** A faint grain on the window frame (Analogue themes only). */
  grain: boolean;
}

const DEFAULTS: Settings = {
  theme: 'paper',
  typewriter: true,
  wordCount: true,
  libraryCounts: true,
  timer: false,
  timerMinutes: 25,
  sidebar: null,
  autolockMinutes: 5,
  grain: true,
};

const KEY = 'cadence.settings';
const listeners = new Set<(s: Settings) => void>();

let current: Settings = { ...DEFAULTS, ...store.json<Partial<Settings>>(KEY, {}) };

const params = new URLSearchParams(window.location.search);
const forced = params.get('theme');
if (THEMES.includes(forced as Theme)) current.theme = forced as Theme;

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  store.set(KEY, JSON.stringify(current));
  for (const fn of listeners) fn(current);
}

export function onSettings(fn: (s: Settings) => void): void {
  listeners.add(fn);
}

export function applyTheme(theme: Theme, grain = current.grain): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.grain = grain ? 'on' : 'off';
  // The browser bar takes the theme's background, read from its tokens.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
