/** The adaptive workspace's layout, as data.
 *
 *  Conversation is always the primary surface. Everything else — a file, a plan,
 *  a decision, a run — opens *beside* it as a side surface, or takes over the
 *  main area as a deep dive. This module is the whole policy for that, pure and
 *  serializable, so the rules that stop the window from filling up with panels
 *  are testable without a DOM:
 *
 *  - transient by default: opening something new evicts the oldest transient
 *    surface rather than adding a third column;
 *  - pinned surfaces survive `dropTransients` and are the only thing persisted;
 *  - a deep dive replaces the main area and never stacks.
 *
 *  None of this is backend state. Closing a surface never changes anything the
 *  daemon knows. */

export type SurfaceKind =
  | 'conversation'
  | 'artifact'
  | 'files'
  | 'plan'
  | 'run'
  | 'result'
  | 'decision'
  | 'activity'
  | 'attention'
  | 'memory'
  | 'organization'
  | 'deep-dive';

export type Persistence = 'transient' | 'pinned' | 'deepDive';

export interface Surface {
  /** Stable identity: kind plus the object it shows, so opening the same file
   *  twice focuses the one already open. */
  id: string;
  kind: SurfaceKind;
  /** The Workspace object this surface is about — a path, a case id, a
   *  decision id. Null for surfaces about the Workspace as a whole. */
  contextId: string | null;
  persistence: Persistence;
  /** Preferred width in px. Clamped on every write. */
  width: number;
  collapsed: boolean;
}

export interface Layout {
  version: 1;
  /** Side surfaces, oldest first. */
  side: Surface[];
  deepDive: Surface | null;
}

const KINDS: readonly SurfaceKind[] = [
  'conversation', 'artifact', 'files', 'plan', 'run', 'result', 'decision',
  'activity', 'attention', 'memory', 'organization', 'deep-dive',
];

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 760;
/** More than two side columns next to a conversation is a dashboard. */
export const MAX_OPEN = 2;

const DEFAULT_WIDTH: Partial<Record<SurfaceKind, number>> = {
  artifact: 560,
  decision: 440,
  plan: 380,
  files: 340,
  memory: 400,
};

export const EMPTY: Layout = { version: 1, side: [], deepDive: null };

export function surfaceId(kind: SurfaceKind, contextId: string | null): string {
  return contextId ? `${kind}:${contextId}` : kind;
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_WIDTH;
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
}

export interface OpenOptions {
  /** Open as a deep dive, taking over the main area. */
  deepDive?: boolean;
  pinned?: boolean;
}

/** Opens a surface, or re-focuses it when it is already open. */
export function open(layout: Layout, kind: SurfaceKind, contextId: string | null = null, options: OpenOptions = {}): Layout {
  const id = surfaceId(kind, contextId);

  if (options.deepDive) {
    return {
      ...layout,
      deepDive: { id, kind, contextId, persistence: 'deepDive', width: MAX_WIDTH, collapsed: false },
    };
  }

  const existing = layout.side.find((surface) => surface.id === id);
  if (existing) {
    // Move to the end (most recent) and make sure it is visible.
    const rest = layout.side.filter((surface) => surface.id !== id);
    const refreshed = {
      ...existing,
      collapsed: false,
      persistence: options.pinned ? 'pinned' as const : existing.persistence,
    };
    return enforceLimit({ ...layout, side: [...rest, refreshed] }, id);
  }

  const surface: Surface = {
    id, kind, contextId,
    persistence: options.pinned ? 'pinned' : 'transient',
    width: clampWidth(DEFAULT_WIDTH[kind] ?? 400),
    collapsed: false,
  };

  // A decision is the thing to read now: the other transient context steps
  // aside rather than competing with it for width.
  const side = kind === 'decision'
    ? layout.side.filter((other) => other.persistence === 'pinned')
    : layout.side;

  return enforceLimit({ ...layout, side: [...side, surface] }, id);
}

/** At most MAX_OPEN visible side surfaces. The oldest transient one goes first;
 *  if every visible surface is pinned, the oldest pinned one collapses (it is
 *  kept — pinning is a promise not to lose it). `keep` is never evicted. */
