import type { JSX } from 'react';
import type { Status } from '../types';

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting',
  attention: 'Needs attention',
  recovering: 'Recovering',
  validating: 'Validating',
  verified: 'Verified',
};

const STATUS_ICON: Record<Status, string> = {
  idle: '○',
  working: '●',
  waiting: '◌',
  attention: '▲',
  recovering: '↻',
  validating: '◐',
  verified: '✓',
};

export function StatusIndicator(props: { status: Status; label?: string }): JSX.Element {
  const { status, label } = props;
  return (
    <span className={`status-indicator status-indicator--${status}`}>
      <span className="status-indicator__icon" aria-hidden="true" data-testid="status-icon">
        {STATUS_ICON[status]}
      </span>
      <span className="status-indicator__label">{label ?? STATUS_LABEL[status]}</span>
    </span>
  );
}
