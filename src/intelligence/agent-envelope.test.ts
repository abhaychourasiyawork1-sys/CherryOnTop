import { describe, it, expect } from 'vitest';
import {
  buildAgentEnvelope, serializeEnvelope, envelopeFingerprint, renderEnvelope,
  revisionOf, EnvelopeError,
} from './agent-envelope.js';
import { scopeOf, type ContextRef } from '../context/types.js';

const ref = (id: string, hash = `h-${id}`, version = 1): ContextRef => ({ semanticId: id, version, contentHash: hash });
const reader = scopeOf(['Read', 'Grep'], true);
const narrow = scopeOf(['Read'], true);

const scopes = (ids: string[], scope = narrow) => new Map(ids.map((id) => [id, scope]));

describe('a valid envelope', () => {
  it('carries everything a child needs and nothing it does not', () => {
    const envelope = buildAgentEnvelope({
      goal: 'Audit src/auth for unhandled rejections',
      requiredContext: [ref('repo_file:src/auth.ts')],
      suggestedContext: [ref('repo_file:src/session.ts')],
      forbiddenContext: [ref('repo_file:secrets.ts')],
      constraints: ['Do not modify anything', '  '],
      budget: { maxTurns: 60, usd: 2.5 },
      capabilities: ['Read', 'Grep'],
      scope: reader,
      refScopes: scopes(['repo_file:src/auth.ts', 'repo_file:src/session.ts']),
    });

    expect(envelope.goal).toBe('Audit src/auth for unhandled rejections');
    expect(envelope.requiredContext).toHaveLength(1);
    // A blank constraint would render as a heading with an empty bullet.
    expect(envelope.constraints).toEqual(['Do not modify anything']);
    expect(envelope.outputContract.schema).toBe('AgentResultEnvelope');
    expect(envelope.contextRevision).toHaveLength(16);
  });
});

describe('what an envelope refuses to be', () => {
  it('refuses a goal that is not there', () => {
    expect(() => buildAgentEnvelope({ goal: '   ', scope: reader })).toThrow(EnvelopeError);
  });

  it('refuses to both offer and forbid the same context', () => {
    // Silently preferring one makes the stricter instruction the one that loses.
    expect(() => buildAgentEnvelope({
      goal: 'g', requiredContext: [ref('a')], forbiddenContext: [ref('a')], scope: reader,
    })).toThrow(/both offered and forbidden/);
  });

  it('refuses a constraint that carries a pasted transcript', () => {
    // Prose is how a handoff silently becomes a copy of the parent's whole
    // conversation.
    expect(() => buildAgentEnvelope({
      goal: 'g', constraints: ['Here is what the last agent said:\n\nIt found three bugs...'], scope: reader,
    })).toThrow(/ContextRef instead of pasted text/);
    expect(() => buildAgentEnvelope({ goal: 'g', constraints: ['x'.repeat(2001)], scope: reader }))
      .toThrow(/pasted text/);
  });

  it('refuses to hand over context the child may not read', () => {
    // Checked before the handoff, not after: this is a construction error.
    expect(() => buildAgentEnvelope({
      goal: 'g', requiredContext: [ref('repo_file:secret.ts')], scope: narrow,
      refScopes: scopes(['repo_file:secret.ts'], scopeOf(null, true)),
    })).toThrow(/outside the scope/);
  });

  it('refuses a ref whose scope it cannot establish, rather than assuming it safe', () => {
    expect(() => buildAgentEnvelope({
      goal: 'g', requiredContext: [ref('repo_file:a.ts')], scope: narrow, refScopes: new Map(),
    })).toThrow(/scope of .* is unknown/);
  });
});

describe('deterministic serialization', () => {
  it('gives two envelopes that say the same thing the same bytes', () => {
    // Every fingerprint built on this is noise otherwise.
    const build = (order: ContextRef[]) => buildAgentEnvelope({
      goal: 'g', requiredContext: order, capabilities: ['Grep', 'Read'], scope: reader,
      refScopes: scopes(['a', 'b']),
    });
    expect(serializeEnvelope(build([ref('a'), ref('b')])))
      .toBe(serializeEnvelope(build([ref('b'), ref('a')])));
    expect(envelopeFingerprint(build([ref('a'), ref('b')])))
      .toBe(envelopeFingerprint(build([ref('b'), ref('a')])));
  });

  it('changes the fingerprint when the context version moves', () => {
    const build = (hash: string) => buildAgentEnvelope({
      goal: 'g', requiredContext: [ref('a', hash)], scope: reader, refScopes: scopes(['a']),
    });
    expect(envelopeFingerprint(build('h1'))).not.toBe(envelopeFingerprint(build('h2')));
  });

  it('names a set of context versions stably, whatever order it was assembled in', () => {
    expect(revisionOf([ref('a'), ref('b')])).toBe(revisionOf([ref('b'), ref('a')]));
    expect(revisionOf([ref('a')])).not.toBe(revisionOf([ref('a', 'other')]));
    expect(revisionOf([])).toBe(revisionOf([]));
  });
});

describe('rendering to the one channel a dispatch has', () => {
  it('omits empty sections rather than rendering a heading with nothing under it', () => {
    const bare = renderEnvelope(buildAgentEnvelope({ goal: 'g', scope: reader }));
    expect(bare).toBe('');
  });

  it('states the context, the prohibitions and the budget', () => {
    const text = renderEnvelope(buildAgentEnvelope({
      goal: 'g',
      requiredContext: [ref('repo_file:a.ts')],
      forbiddenContext: [ref('repo_file:secret.ts')],
      constraints: ['Do not modify anything'],
      budget: { maxTurns: 60, usd: 2.5 },
      scope: reader,
      refScopes: scopes(['repo_file:a.ts']),
    }));
    expect(text).toContain('repo_file:a.ts');
    expect(text).toMatch(/Do not read: repo_file:secret\.ts/);
    expect(text).toContain('Do not modify anything');
    expect(text).toMatch(/at most 60 turns/);
    expect(text).toMatch(/\$2\.50/);
  });

  it('stays compact, because coordination tokens are paid on every child', () => {
    const text = renderEnvelope(buildAgentEnvelope({
      goal: 'g',
      requiredContext: Array.from({ length: 10 }, (_, i) => ref(`repo_file:f${i}.ts`)),
      scope: reader,
      refScopes: scopes(Array.from({ length: 10 }, (_, i) => `repo_file:f${i}.ts`)),
    }));
    // Ten identities on one line, not ten headings.
    expect(text.split('\n')).toHaveLength(1);
  });
});
