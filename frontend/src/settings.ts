import { store } from './lib/storage';

export type Theme = 'paper' | 'dark' | 'eink';

/** Per-device preferences. Nothing here is document content. */
export interface Settings {
  theme: Theme;
  typewriter: boolean;
  wordCount: boolean;
  timer: boolean;
  timerMinutes: number;
  sidebar: boolean | null; // null = default for screen size
  autolockMinutes: number;
}

const DEFAULTS: Settings = {
  theme: 'paper',
  typewriter: true,
  wordCount: true,
  timer: false,
  timerMinutes: 25,
  sidebar: null,
  autolockMinutes: 5,
};

const KEY = 'cadence.settings';
const listeners = new Set<(s: Settings) => void>();

let current: Settings = { ...DEFAULTS, ...store.json<Partial<Settings>>(KEY, {}) };

const params = new URLSearchParams(window.location.search);
const forced = params.get('theme');
if (forced === 'paper' || forced === 'dark' || forced === 'eink') current.theme = forced;

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

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  const colors: Record<Theme, string> = { paper: '#f7f4ee', dark: '#1c1b19', eink: '#ffffff' };
  meta?.setAttribute('content', colors[theme]);
}
