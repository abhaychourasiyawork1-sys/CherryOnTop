import { describe, it, expect } from 'vitest';
import { changesOrg } from './liveness.js';

describe('what counts as the organization changing', () => {
  it('re-reads when a node moves', () => {
    expect(changesOrg('state.transition')).toBe(true);
    expect(changesOrg('decision.made')).toBe(true);
  });

  it('re-reads when money is spent — this is why spend used to sit still', () => {
    expect(changesOrg('exec.result')).toBe(true);
  });

  it('re-reads when a mandate refuses a tool, so the Desk shows it', () => {
    expect(changesOrg('authority.denied')).toBe(true);
  });

  it('re-reads when a restart parks a node', () => {
    expect(changesOrg('node.interrupted')).toBe(true);
  });

  it('ignores the runtime output firehose — that would be a query per token', () => {
    expect(changesOrg('exec.assistant')).toBe(false);
    expect(changesOrg('exec.user')).toBe(false);
    expect(changesOrg('step.progress')).toBe(false);
    expect(changesOrg('plan.assistant')).toBe(false);
    expect(changesOrg('synth.assistant')).toBe(false);
  });
});
