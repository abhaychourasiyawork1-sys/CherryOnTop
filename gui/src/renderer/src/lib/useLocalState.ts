import { useEffect, useState } from 'react';
import { store } from './sync.js';

/** UI-only state that survives a relaunch: a collapsed sidebar, pinned
 *  surfaces, a draft. Never backend state — reconciliation never touches it.
 *  Re-reads when `key` changes, so per-Workspace state follows the Workspace. */
export function useLocalState<T>(key: string, decode: (raw: string | null) => T, encode: (value: T) => string = JSON.stringify) {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: decode(store.get(key)) }));
  const current = state.key === key ? state.value : decode(store.get(key));

  useEffect(() => {
    if (state.key !== key) setState({ key, value: decode(store.get(key)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = (next: T | ((previous: T) => T)) => {
    setState((previous) => {
      const base = previous.key === key ? previous.value : decode(store.get(key));
      const value = typeof next === 'function' ? (next as (p: T) => T)(base) : next;
      store.set(key, encode(value));
      return { key, value };
    });
  };

  return [current, set] as const;
}
