import { useState } from 'react';
import { daemon } from '../lib/client.js';

export interface DodItem {
  id: string;
  nodeId: string;
  text: string;
  state: 'met' | 'unmet' | 'unverified';
  artifactId: string | null;
  note: string | null;
  checkedAt: string | null;
}

const STATES: Record<DodItem['state'], { mark: string; tone: string; label: string }> = {
  met: { mark: '✓', tone: 'executing', label: 'Met' },
  unmet: { mark: '✕', tone: 'failed', label: 'Not met' },
  unverified: { mark: '?', tone: 'at-risk', label: 'Unverified' },
};

/** What the organization promised, and whether it delivered it.
 *
 *  The distinction that makes this worth having over a bullet list: `unverified`
 *  is a real answer. A run that reported success and produced nothing to show
 *  for it lands here, not in green — which is the single most common way an
 *  agent quietly fails. A person can overrule any row, and the override is
 *  recorded as a person's, not laundered into the machine's verdict. */
export function DodList(props: {
  items: DodItem[];
  onChanged?: () => void;
  /** Read-only inside a Receipt: a receipt records what was decided, it is not
   *  a place to decide. */
  editable?: boolean;
}) {
  if (props.items.length === 0) {
    return <p className="tab-empty">Nothing was promised, so there is nothing to check.</p>;
  }

  return (
    <ul className="dod">
      {props.items.map((item) => (
        <DodRow key={item.id} item={item} editable={props.editable ?? false} onChanged={props.onChanged} />
      ))}
    </ul>
  );
}

function DodRow({ item, editable, onChanged }: { item: DodItem; editable: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const state = STATES[item.state];

  const set = async (next: DodItem['state']) => {
    setBusy(true);
    try {
      await daemon().node.setDod.mutate({
        id: item.id,
        state: next,
        artifactId: item.artifactId,
        note: 'Set by you.',
      });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="dod-item" style={{ ['--state' as string]: `var(--${state.tone})` }}>
      <span className="dod-mark" aria-label={state.label}>{state.mark}</span>
      <div className="dod-body">
        <p className="dod-text">{item.text}</p>
        {item.note && <p className="dod-note">{item.note}</p>}
      </div>
      {editable && (
        <span className="dod-actions">
          {(['met', 'unmet', 'unverified'] as const)
            .filter((next) => next !== item.state)
            .map((next) => (
              <button
                key={next}
                type="button"
                className="dod-set"
                disabled={busy}
                onClick={() => void set(next)}
                title={`Mark ${STATES[next].label.toLowerCase()}`}
              >
                {STATES[next].mark}
              </button>
            ))}
        </span>
      )}
    </li>
  );
}
