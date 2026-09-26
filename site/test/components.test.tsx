import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App';

describe('semantic app shell', () => {
  it('renders exactly one h1', () => {
    render(<App />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders header, main, and footer landmark regions', () => {
    render(<App />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('does not set body overflow to hidden', () => {
    render(<App />);
    const bodyOverflow = window.getComputedStyle(document.body).overflow;
    expect(bodyOverflow).not.toBe('hidden');
  });

  it('renders the locked section anchors in order', () => {
    render(<App />);
    const anchors = [
      'product',
      'how-it-works',
      'organization',
      'mandate',
      'execution',
      'proof',
      'memory',
      'benchmarks',
      'architecture',
      'trust',
      'launch',
    ];
    for (const id of anchors) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});
