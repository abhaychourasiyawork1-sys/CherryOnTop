import { describe, it, expect } from 'vitest';
import { renderReceiptHtml } from './Receipt.js';

const base = {
  node: {
    id: 'case-1', goal: 'ship the parser', state: 'COMPLETE',
    repoPath: '/repo', runtime: 'claude-code',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:10:00.000Z',
  },
  nodes: [{ id: 'case-1', goal: 'ship the parser', state: 'COMPLETE', runtime: 'claude-code' }],
  mandate: { id: 'm', name: 'Focused change', description: '', authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 }, constraints: [], builtin: true },
  envelope: { permits: ['Work alone'], stops: ['Needing more than $5.00'], advisory: [] },
  custody: [],
  decisions: [{ id: 'd1', nodeId: 'case-1', type: 'execution_decision', outcome: 'SELF_EXECUTE', breakdown: { score: 0.1, threshold: 0.3 }, createdAt: '2026-09-01T00:01:00.000Z' }],
  dod: { items: [{ id: 'i1', nodeId: 'case-1', text: 'parser ships', state: 'met' as const, artifactId: null, note: null, checkedAt: null }], progress: { met: 1, unmet: 0, unverified: 0, total: 1 } },
  artifacts: [{ id: 'a1', nodeId: 'case-1', kind: 'file_write', path: 'src/parse.ts', summary: 'Write' }],
  approvals: [],
  denials: [],
  costUsd: 1.234, budgetUsd: 5, answer: null,
  generatedAt: '2026-09-01T00:11:00.000Z',
};

describe('the exported receipt', () => {
  it('is self-contained — no network, no script, no external stylesheet', () => {
    const html = renderReceiptHtml(base as never);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link/i);
  });

  it('escapes goal text, which is written by an agent and is not trusted markup', () => {
    const html = renderReceiptHtml({
      ...base,
      node: { ...base.node, goal: '<img src=x onerror="alert(1)">' },
    } as never);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes an artifact path too — paths come from the sandbox', () => {
    const html = renderReceiptHtml({
      ...base,
      artifacts: [{ id: 'a', nodeId: 'n', kind: 'file_write', path: '<b>evil</b>', summary: '' }],
    } as never);
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });

  it('carries the parts that make it a receipt rather than a summary', () => {
    const html = renderReceiptHtml(base as never);
    expect(html).toContain('What it was permitted to do');
    expect(html).toContain('Focused change');
    expect(html).toContain('parser ships');
    expect(html).toContain('src/parse.ts');
    expect(html).toContain('$1.2340');
  });

  it('states its own limits rather than implying it shows the model reasoning', () => {
    const html = renderReceiptHtml(base as never);
    expect(html).toContain("does not show the model's internal reasoning");
    expect(html).toContain('org verify');
    // Never claim more than hash chaining actually gives.
    expect(html).not.toMatch(/tamper.?proof/i);
  });

  it('says "none" rather than leaving a section blank when nothing happened', () => {
    const html = renderReceiptHtml({ ...base, approvals: [], artifacts: [] } as never);
    expect(html).toContain('Where a person decided');
    expect(html).toContain('None.');
  });
});
