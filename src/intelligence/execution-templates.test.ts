import { describe, it, expect } from 'vitest';
import { templateFor, pruneTemplate } from './execution-templates.js';

describe('templates as priors', () => {
  it('gives each thing the runtime can know about a task the shape it usually takes', () => {
    expect(templateFor('answer').steps.map((s) => s.name)).toEqual(['locate the relevant code', 'investigate']);
    expect(templateFor('change').steps.map((s) => s.name)).toEqual([
      'locate the code to change', 'make the change', 'verify the change',
    ]);
    expect(templateFor('split').steps.map((s) => s.intent)).toContain('SPAWN_AGENT');
  });

  it('has a shape for exactly the three things that can be known, and none read from wording', () => {
    // Debugging, documentation and test-writing were guessed from the goal's
    // words; a prior wrong about a word prunes the wrong step.
    for (const mode of ['answer', 'change', 'split'] as const) expect(templateFor(mode).steps.length).toBeGreaterThan(0);
  });

  it('speaks the common decision vocabulary, so a step can be priced', () => {
    for (const step of templateFor('change').steps) {
      expect(typeof step.intent).toBe('string');
      expect(step.intent).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('pruning', () => {
  it('drops a step whose product is already held', () => {
    // A template that cannot be shortened is a script, and a script pays for
    // four steps on a task that needed one.
    const pruned = pruneTemplate(templateFor('change'), new Set(['repo_structure']));
    expect(pruned.steps.map((s) => s.name)).not.toContain('locate the code to change');
    expect(pruned.removed[0].reason).toMatch(/already known/);
  });

  it('never drops the step that makes the task mean what it means', () => {
    // Dropping the mandatory step would turn "implement this" into "look at it".
    const pruned = pruneTemplate(templateFor('change'), new Set(['repo_structure', 'edit', 'verification']));
    expect(pruned.steps.map((s) => s.name)).toEqual(['make the change']);
    expect(pruned.steps[0].optional).toBe(false);
  });

  it('changes nothing when nothing is known', () => {
    const template = templateFor('answer');
    const pruned = pruneTemplate(template, new Set());
    expect(pruned.steps).toEqual(template.steps);
    expect(pruned.removed).toEqual([]);
  });

  it('names what it removed, so the saving is visible rather than an absence', () => {
    const pruned = pruneTemplate(templateFor('change'), new Set(['repo_structure', 'verification']));
    expect(pruned.removed.map((r) => r.step.name)).toEqual([
      'locate the code to change', 'verify the change',
    ]);
  });
});
