import { useState, type JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { useDemoController } from '../demo/controller';
import { DecisionReceipt, type ReceiptViewModel } from '../components/DecisionReceipt';

function fieldValue(label: string): string {
  const field = SITE_CONTENT.receipt.fields.find((entry) => entry.label === label);
  if (!field) {
    throw new Error(`missing receipt field: ${label}`);
  }
  return field.value;
}

const RECEIPT: ReceiptViewModel = {
  objective: fieldValue('OBJECTIVE'),
  decision: SITE_CONTENT.receipt.decision,
  authority: fieldValue('AUTHORITY'),
  budget: fieldValue('BUDGET'),
  spend: fieldValue('SPEND'),
  actions: fieldValue('ACTIONS'),
  artifacts: fieldValue('ARTIFACTS'),
  validation: fieldValue('VALIDATION'),
  humanIntervention: fieldValue('HUMAN INTERVENTION'),
  outcome: 'VERIFIED',
};

export function AccountabilitySection(): JSX.Element {
  const { snapshot } = useDemoController();
  const [expanded, setExpanded] = useState(false);

  if (!snapshot.receiptVisible) {
    return (
      <div className="accountability-section" data-testid="accountability-pending">
        <p className="accountability-section__pending">
          The decision receipt generates once the run is verified.
        </p>
      </div>
    );
  }

  return (
    <div className="accountability-section">
      <DecisionReceipt
        receipt={RECEIPT}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
    </div>
  );
}
