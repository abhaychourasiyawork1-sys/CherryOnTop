import { describe, it, expect, afterEach } from 'vitest';
import { policyVersion, comparable, DECISION_ENGINE_VERSION } from './policy-version.js';
import { parseRuntimeMode } from '../config/efficiency.js';
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
    process.env.ORG_EFFICIENCY_MODE = 'disabled';
    const version = policyVersion();
    expect(version.architecture).toBe('baseline');
    expect(version.version).toBe(`${CONTEXT_POLICY_VERSION}/${EXECUTION_POLICY_VERSION}`);
    expect(version.decisionEngineVersion).toBe(DECISION_ENGINE_VERSION);
    expect(version.id).toBe(`baseline:${version.version}:${DECISION_ENGINE_VERSION}`);
  });

  it('distinguishes the two arms of a comparison', () => {
    expect(policyVersion({ architecture: 'baseline' }).id)
      .not.toBe(policyVersion({ architecture: 'full' }).id);
  });

  it('distinguishes an engine change from a weights change', () => {
    // A run where the utility model gained a term is not the same system as the
    // run before it, even with identical weights.
    const weights = policyVersion({ contextVersion: 'ctx-2' });
    const engine = policyVersion({ decisionEngineVersion: 'dec-2' });
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
  it('leaves the product at exactly two modes', () => {
    // The architectural invariant, asserted where versioning would be the
    // tempting place to add a third.
    const modes = new Set(
      ['disabled', 'off', 'baseline', 'shadow', 'enabled', 'full', 'canary', 'replay', '', undefined]
        .map((value) => parseRuntimeMode(value as string | undefined)),
    );
    expect([...modes].sort()).toEqual(['baseline', 'full']);
  });

  it('maps every architecture a version can name onto one of those two', () => {
    for (const architecture of ['baseline', 'full'] as const) {
      expect(policyVersion({ architecture }).architecture).toBe(architecture);
    }
    expect(new Set([
      policyVersion({ architecture: 'baseline' }).architecture,
      policyVersion({ architecture: 'full' }).architecture,
    ]).size).toBe(2);
  });
});
