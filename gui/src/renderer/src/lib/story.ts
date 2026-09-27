import { titleOf } from './run.js';
import { clip } from './format.js';
import type { OrgEvent } from './eventLog.js';
import type { OrgNode } from './useOrg.js';

/** The organization timeline, told as a story.
 *
 *  This reads the same append-only event log everything else does — it is a
 *  second *view*, not a second history. Meaningful state changes become
 *  sentences; everything else (the exec firehose, context receipts, economic
 *  bookkeeping) is counted into the entry it happened under, never deleted, and
 *  is one click away in Details with its original row ids. */

export interface StoryEntry {
  id: string;
  at: string;
  nodeId: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'good' | 'problem' | 'you';
  /** Row ids of every event this entry stands for, so it links back to the
   *  raw record. */
  sourceIds: number[];
  /** How many routine events were folded into this entry. */
  folded: number;
}

type Narrate = (event: OrgEvent, node: OrgNode | undefined, isRoot: boolean) =>
  Omit<StoryEntry, 'id' | 'at' | 'nodeId' | 'sourceIds' | 'folded'> | null;

const NARRATORS: Record<string, Narrate> = {
  'state.transition': (event, node, isRoot) => {
    const state = (event.payload as { state?: string } | null)?.state;
    const what = node ? titleOf(node.goal) : 'An agent';
    if (state === 'CREATED') {
      return isRoot
        ? { title: 'You asked', detail: what, tone: 'you' }
        : { title: 'An agent took on a piece', detail: what, tone: 'neutral' };
    }
    if (state === 'COMPLETE') return { title: isRoot ? 'Work completed' : 'A piece was finished', detail: what, tone: 'good' };
    if (state === 'FAILED') {
      return node?.supersededBy
        ? { title: 'A piece failed and was handed to a fresh agent', detail: what, tone: 'neutral' }
        : { title: isRoot ? 'Work failed' : 'A piece failed', detail: what, tone: 'problem' };
    }
    if (state === 'CANCELLED') return { title: 'Work was stopped', detail: what, tone: 'neutral' };
    if (state === 'WAIT_APPROVAL') return { title: 'Stopped to ask you', detail: what, tone: 'you' };
    return null;
  },
  'decision.made': (event) => {
    const outcome = (event.payload as { outcome?: string } | null)?.outcome;
    if (outcome === 'DELEGATE') return { title: 'A decision was made', detail: 'Split the work across agents', tone: 'neutral' };
    if (outcome === 'SELF_EXECUTE') return { title: 'A decision was made', detail: 'Do the work as one agent', tone: 'neutral' };
    if (outcome === 'ESCALATE') return { title: 'A decision was made', detail: 'Stop and ask you', tone: 'you' };
    return null;
  },
  'validation.result': (event) => {
    const p = event.payload as { passed?: boolean; level?: string } | null;
    return p?.passed
      ? { title: 'Verification passed', detail: p.level ? `Level ${p.level}` : '', tone: 'good' }
      : null;
  },
  'authority.denied': (event) => {
    const p = event.payload as { tool?: string; reason?: string } | null;
    return { title: 'The mandate refused a tool', detail: p?.tool ?? p?.reason ?? '', tone: 'neutral' };
  },
  'node.interrupted': () => ({ title: 'Paused when the daemon stopped', detail: 'Work so far is kept.', tone: 'problem' }),
  'node.answer': (event) => ({
    title: 'An answer was written',
    detail: clip(((event.payload as { text?: string } | null)?.text ?? '').replace(/[#*`|>-]/g, '').replace(/\s+/g, ' ').trim(), 120),
    tone: 'good',
  }),
  'step.outcome': (event) => {
    const p = event.payload as { succeeded?: boolean; message?: string } | null;
    return p?.succeeded === false ? { title: 'A step did not succeed', detail: clip(p.message ?? '', 160), tone: 'problem' } : null;
  },
};

/** Events → story. Consecutive entries with the same title collapse into one
 *  ("3 agents took on a piece"), deterministically, keeping every source id. */
export function toStory(events: OrgEvent[], nodes: OrgNode[], rootId: string | null = null): StoryEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const entries: StoryEntry[] = [];
  let pendingFolded = 0;
  let pendingIds: number[] = [];

  for (const event of events) {
    const node = byId.get(event.nodeId);
    const isRoot = rootId ? event.nodeId === rootId : !node?.parentId;
    const narrated = NARRATORS[event.type]?.(event, node, isRoot) ?? null;
    if (!narrated) {
      pendingFolded += 1;
      if (event.id !== undefined) pendingIds.push(event.id);
      continue;
    }
    const last = entries.at(-1);
    const ids = event.id !== undefined ? [event.id] : [];
    if (last && last.title === narrated.title && last.tone === narrated.tone && last.title !== 'You asked') {
      last.sourceIds.push(...pendingIds, ...ids);
      last.folded += pendingFolded;
      last.detail = collapseDetail(last, narrated.detail);
    } else {
      // Routine events belong to the entry they led up to.
      entries.push({
        id: `story:${event.id ?? `${event.createdAt}:${entries.length}`}`,
        at: event.createdAt,
        nodeId: event.nodeId,
        ...narrated,
        sourceIds: [...pendingIds, ...ids],
        folded: pendingFolded,
      });
    }
    pendingFolded = 0;
    pendingIds = [];
  }
  const tail = entries.at(-1);
  if (tail && pendingFolded > 0) {
    tail.folded += pendingFolded;
    tail.sourceIds.push(...pendingIds);
  }
  return entries;
}

function collapseDetail(entry: StoryEntry, next: string): string {
  if (entry.title === 'An agent took on a piece' || entry.title === 'A piece was finished') {
    const count = entry.detail.match(/^(\d+) pieces · /)?.[1];
    return `${count ? Number(count) + 1 : 2} pieces · latest: ${next}`;
  }
  return next || entry.detail;
}

/** Groups story entries under a time heading, the way a person skims a day. */
export function byTimeOf(entries: StoryEntry[]): { heading: string; entries: StoryEntry[] }[] {
  const groups: { heading: string; entries: StoryEntry[] }[] = [];
  for (const entry of entries) {
    const heading = new Date(entry.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const last = groups.at(-1);
    if (last && last.heading === heading) last.entries.push(entry);
    else groups.push({ heading, entries: [entry] });
  }
  return groups;
}
