import { CARD_WIDTH, CARD_HEIGHT, type PlacedNode } from './layout.js';
import { toneOf, labelOf } from '../lib/state.js';
import type { OrgNode } from '../lib/useOrg.js';
import { agentName } from '../lib/agentName.js';

interface Props {
  node: OrgNode;
  place: PlacedNode;
  childCount: number;
  costUsd: number;
  needsApproval: boolean;
  delegatedAuthority: boolean;
  selected: boolean;
  fresh: boolean;
  /** The agent the run started with — the one you gave the goal to. */
  isLead?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** Called when the card takes keyboard focus, so the canvas can bring it into
   *  view. The container does not scroll any more, so nothing else will. */
  onReveal: () => void;
}

export function NodeCard(props: Props) {
  const { node, place, costUsd } = props;
  const tone = props.needsApproval ? 'at-risk' : toneOf(node.state, node.supersededBy);
  const budget = node.contract.authority.budget_usd;
  const spent = budget > 0 ? Math.min(costUsd / budget, 1) : 0;

  return (
    <button
      type="button"
      className="node-card"
      aria-pressed={props.selected}
      data-executing={tone === 'executing'}
      data-fresh={props.fresh}
      data-state={node.state}
      data-lead={props.isLead}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
      onFocus={props.onReveal}
      style={{
        left: place.x,
        top: place.y,
        width: CARD_WIDTH,
        minHeight: CARD_HEIGHT,
        // The state hue is set once here and every child reads var(--state), so
        // a card is never half one colour and half another.
        ['--state' as string]: `var(--${tone})`,
        ['--depth' as string]: place.depth,
      }}
    >
      <span className="node-name">
        {props.isLead ? 'Lead agent' : agentName(node.goal, 34)}
        {node.state === 'COMPLETE' && <span className="node-done" aria-label="Finished">✓</span>}
      </span>
      <span className="node-goal" title={node.goal}>{node.goal}</span>

      <span className="node-row">
        <span className="node-state">{labelOf(node.state, node.supersededBy)}</span>
        {props.delegatedAuthority && (
          <span className="authority-mark" title="Runs under narrowed authority">⛨</span>
        )}
        {props.childCount > 0 && (
          <span className="figure" title={`${props.childCount} delegated`}>{props.childCount}↓</span>
        )}
      </span>

      <span className="budget-meter" aria-hidden="true">
        <span className="budget-fill" style={{ width: `${spent * 100}%` }} />
      </span>

      <span className="node-row">
        <span className="figure">
          ${costUsd.toFixed(2)}
          <span style={{ color: 'var(--ink-faint)' }}> / {budget.toFixed(2)}</span>
        </span>
      </span>
    </button>
  );
}
