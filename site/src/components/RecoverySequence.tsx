import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';

export function RecoverySequence(props: { state: 'failed' | 'recovering' | 'verified' }): JSX.Element {
  const { state } = props;
  const { recoverySteps } = SITE_CONTENT.execution;

  return (
    <ol className={`recovery-sequence recovery-sequence--${state}`}>
      {recoverySteps.map((step) => (
        <li key={step} className="recovery-sequence__step">
          {step}
        </li>
      ))}
    </ol>
  );
}
