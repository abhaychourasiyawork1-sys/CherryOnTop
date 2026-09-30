import { describe, it, expect } from 'vitest';
import {
  buildChildDelegationReport, buildParentFeedback, compactReworkContext, reworkGoal,
  MAX_REWORK_CONTEXT_CHARS, MAX_REPORT_ITEMS,
} from './delegation-reports.js';
import { ChildReportSchema, ParentFeedbackSchema } from '../schemas/delegation.js';

const envelopeBlock = (body: object) => `I did the work.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

describe('buildChildDelegationReport', () => {
  it('extracts changed files, tests, evidence refs, blockers and remaining work from the result envelope', () => {
    const report = buildChildDelegationReport({
      assignmentId: 'a1',
      answer: envelopeBlock({
        status: 'partial', summary: 'Cart renders; checkout still missing',
        findings: ['added Cart component'], changedFiles: ['src/cart.tsx'],
        uncertainties: ['checkout flow untested'], confidence: 0.6,
      }),
      succeeded: true,
      changedFiles: ['src/cart.tsx', 'src/cart.test.tsx'],
      observedChecks: [
        { id: 'observed:npm test', command: 'npm test', passed: true },
        { id: 'observed:tsc', command: 'tsc --noEmit', passed: false },
      ],
      evidenceRefs: ['artifact:1', 'validation:9'],
    });
    expect(ChildReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      assignmentId: 'a1', status: 'ready', summary: 'Cart renders; checkout still missing',
      completedWork: ['added Cart component'],
      // What the runtime observed wins over what the child claimed it touched.
      changedFiles: ['src/cart.test.tsx', 'src/cart.tsx'],
      evidenceRefs: ['artifact:1', 'validation:9'],
      uncertainties: ['checkout flow untested'],
    });
    expect(report.testsRun).toEqual([
      { command: 'npm test', passed: true, evidenceId: 'observed:npm test' },
      { command: 'tsc --noEmit', passed: false, evidenceId: 'observed:tsc' },
    ]);
    expect(report.remainingWork.join(' ')).toContain('checkout still missing');
  });

  it('reports blocked when the child says it is blocked or needs input', () => {
    const report = buildChildDelegationReport({
      assignmentId: 'a1', succeeded: false,
      answer: envelopeBlock({ status: 'needs_input', summary: 'Which database?', uncertainties: ['db choice'] }),
    });
    expect(report.status).toBe('blocked');
    expect(report.blockers).toEqual(['Which database?']);
  });

  it('degrades to a bounded fallback when the report is prose, malformed, or enormous', () => {
    const prose = buildChildDelegationReport({ assignmentId: 'a1', answer: 'All done, boss.\nMore detail follows.', succeeded: true });
    expect(prose.summary).toBe('All done, boss.');
    expect(prose.status).toBe('ready');

    const broken = buildChildDelegationReport({ assignmentId: 'a1', answer: '```json\n{"status": "success", "summary": 12}\n```', succeeded: false });
    expect(ChildReportSchema.safeParse(broken).success).toBe(true);

    const huge = buildChildDelegationReport({
      assignmentId: 'a1', succeeded: true,
      answer: envelopeBlock({
        status: 'success', summary: 'x'.repeat(50_000),
        findings: Array.from({ length: 500 }, (_, i) => `finding ${i} ${'y'.repeat(2_000)}`),
        changedFiles: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
      }),
    });
    expect(JSON.stringify(huge).length).toBeLessThan(20_000);
    expect(huge.completedWork.length).toBeLessThanOrEqual(MAX_REPORT_ITEMS);
    expect(huge.changedFiles.length).toBeLessThanOrEqual(MAX_REPORT_ITEMS);
  });

  it('survives an empty answer', () => {
    const report = buildChildDelegationReport({ assignmentId: 'a1', answer: '', succeeded: false });
    expect(report.summary).toBe('');
    expect(ChildReportSchema.safeParse(report).success).toBe(true);
  });
});

describe('buildParentFeedback', () => {
  it('carries only failed checks, observed vs expected, evidence refs, required changes and next checks', () => {
    const feedback = buildParentFeedback({
      assignmentId: 'a1', revision: 4,
      failedChecks: [{ check: 'npm test', observed: 'no passing run in the candidate', expected: 'a green run', evidenceRefs: ['observed:npm test'] }],
      guidance: ['Run the suite before reporting again.'],
    });
    expect(ParentFeedbackSchema.safeParse(feedback).success).toBe(true);
    expect(feedback).toMatchObject({
      assignmentId: 'a1', revision: 4,
      failedChecks: [{ check: 'npm test', observed: 'no passing run in the candidate', expected: 'a green run', evidenceRefs: ['observed:npm test'] }],
      nextChecks: ['npm test'],
      guidance: ['Run the suite before reporting again.'],
    });
    expect(feedback.requiredChanges).toHaveLength(1);
    expect(feedback.requiredChanges[0]).toContain('npm test');
    expect(Object.keys(feedback).sort()).toEqual(
      ['assignmentId', 'failedChecks', 'guidance', 'nextChecks', 'requiredChanges', 'revision']);
  });

  it('clips oversized observations instead of forwarding them', () => {
    const feedback = buildParentFeedback({
      assignmentId: 'a1', revision: 2,
      failedChecks: [{ check: 'c', observed: 'z'.repeat(20_000), expected: 'e', evidenceRefs: [] }],
    });
    expect(feedback.failedChecks[0].observed.length).toBeLessThan(1_000);
  });
});

describe('compactReworkContext', () => {
  const feedback = buildParentFeedback({
    assignmentId: 'a1', revision: 4,
    failedChecks: [{ check: 'npm test', observed: 'red: 2 failing', expected: 'green', evidenceRefs: ['observed:npm test'] }],
  });
  const previous = buildChildDelegationReport({
    assignmentId: 'a1', succeeded: false,
    answer: envelopeBlock({ status: 'partial', summary: 'Implemented cart, tests red' }),
    changedFiles: ['src/cart.tsx'], evidenceRefs: ['artifact:1'],
  });

  it('hands the same child its contract, the latest feedback and what it already did — by reference', () => {
    const context = compactReworkContext({
      goal: 'Add the cart', definitionOfDone: ['cart renders'], acceptanceChecks: ['npm test'],
      feedback, previousReport: previous, feedbackHistory: [],
    });
    expect(context).toContain('Add the cart');
    expect(context).toContain('cart renders');
    expect(context).toContain('npm test');
    expect(context).toContain('red: 2 failing');
    expect(context).toContain('Implemented cart, tests red');
    expect(context).toContain('src/cart.tsx');
    expect(context).toContain('observed:npm test');
  });

  it('is bounded and never carries a parent transcript, however large the inputs', () => {
    // Each oversized field ends in a marker that can only survive if the field
    // was forwarded whole; the list of DoD items ends in one that can only
    // survive if the list was not capped.
    const context = compactReworkContext({
      goal: 'g',
      definitionOfDone: Array.from({ length: 200 }, (_, i) => `dod ${i} ${'d'.repeat(400)}`),
      acceptanceChecks: ['npm test'],
      feedback: { ...feedback, guidance: [`${'g'.repeat(900)}TAIL-GUIDANCE`] },
      previousReport: { ...previous, summary: `${'s'.repeat(2_000)}TAIL-SUMMARY` },
      feedbackHistory: Array.from({ length: 50 }, () => feedback),
    });
    expect(context.length).toBeLessThanOrEqual(MAX_REWORK_CONTEXT_CHARS);
    expect(context).not.toContain('TAIL-GUIDANCE');
    expect(context).not.toContain('TAIL-SUMMARY');
    expect(context).not.toContain('dod 199');
    expect(context).not.toContain('dod 9 ');
  });

  it('says which checks keep failing, so a repeat is visible', () => {
    const context = compactReworkContext({
      goal: 'g', definitionOfDone: [], acceptanceChecks: ['npm test'],
      feedback, previousReport: previous, feedbackHistory: [{ ...feedback, revision: 3 }],
    });
    expect(context).toMatch(/failed .*before|repeat|again/i);
  });

  it('reworkGoal keeps the original goal on top and appends the context', () => {
    const goal = reworkGoal('Add the cart', 'CONTEXT');
    expect(goal.startsWith('Add the cart')).toBe(true);
    expect(goal).toContain('CONTEXT');
  });
});
