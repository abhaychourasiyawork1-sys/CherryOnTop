import { money, clip } from '../lib/format.js';

export interface CustodyHop {
  nodeId: string;
  goal: string;
  authority: { tools: string[]; spawn_children: boolean; max_child_count: number; budget_usd: number };
  narrowed: string[];
}

export interface CustodyChain {
  origin: 'human';
  hops: CustodyHop[];
}

/** Where this agent's authority came from, and what each hand gave up passing it
 *  on. The chain always begins with a person, because authority has to come from
 *  somewhere and every other view of an agent quietly declines to say where.
 *
 *  Compact by default — it sits above artifacts and decisions, and a five-line
 *  block there would push the thing it annotates off the screen. */
export function Custody({ chain, onOpenNode }: { chain: CustodyChain; onOpenNode?: (id: string) => void }) {
  if (chain.hops.length === 0) return null;

  return (
    <ol className="custody" aria-label="Chain of custody">
      <li className="custody-hop custody-origin">
        <span className="custody-name">You</span>
        <span className="custody-note">authorized this</span>
      </li>
      {chain.hops.map((hop, index) => (
        <li key={hop.nodeId} className="custody-hop" data-last={index === chain.hops.length - 1}>
          <button
            type="button"
            className="custody-name linkish"
            onClick={() => onOpenNode?.(hop.nodeId)}
            title={hop.goal}
          >
            {index === 0 ? 'Root agent' : clip(hop.goal, 34)}
          </button>
          <span className="custody-note figure">{money(hop.authority.budget_usd)}</span>
          {hop.narrowed.length > 0 && (
            <span className="custody-narrowed" title={hop.narrowed.join('; ')}>
              ⛨ {hop.narrowed[0]}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
