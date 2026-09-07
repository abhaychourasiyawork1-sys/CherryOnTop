import { useMemo, useState } from 'react';
import { OrgGraph } from '../graph/OrgGraph.js';
import { projectTo, momentsOf } from '../lib/timetravel.js';
import { money, when } from '../lib/format.js';
import type { OrgNode, Approval } from '../lib/useOrg.js';
import type { OrgEvent } from '../lib/eventLog.js';

interface Props {
  nodes: OrgNode[];
  approvals: Approval[];
  events: OrgEvent[];
  freshNodeIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * The organization, with its own history on a track underneath.
 *
 * The graph was always live-only, which meant the most interesting thing about
 * a finished case — how it got that shape — was unrecoverable. Nothing new is
 * stored to make this work: events are append-only and timestamped, so the past
 * was always there, just never asked for.
 */
export function Organization(props: Props) {
  const scoped = useMemo(
    () => props.events.filter((event) => props.nodes.some((node) => node.id === event.nodeId)),
    [props.events, props.nodes],
  );
  const moments = useMemo(() => momentsOf(scoped), [scoped]);
  // null means "now" — the live view. An explicit index means the user has
  // scrubbed, and the view must then stop following the tail.
  const [index, setIndex] = useState<number | null>(null);

  const live = index === null || moments.length === 0;
  const moment = live ? null : projectTo(props.nodes, scoped, moments[Math.min(index, moments.length - 1)]);

  const shown = moment?.nodes ?? props.nodes;
  const shownApprovals = moment
    ? props.approvals.filter((approval) => moment.awaitingNodeIds.has(approval.nodeId))
    : props.approvals;

  const spend = shown.filter((node) => !node.parentId).reduce((sum, node) => sum + node.costUsd, 0);

  return (
    <div className="organization">
      <OrgGraph
        nodes={shown}
        approvals={shownApprovals}
        // Never animate a spawn while scrubbing: a node "appearing" as you drag
        // backwards would read as it being created, which is the opposite of
        // what happened.
        freshNodeIds={live ? props.freshNodeIds : EMPTY}
        selectedId={props.selectedId}
        onSelect={props.onSelect}
        onOpen={props.onSelect}
      />

      {moments.length > 1 && (
        <div className="scrubber">
          <button
            type="button"
            className="scrub-now"
            aria-pressed={live}
            onClick={() => setIndex(null)}
            title="Back to the live view"
          >
            {live ? 'Live' : 'Back to live'}
          </button>

          <input
            type="range"
            min={0}
            max={moments.length - 1}
            step={1}
            value={index ?? moments.length - 1}
            aria-label="Replay this organization"
            onChange={(event) => setIndex(Number(event.target.value))}
          />

          <span className="scrub-readout figure">
            {live ? agentCount(shown.length) : `${when(moment!.at)} · ${agentCount(shown.length)}`}
            {' · '}{money(spend)}
          </span>
        </div>
      )}
    </div>
  );
}

const EMPTY = new Set<string>();

function agentCount(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'}`;
}
