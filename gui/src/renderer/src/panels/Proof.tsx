import { useMemo, useState } from 'react';
import { WhyPanel } from './WhyPanel.js';
import { Custody } from './Custody.js';
import { ago, clip } from '../lib/format.js';
import { toLedgerEntries, matchesLens, type Lens, type LedgerEntry } from '../lib/ledger.js';
import type { OrgEvent } from '../lib/eventLog.js';
import type { OrgNode } from '../lib/useOrg.js';
import type { CustodyChain } from './Custody.js';

const LENSES: { id: Lens; label: string; hint: string }[] = [
  { id: 'all', label: 'Everything', hint: 'Every recorded moment' },
  { id: 'decisions', label: 'Decisions', hint: 'Every scored choice, with its arithmetic' },
  { id: 'produced', label: 'Produced', hint: 'Files written, commands run, results returned' },
  { id: 'authority', label: 'Authority', hint: 'Boundaries reached, and tools refused' },
  { id: 'people', label: 'People', hint: 'Every point a human decided something' },
];

interface Props {
  nodes: OrgNode[];
  events: OrgEvent[];
  decisions: { id: string; nodeId: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string }[];
  artifacts: { id: string; nodeId: string; kind: string; path: string | null; summary: string; createdAt: string }[];
  approvals: { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }[];
  custody: Record<string, CustodyChain>;
  onOpenNode: (nodeId: string) => void;
}

/**
 * The evidence ledger: everything that happened, filtered by the question you
 * are actually asking.
 *
 * Deliberately not a log viewer. A log answers "what did the process emit"; this
 * answers "what was decided, what was produced, what was refused, and where did
 * a person intervene" — which are the only four questions anyone has ever asked
 * of an agent run after the fact.
 */
export function Proof(props: Props) {
  const [lens, setLens] = useState<Lens>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(props.nodes.map((node) => [node.id, node])), [props.nodes]);

  const entries = useMemo<LedgerEntry[]>(
    () => toLedgerEntries({
      nodeIds: props.nodes.map((node) => node.id),
      events: props.events,
      decisions: props.decisions,
      artifacts: props.artifacts,
      approvals: props.approvals,
    }),
    [props.nodes, props.events, props.decisions, props.artifacts, props.approvals],
  );

  const shown = entries.filter((entry) => matchesLens(entry, lens));

  return (
    <div className="proof">
      <nav className="proof-lenses" aria-label="Filter the record">
        {LENSES.map((option) => (
          <button
            key={option.id}
            type="button"
            className="chip"
            aria-pressed={lens === option.id}
            title={option.hint}
            onClick={() => setLens(option.id)}
          >
            {option.label}
          </button>
        ))}
      </nav>

      {shown.length === 0 ? (
        <p className="tab-empty">Nothing of that kind is on the record for this case yet.</p>
      ) : (
        <ol className="ledger-list">
          {shown.map((entry) => {
            const node = byId.get(entry.nodeId);
            const open = openId === entry.key;
            return (
              <li key={entry.key} className="ledger-entry" data-kind={entry.kind}>
                <button
                  type="button"
                  className="ledger-row"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : entry.key)}
                >
                  <span className="ledger-kind" aria-hidden="true">{MARKS[entry.kind]}</span>
                  <span className="ledger-title">{entry.title}</span>
                  <span className="ledger-who">{node ? clip(node.goal, 34) : entry.nodeId.slice(0, 8)}</span>
                  <span className="figure ledger-when">{ago(entry.at)}</span>
                </button>

                {open && (
                  <div className="ledger-detail">
                    {props.custody[entry.nodeId] && (
                      <Custody chain={props.custody[entry.nodeId]} onOpenNode={props.onOpenNode} />
                    )}
                    {entry.detail && <p className="ledger-detail-text">{entry.detail}</p>}
                    {entry.decision && <WhyPanel decision={entry.decision} />}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const MARKS: Record<LedgerEntry['kind'], string> = {
  decision: '⟐', artifact: '▪', denial: '⛨', approval: '☖',
};