function enforceLimit(layout: Layout, keep: string): Layout {
  let side = layout.side;
  while (side.filter((surface) => !surface.collapsed).length > MAX_OPEN) {
    const victim = side.find((surface) => !surface.collapsed && surface.id !== keep && surface.persistence === 'transient');
    if (victim) {
      side = side.filter((surface) => surface.id !== victim.id);
      continue;
    }
    const pinned = side.find((surface) => !surface.collapsed && surface.id !== keep);
    if (!pinned) break;
    side = side.map((surface) => (surface.id === pinned.id ? { ...surface, collapsed: true } : surface));
  }
  return { ...layout, side };
}

export function close(layout: Layout, id: string): Layout {
  if (layout.deepDive?.id === id) return { ...layout, deepDive: null };
  return { ...layout, side: layout.side.filter((surface) => surface.id !== id) };
}

export function closeDeepDive(layout: Layout): Layout {
  return layout.deepDive ? { ...layout, deepDive: null } : layout;
}

export function setPinned(layout: Layout, id: string, pinned: boolean): Layout {
  return {
    ...layout,
    side: layout.side.map((surface) =>
      surface.id === id ? { ...surface, persistence: pinned ? 'pinned' : 'transient' } : surface),
  };
}

export function setCollapsed(layout: Layout, id: string, collapsed: boolean): Layout {
  const next = {
    ...layout,
    side: layout.side.map((surface) => (surface.id === id ? { ...surface, collapsed } : surface)),
  };
  return collapsed ? next : enforceLimit(next, id);
}

export function resize(layout: Layout, id: string, width: number): Layout {
  return {
    ...layout,
    side: layout.side.map((surface) => (surface.id === id ? { ...surface, width: clampWidth(width) } : surface)),
  };
}

/** Everything goes except what was pinned. What leaving a context does. */
export function dropTransients(layout: Layout): Layout {
  return { ...layout, side: layout.side.filter((surface) => surface.persistence === 'pinned'), deepDive: null };
}

/** The clean baseline: just the conversation. */
export function reset(): Layout {
  return EMPTY;
}

/** Which side surfaces actually get a column at this window width. A narrow
 *  window shows only the most recent one; the rest stay open but collapsed to
 *  a chip, so nothing becomes an unusable 200px pane. */
export function visible(layout: Layout, windowWidth: number): Surface[] {
  const open = layout.side.filter((surface) => !surface.collapsed);
  const room = windowWidth < 1100 ? 1 : MAX_OPEN;
  return open.slice(-room);
}

/** Only pinned surfaces are remembered between launches; transient ones are,
 *  by definition, about a moment that has passed. */
export function serialize(layout: Layout): string {
  return JSON.stringify({
    version: 1,
    side: layout.side.filter((surface) => surface.persistence === 'pinned'),
    deepDive: null,
  } satisfies Layout);
}

/** Restores a serialized layout, dropping anything malformed or no longer
 *  valid. `exists` lets the caller discard a surface whose object is gone (a
 *  deleted case, a file from another Workspace) rather than render it empty. */
export function restore(raw: string | null | undefined, exists: (surface: Surface) => boolean = () => true): Layout {
  if (!raw) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) return EMPTY;
  const side = Array.isArray((parsed as { side?: unknown }).side) ? (parsed as { side: unknown[] }).side : [];
  const seen = new Set<string>();
  const valid: Surface[] = [];
  for (const candidate of side) {
    const surface = sanitize(candidate);
    if (!surface || seen.has(surface.id) || !exists(surface)) continue;
    seen.add(surface.id);
    valid.push(surface);
  }
  return enforceLimit({ version: 1, side: valid, deepDive: null }, valid.at(-1)?.id ?? '');
}

function sanitize(value: unknown): Surface | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !KINDS.includes(v.kind as SurfaceKind)) return null;
  if (v.kind === 'conversation' || v.kind === 'deep-dive') return null;
  const contextId = typeof v.contextId === 'string' ? v.contextId : null;
  const kind = v.kind as SurfaceKind;
  return {
    id: surfaceId(kind, contextId),
    kind,
    contextId,
    persistence: 'pinned',
    width: clampWidth(typeof v.width === 'number' ? v.width : DEFAULT_WIDTH[kind] ?? 400),
    collapsed: v.collapsed === true,
  };
}
