import { describe, it, expect } from 'vitest';
import { assessUncertainty } from './coordinator.js';

describe('assessUncertainty', () => {
  it('reads nothing from the goal: a short one and a long detailed one are known equally little', () => {
    const short = assessUncertainty({ goal: 'fix typo' });
    const long = assessUncertainty({ goal: 'Implement a full OAuth2 login flow integrating Google and GitHub providers, add refresh-token rotation, migrate the existing session store, and write end-to-end tests covering token expiry.' });
    expect(short).toEqual(long);
  });

  it('starts uninformed: the middle of the scale, and nobody has said the work splits', () => {
    const bundle = assessUncertainty({ goal: 'anything' });
    expect(bundle.difficulty).toBe(0.5);
    expect(bundle.splitProbability).toBeUndefined();
  });

  it('always reports sufficient context for v0.1 (no evidence workers exist yet)', () => {
    expect(assessUncertainty({ goal: 'anything' }).sufficientContext).toBe(true);
  });
});
