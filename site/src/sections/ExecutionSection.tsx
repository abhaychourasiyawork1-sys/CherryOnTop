import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { useDemoController } from '../demo/controller';
import { DEMO_TIMELINE_EVENTS, TIMELINE_INDEX_BY_STATE } from '../demo/data';
import { ExecutionTimeline } from '../components/ExecutionTimeline';
import { RecoverySequence } from '../components/RecoverySequence';
import { ValidationState } from '../components/ValidationState';

export function ExecutionSection(): JSX.Element {
  const { snapshot } = useDemoController();
  const { state, counters } = snapshot;
  const { execution } = SITE_CONTENT;

  const activeIndex = TIMELINE_INDEX_BY_STATE[state];
  const isFailing = state === 'failure';
  const isRecovering = state === 'recovering';
  const showRecovery = isFailing || isRecovering;
  const showValidation = activeIndex >= 2 && !isRecovering;

  const validationLifecycleState: 'running' | 'failed' | 'verified' = isFailing
    ? 'failed'
    : state === 'verified' || state === 'receipt' || state === 'memory'
      ? 'verified'
      : 'running';

  return (
    <div className="execution-section">
      <ExecutionTimeline events={DEMO_TIMELINE_EVENTS} activeIndex={activeIndex} />

      {showRecovery ? (
        <div className="execution-section__failure">
          <p className="execution-section__failure-label">{execution.failureLabel}</p>
          <p className="execution-section__failure-body">{execution.failureBody}</p>
          <RecoverySequence state={isFailing ? 'failed' : 'recovering'} />
        </div>
      ) : null}

      {showValidation ? (
        <ValidationState
          passed={counters.checksPassed}
          total={counters.checks}
          state={validationLifecycleState}
        />
      ) : null}
    </div>
  );
}
