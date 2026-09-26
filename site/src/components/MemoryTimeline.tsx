import type { JSX } from 'react';
import { StatusIndicator } from './StatusIndicator';

export interface MemoryRun {
  id: string;
  title: string;
  steps: string[];
  validated: string[];
}

export function MemoryTimeline(props: { runs: MemoryRun[] }): JSX.Element {
  const { runs } = props;

  return (
    <ol className="memory-timeline">
      {runs.map((run) => (
        <li key={run.id} className="memory-timeline__run">
          <p className="memory-timeline__run-title">{run.title}</p>
          <ul className="memory-timeline__steps">
            {run.steps.map((step) => {
              const isValidated = run.validated.includes(step);
              return (
                <li key={step} className="memory-timeline__step">
                  <span className="memory-timeline__step-label">{step}</span>
                  <StatusIndicator
                    status={isValidated ? 'verified' : 'waiting'}
                    label={isValidated ? 'Confirmed' : 'Asserted'}
                  />
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
