import type { JSX } from 'react';
import { StatusIndicator } from './StatusIndicator';

export interface ReceiptViewModel {
  objective: string;
  decision: string;
  authority: string;
  budget: string;
  spend: string;
  actions: string;
  artifacts: string;
  validation: string;
  humanIntervention: string;
  outcome: 'VERIFIED';
}

const FIELD_ORDER: Array<{ key: keyof ReceiptViewModel; label: string }> = [
  { key: 'objective', label: 'OBJECTIVE' },
  { key: 'decision', label: 'DECISION' },
  { key: 'authority', label: 'AUTHORITY' },
  { key: 'budget', label: 'BUDGET' },
  { key: 'spend', label: 'SPEND' },
  { key: 'actions', label: 'ACTIONS' },
  { key: 'artifacts', label: 'ARTIFACTS' },
  { key: 'validation', label: 'VALIDATION' },
  { key: 'humanIntervention', label: 'HUMAN INTERVENTION' },
  { key: 'outcome', label: 'OUTCOME' },
];

export function DecisionReceipt(props: {
  receipt: ReceiptViewModel;
  expanded?: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { receipt, expanded = false, onToggle } = props;

  return (
    <div className={`decision-receipt${expanded ? ' decision-receipt--expanded' : ''}`}>
      <div className="decision-receipt__summary">
        <p className="decision-receipt__objective">{receipt.objective}</p>
        <StatusIndicator status="verified" label={receipt.outcome} />
      </div>

      <button
        type="button"
        className="decision-receipt__toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? 'Hide full receipt' : 'View full receipt'}
      </button>

      {expanded ? (
        <div className="decision-receipt__fields" data-testid="decision-receipt-fields">
          {FIELD_ORDER.map(({ key, label }) => (
            <p key={key} className="decision-receipt__field">
              {`${label}: ${receipt[key]}`}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
