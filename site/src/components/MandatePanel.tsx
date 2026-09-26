import type { JSX } from 'react';
import { ProductMetric } from './ProductMetric';
import { StatusIndicator } from './StatusIndicator';

export function MandatePanel(props: {
  action: string;
  currentAuthority: string;
  requiredAuthority: string;
  approved: boolean;
  onReview: () => void;
}): JSX.Element {
  const { action, currentAuthority, requiredAuthority, approved, onReview } = props;
  return (
    <div className="mandate-panel">
      <p className="mandate-panel__action">{action}</p>
      <div className="mandate-panel__authority">
        <ProductMetric label="Current authority" value={currentAuthority} />
        <ProductMetric label="Required authority" value={requiredAuthority} />
      </div>
      {approved ? (
        <StatusIndicator status="verified" label="Approved" />
      ) : (
        <StatusIndicator status="attention" label="Human approval required" />
      )}
      <button type="button" className="mandate-panel__review" onClick={onReview}>
        Review
      </button>
    </div>
  );
}
