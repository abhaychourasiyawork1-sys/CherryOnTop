import type { JSX } from 'react';
import type { DemoNodeId } from '../demo/types';
import type { Status } from '../types';
import { StatusIndicator } from './StatusIndicator';
import { ProductMetric } from './ProductMetric';

export function ExecutionNode(props: {
  id: DemoNodeId;
  title: string;
  role: string;
  status: Status;
  budget: string;
  selected?: boolean;
  onInspect: () => void;
}): JSX.Element {
  const { id, title, role, status, budget, selected = false, onInspect } = props;
  return (
    <button
      type="button"
      className={`execution-node${selected ? ' execution-node--selected' : ''}`}
      data-node-id={id}
      aria-pressed={selected}
      onClick={onInspect}
    >
      <span className="execution-node__header">
        <span className="execution-node__title">{title}</span>
        <StatusIndicator status={status} />
      </span>
      <span className="execution-node__role">{role}</span>
      <ProductMetric label="Budget" value={budget} mono />
    </button>
  );
}
