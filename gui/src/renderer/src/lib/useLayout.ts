import { useCallback, useEffect, useRef, useState } from 'react';
import * as S from './surfaces.js';
import { store, localKey } from './sync.js';

/** The surface layout for one Workspace. Pinned surfaces persist per
 *  Workspace; transient ones live only in memory. Every change is undoable —
 *  layout is UI state, so it gets ordinary Undo, not an accountable Revert. */
export function useLayout(workspaceKey: string | null) {
  const storageKey = localKey('layout', workspaceKey ?? 'none');
  const [layout, setLayout] = useState<S.Layout>(() => S.restore(store.get(storageKey)));
  const past = useRef<S.Layout[]>([]);
  // Where focus was when each surface opened, so closing it puts focus back
  // rather than dropping it on <body>.
  const openers = useRef(new Map<string, HTMLElement>());
  const remember = (id: string) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) openers.current.set(id, active);
  };
  const restoreFocus = (id: string) => {
    const opener = openers.current.get(id);
    openers.current.delete(id);
    requestAnimationFrame(() => { if (opener?.isConnected) opener.focus(); });
  };
  const loadedFor = useRef(storageKey);

  // Switching Workspace swaps in that Workspace's pinned surfaces.
  useEffect(() => {
    if (loadedFor.current === storageKey) return;
    loadedFor.current = storageKey;
    past.current = [];
    setLayout(S.restore(store.get(storageKey)));
  }, [storageKey]);

  useEffect(() => {
    if (loadedFor.current === storageKey) store.set(storageKey, S.serialize(layout));
  }, [layout, storageKey]);

  const apply = useCallback((change: (current: S.Layout) => S.Layout) => {
    setLayout((current) => {
      const next = change(current);
      if (next !== current) past.current = [...past.current.slice(-30), current];
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous) setLayout(previous);
    return Boolean(previous);
  }, []);

  return {
    layout,
    open: (kind: S.SurfaceKind, contextId: string | null = null, options?: S.OpenOptions) => {
      remember(options?.deepDive ? 'deep' : S.surfaceId(kind, contextId));
      apply((l) => S.open(l, kind, contextId, options));
    },
    close: (id: string) => {
      apply((l) => S.close(l, id));
      restoreFocus(id);
    },
    pin: (id: string, pinned: boolean) => apply((l) => S.setPinned(l, id, pinned)),
    collapse: (id: string, collapsed: boolean) => apply((l) => S.setCollapsed(l, id, collapsed)),
    resize: (id: string, width: number) => setLayout((l) => S.resize(l, id, width)),
    closeDeepDive: () => {
      apply(S.closeDeepDive);
      restoreFocus('deep');
    },
    dropTransients: () => apply(S.dropTransients),
    reset: () => apply(() => S.reset()),
    undo,
    canUndo: () => past.current.length > 0,
  };
}

export type LayoutApi = ReturnType<typeof useLayout>;
