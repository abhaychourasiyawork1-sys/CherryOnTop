import { describe, it, expect } from 'vitest';
import { discoverDecisionCapabilities } from './capabilities.js';
import { HARNESS_QUESTIONS } from './compiler.js';

describe('decision capability discovery', () => {
  it('describes every harness question and the model gateway by contract', () => {
    const discovery = discoverDecisionCapabilities({ mode: 'laya', ready: true });
    expect(discovery.enabled).toBe(true);
    expect(discovery.capabilities.map((c) => c.id)).toEqual([...Object.keys(HARNESS_QUESTIONS), 'model.request']);
    const decomposable = discovery.capabilities[0];
    expect(decomposable).toMatchObject({ version: 'execution.decomposable@2', askedBy: 'harness', supportedDecisionTypes: ['choice'] });
    expect(decomposable.inputSchema).toBeTruthy();
    expect(decomposable.outputSchema).toBeTruthy();
  });

  it('does not name the provider, so replacing it changes no descriptor', () => {
    const laya = discoverDecisionCapabilities({ mode: 'laya', ready: true });
    const jev = discoverDecisionCapabilities({ mode: 'jev', ready: true });
    expect(jev.capabilities).toEqual(laya.capabilities);
    expect(JSON.stringify(laya)).not.toMatch(/laya|jev/i);
  });

  it('lists nothing when System-1 is off, and reports a loading provider as not ready', () => {
    expect(discoverDecisionCapabilities({ mode: 'off', ready: true })).toEqual({ enabled: false, ready: false, capabilities: [] });
    expect(discoverDecisionCapabilities({ mode: 'laya', ready: false }).ready).toBe(false);
  });
});
