import { useEffect, useRef, useState } from 'react';
import { daemon } from './client.js';
import { mergeEvents, type OrgEvent } from './eventLog.js';
import { changesOrg } from './liveness.js';

export interface OrgNode {
  id: string;
  parentId: string | null;
  goal: string;
  state: string;
  contract: {
    goal: string;
    definition_of_done: string[];
    authority: { tools: string[]; spawn_children: boolean; max_child_count: number; budget_usd: number };
    constraints: string[];
    deadline?: { expected_at?: string; hard_at?: string };
  };
  repoPath?: string | null;
  createdAt: string;
  updatedAt: string;
  /** From node.overview: spend rolled up through this node's subtree, and how
   *  much of its authorized budget that is. */
  costUsd: number;
  budgetHealth: number;
  childCount: number;
  needsApproval: boolean;
}

export interface Approval {
  id: string;
  nodeId: string;
  reason: string;
  status: string;
  createdAt: string;
}

export interface Org {
  nodes: OrgNode[];
  approvals: Approval[];
  events: OrgEvent[];
  connected: boolean;
  error: string | null;
  refresh: () => void;
  /** Bumped every time the organization changed. Panels that read the daemon
   *  through their own query put this in their dependencies, which is what makes
   *  them live — without it they show whatever was true when they mounted, for
   *  ever. */
  revision: number;
  /** What the daemon says it serves, for the compatibility check. */
  routers: string[] | undefined;
}

/** The single source of live truth for the window: the node tree, the approvals
 *  waiting on a human, and the event stream. Everything re-reads the tree when
 *  an event says the shape changed, rather than polling — the daemon already
 *  pushes, and a poll would make a still organization look busy. */
export function useOrg(): Org {
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [routers, setRouters] = useState<string[] | undefined>(undefined);
  const [events, setEvents] = useState<OrgEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  // Bumped when the event stream drops. Re-running the subscribe effect both
  // reconnects and re-seeds history, so anything that happened while the socket
  // was down still arrives. Without this a dropped socket left the conversation
  // frozen and looking merely idle — the daemon restarting was enough to do it.
  const [streamAttempt, setStreamAttempt] = useState(0);

  // Re-reading the tree on every streamed event would be a query per token of
  // Claude Code output. Coalesce to one read per animation frame's worth of
  // events instead.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => { pending.current = null; refresh(); }, 120);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      daemon().node.overview.query(),
      daemon().node.listPendingApprovals.query(),
      // Asked alongside the tree rather than on its own: if the daemon is too
      // old to answer, that has to be known before anything renders a panel
      // that depends on a router it does not have.
      daemon().daemon.ping.query().catch(() => null),
    ])
      .then(([tree, pendingApprovals, ping]) => {
        if (cancelled) return;
        setNodes(tree as OrgNode[]);
        setApprovals(pendingApprovals as Approval[]);
        setRouters((ping as { routers?: string[] } | null)?.routers);
        setConnected(true);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConnected(false);
        setError(
          err instanceof Error && /fetch|ECONNREFUSED/i.test(err.message)
            ? 'The daemon is not running. Start it with `org daemon start`, then reopen this window.'
            : String(err),
        );
      });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | null = null;
    // mergeEvents dedupes on the row id, so re-seeding after a reconnect costs
    // nothing and fills whatever gap the outage left.
    daemon().events.recent.query({ limit: 400 })
      .then((history) => setEvents((current) => mergeEvents(current, history as OrgEvent[])))
      .catch(() => { /* history is a nicety; the live stream is the point */ });

    const reconnect = () => {
      if (retry) return;
      retry = setTimeout(() => { retry = null; setStreamAttempt((n) => n + 1); }, 1500);
    };

    const subscription = daemon().events.subscribe.subscribe(
      {},
      {
        onData: (event: OrgEvent) => {
          setEvents((current) => mergeEvents(current, [event]));
          // A transition changes the tree's shape, a result changes what it has
          // spent, a denial changes what needs a person. The exec.* firehose
          // changes none of those and must never trigger a read — see
          // liveness.ts.
          if (changesOrg(event.type)) scheduleRefresh();
        },
        onError: () => reconnect(),
        // A clean close is still a stopped stream — the daemon going away looks
        // exactly like this, and it must not be mistaken for "nothing happening".
        onComplete: () => reconnect(),
      },
    );
    return () => {
      subscription.unsubscribe();
      if (retry) clearTimeout(retry);
      if (pending.current) clearTimeout(pending.current);
    };
  }, [streamAttempt]);

  // A reconnect means time passed with no updates; the tree and approvals have
  // to be re-read, not just the events.
  useEffect(() => {
    if (streamAttempt > 0) refresh();
  }, [streamAttempt]);

  // `tick` counts reads of the tree, which is exactly "the organization may
  // have changed" — the signal every other panel needs and none of them had.
  return { nodes, approvals, events, connected, error, refresh, revision: tick, routers };
}
