import type { JSX } from 'react';
import { BenchmarkEvidence } from '../components/BenchmarkEvidence';

export function BenchmarkSection(): JSX.Element {
  return (
    <div className="benchmark-section">
      <BenchmarkEvidence />
    </div>
  );
}
