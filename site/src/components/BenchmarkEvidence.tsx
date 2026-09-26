import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { ProductMetric } from './ProductMetric';

export function BenchmarkEvidence(): JSX.Element {
  const { benchmarks } = SITE_CONTENT;

  return (
    <div className="benchmark-evidence">
      <div className="benchmark-evidence__metrics">
        <ProductMetric label="Resolved" value={benchmarks.resolved} mono />
        <ProductMetric label="Cost" value={benchmarks.costDelta} />
        <ProductMetric label="Tokens" value={benchmarks.tokenDelta} />
      </div>
      <p className="benchmark-evidence__methodology">{benchmarks.methodology}</p>
      <p className="benchmark-evidence__limitations">{benchmarks.limitations}</p>
      <a className="benchmark-evidence__link" href={benchmarks.methodologyLink}>
        Read the full methodology
      </a>
    </div>
  );
}
