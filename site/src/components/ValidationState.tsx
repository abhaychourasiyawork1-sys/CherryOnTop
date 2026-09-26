import type { JSX } from 'react';
import type { Status } from '../types';
import { StatusIndicator } from './StatusIndicator';

const STATE_TO_STATUS: Record<'running' | 'failed' | 'verified', Status> = {
  running: 'validating',
  failed: 'attention',
  verified: 'verified',
};

export function ValidationState(props: {
  passed: number;
  total: number;
  state: 'running' | 'failed' | 'verified';
}): JSX.Element {
  const { passed, total, state } = props;
  return (
    <div className="validation-state">
      <span className="validation-state__count">
        {passed} / {total}
      </span>
      <StatusIndicator status={STATE_TO_STATUS[state]} />
    </div>
  );
}
