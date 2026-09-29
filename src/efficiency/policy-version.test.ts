import { describe, it, expect, afterEach } from 'vitest';
import { policyVersion, comparable, DECISION_ENGINE_VERSION } from './policy-version.js';
import { CONTEXT_POLICY_VERSION, EXECUTION_POLICY_VERSION } from './policy-version.js';

afterEach(() => { delete process.env.ORG_EFFICIENCY_MODE; });

describe('the identifier is immutable and deterministic', () => {
  it('refuses to be edited after the fact', () => {
    const version = policyVersion();
    expect(Object.isFrozen(version)).toBe(true);
    expect(() => {
      (version as { id: string }).id = 'tampered';
    }).toThrow();
  });

  it('is the same for two processes running the same code', () => {
    // The identity of a policy generation is the code it names. Two processes
    // started an hour apart on one commit are running the same policy, and a
    // timestamp baked in at import would make them look different.
    expect(policyVersion().id).toBe(policyVersion().id);
  });

  it('names the architecture, the policy generation and the engine generation', () => {
    // The retired switch no longer selects anything.
    process.env.ORG_EFFICIENCY_MODE = 'disabled';
    const version = policyVersion();
    expect(version.architecture).toBe('market');
    expect(version.version).toBe(`${CONTEXT_POLICY_VERSION}/${EXECUTION_POLICY_VERSION}`);
    expect(version.decisionEngineVersion).toBe(DECISION_ENGINE_VERSION);
    expect(version.id).toBe(`market:${version.version}:${DECISION_ENGINE_VERSION}`);
  });

  it('keeps rows written before the market distinguishable from rows after', () => {
    expect(policyVersion({ architecture: 'full' }).id)
      .not.toBe(policyVersion().id);
  });

  it('distinguishes an engine change from a weights change', () => {
    // A run where the utility model gained a term is not the same system as the
    // run before it, even with identical weights.
    const weights = policyVersion({ contextVersion: 'ctx-2' });
    const engine = policyVersion({ decisionEngineVersion: 'dec-99' });
    expect(weights.id).not.toBe(policyVersion().id);
    expect(engine.id).not.toBe(policyVersion().id);
    expect(weights.id).not.toBe(engine.id);
  });
});

describe('refusing to average two generations', () => {
  it('calls the two arms of one comparison comparable', () => {
    // Different architectures is the whole point of the comparison.
    expect(comparable(policyVersion({ architecture: 'baseline' }), policyVersion({ architecture: 'full' })))
      .toBe(true);
  });

  it('refuses two policy generations', () => {
    expect(comparable(policyVersion(), policyVersion({ contextVersion: 'ctx-99' }))).toBe(false);
  });

  it('refuses two engine generations, whichever arm they were in', () => {
    expect(comparable(
      policyVersion({ architecture: 'baseline' }),
      policyVersion({ architecture: 'baseline', decisionEngineVersion: 'dec-99' }),
    )).toBe(false);
  });
});

describe('versions accumulate; runtime modes do not', () => {
  it('reports one architecture whatever the environment says', () => {
    for (const value of ['disabled', 'off', 'baseline', 'shadow', 'enabled', 'full', '', undefined]) {
      if (value === undefined) delete process.env.ORG_EFFICIENCY_MODE;
      else process.env.ORG_EFFICIENCY_MODE = value;
      expect(policyVersion().architecture).toBe('market');
    }
  });

  it('treats the cost-to-go engine as a new, incomparable generation', () => {
    expect(DECISION_ENGINE_VERSION).not.toBe('dec-1');
    expect(comparable(policyVersion(), policyVersion({ decisionEngineVersion: 'dec-1' }))).toBe(false);
  });
});
