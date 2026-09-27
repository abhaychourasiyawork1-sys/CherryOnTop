import { store } from './sync.js';

/** Appearance, as a person chooses it: follow the system, or pin one. Dark is
 *  the design's home; "system" is the default so a light-desktop user is not
 *  surprised. Per-person, local — never backend state. */
export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'cot.theme.v1';

export function themePreference(): ThemePreference {
  const raw = store.get(KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

let unfollow: (() => void) | null = null;

export function applyTheme(preference: ThemePreference = themePreference()): void {
  store.set(KEY, preference);
  unfollow?.();
  unfollow = null;
  const root = document.documentElement;
  if (preference !== 'system') {
    root.dataset.theme = preference;
    return;
  }
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  const sync = () => { root.dataset.theme = media?.matches ? 'light' : 'dark'; };
  sync();
  media?.addEventListener('change', sync);
  unfollow = () => media?.removeEventListener('change', sync);
}
