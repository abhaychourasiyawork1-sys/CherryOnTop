import type { OrgNode, Approval } from './useOrg.js';

/** Cached state → authoritative reconciliation → current state.
 *
 *  The daemon is the only source of truth. The window keeps a copy of the last
 *  tree it was told about so it can draw *something* instantly on launch and
 *  while the daemon is unreachable — but every consumer is told whether what it
 *  is drawing is authoritative, so nothing cached is ever presented as live.
 *  Reconciliation is a wholesale replace: the daemon's answer wins, including
 *  about things that disappeared. Only UI-local state (drafts, layout) lives
 *  under different keys and is never touched by it. */

export interface Snapshot {
  version: 1;
  savedAt: string;
  nodes: OrgNode[];
  approvals: Approval[];
}

const SNAPSHOT_KEY = 'cot.snapshot.v1';
const LAST_SEEN_KEY = 'cot.lastSeen.v1';
/** Enough for Home and the sidebar; not an archive. */
const MAX_NODES = 800;

/** localStorage can be absent or throw (private windows, full quota). Every
 *  read and write goes through these, so a storage failure costs a cache miss,
 *  never a crash. */
export const store = {
  get(key: string): string | null {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set(key: string, value: string): void {
    try { globalThis.localStorage?.setItem(key, value); } catch { /* cache only */ }
  },
  remove(key: string): void {
    try { globalThis.localStorage?.removeItem(key); } catch { /* cache only */ }
  },
};

export function encodeSnapshot(nodes: OrgNode[], approvals: Approval[], now = new Date()): string {
  const newest = [...nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_NODES);
  return JSON.stringify({ version: 1, savedAt: now.toISOString(), nodes: newest, approvals } satisfies Snapshot);
}

export function decodeSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.approvals)) return null;
    const nodes = parsed.nodes.filter((node): node is OrgNode =>
      Boolean(node) && typeof node.id === 'string' && typeof node.state === 'string' && typeof node.goal === 'string');
    return { version: 1, savedAt: String(parsed.savedAt ?? ''), nodes, approvals: parsed.approvals as Approval[] };
  } catch {
    return null;
  }
}

export function loadSnapshot(): Snapshot | null {
  return decodeSnapshot(store.get(SNAPSHOT_KEY));
}

export function saveSnapshot(nodes: OrgNode[], approvals: Approval[]): void {
  store.set(SNAPSHOT_KEY, encodeSnapshot(nodes, approvals));
}

/** When the person last had this window in front of them. "While you were
 *  away" is everything that settled after it. Read once at launch, written
 *  whenever the window is hidden or closed. */
export function lastSeen(): string | null {
  return store.get(LAST_SEEN_KEY);
}

export function markSeen(now = new Date()): void {
  store.set(LAST_SEEN_KEY, now.toISOString());
}

/** A per-Workspace key, for UI-only state that must survive reconciliation. */
export function localKey(kind: 'layout' | 'draft' | 'branches' | 'sidebar', scope = ''): string {
  return `cot.${kind}.v1${scope ? `:${scope}` : ''}`;
}
