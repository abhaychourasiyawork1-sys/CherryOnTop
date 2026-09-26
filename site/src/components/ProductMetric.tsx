import type { JSX } from 'react';

export function ProductMetric(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  const { label, value, mono = false } = props;
  return (
    <div className="product-metric">
      <span className="product-metric__label">{label}</span>
      <span className={`product-metric__value${mono ? ' product-metric__value--mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}
