import { describe, it, expect } from 'vitest';
import { assessUncertainty } from './coordinator.js';

describe('assessUncertainty', () => {
  it('classifies a short goal as low complexity', () => {
    expect(assessUncertainty({ goal: 'fix typo' }).complexity).toBe('low');
  });

  it('classifies a long, detailed goal as high complexity', () => {
    const goal = 'Implement a full OAuth2 login flow integrating Google and GitHub providers, add refresh-token rotation, migrate the existing session store, and write end-to-end tests covering token expiry.';
    expect(assessUncertainty({ goal }).complexity).toBe('high');
  });

  it('always reports sufficient context for v0.1 (no evidence workers exist yet)', () => {
    expect(assessUncertainty({ goal: 'anything' }).sufficientContext).toBe(true);
  });
});
