export interface OrgEvent {
  id?: number;
  nodeId: string;
  type: string;
  payload?: unknown;
  createdAt: string;
}

const CAP = 4000;

/** Merges live events into replayed history. The daemon hands every event a
 *  monotonic row id (src/events/bus.ts) precisely so a client that replayed
 *  `events.recent` and then subscribed can tell a genuine new event from one it
 *  has already rendered — timestamps cannot, several routinely share a
 *  millisecond during a fast run.
 *
 *  Returns the same array reference when nothing was added, so React can skip
 *  the re-render. */
export function mergeEvents(existing: OrgEvent[], incoming: OrgEvent[]): OrgEvent[] {
  const seen = new Set(existing.map((e) => e.id).filter((id): id is number => id !== undefined));
  const fresh = incoming.filter((event) => {
    if (event.id === undefined) return true; // no id to dedupe on — trust the sender
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  if (fresh.length === 0) return existing;
  const merged = [...existing, ...fresh].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  // ponytail: a flat cap on retained events. Page older ones back in from
  // events.recent's `before` cursor if scrollback ever needs to go deeper.
  return merged.length > CAP ? merged.slice(merged.length - CAP) : merged;
}
