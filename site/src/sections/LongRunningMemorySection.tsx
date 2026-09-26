import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import type { Status } from '../types';
import { StatusIndicator } from '../components/StatusIndicator';
import { ProductMetric } from '../components/ProductMetric';
import { MemoryTimeline, type MemoryRun } from '../components/MemoryTimeline';

/**
 * `statusLabel` overrides the StatusIndicator's default text where it would
 * otherwise repeat the step name verbatim (e.g. the "Verified" step).
 */
const STEP_STATUS: Record<string, { status: Status; statusLabel?: string }> = {
  'Goal received': { status: 'waiting' },
  'Organization formed': { status: 'waiting' },
  Execution: { status: 'working' },
  'Issue discovered': { status: 'attention' },
  Recovery: { status: 'recovering' },
  Validation: { status: 'validating' },
  Verified: { status: 'verified', statusLabel: 'Complete' },
};

const MEMORY_RUNS: MemoryRun[] = [
  {
    id: 'run-01',
    title: 'RUN 01',
    steps: ['Observed', 'Validated', 'Remembered'],
    validated: ['Validated', 'Remembered'],
  },
  {
    id: 'run-02',
    title: 'RUN 02',
    steps: ['Reused'],
    validated: ['Reused'],
  },
];

export function LongRunningMemorySection(): JSX.Element {
  const { longRunning, memory } = SITE_CONTENT;

  return (
    <div className="long-running-memory-section">
      <ol className="long-running-sequence">
        {longRunning.steps.map((step) => (
          <li key={step} className="long-running-sequence__step">
            <span className="long-running-sequence__label">{step}</span>
            <StatusIndicator
              status={STEP_STATUS[step].status}
              label={STEP_STATUS[step].statusLabel}
            />
          </li>
        ))}
      </ol>
      <ProductMetric label="Budget" value={longRunning.budgetLine} mono />

      <MemoryTimeline runs={MEMORY_RUNS} />
      <p className="long-running-memory-section__reuse">{memory.reuseLine}</p>
    </div>
  );
}
