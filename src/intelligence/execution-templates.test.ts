import { describe, it, expect } from 'vitest';
import { templateFor, pruneTemplate } from './execution-templates.js';

describe('templates as priors', () => {
  it('gives each kind of work the shape it usually takes', () => {
    expect(templateFor('debugging').steps.map((s) => s.name)).toEqual([
      'locate the failing path', 'reproduce the failure', 'diagnose',
    ]);
    expect(templateFor('trivial_edit').steps).toHaveLength(1);
    expect(templateFor('multi_workstream').steps.map((s) => s.intent)).toContain('SPAWN_AGENT');
  });

  it('speaks the common decision vocabulary, so a step can be priced', () => {
    for (const step of templateFor('implementation').steps) {
      expect(typeof step.intent).toBe('string');
      expect(step.intent).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('pruning', () => {
  it('drops a step whose product is already held', () => {
    // A template that cannot be shortened is a script, and a script pays for
    // four steps on a task that needed one.
    const pruned = pruneTemplate(templateFor('implementation'), new Set(['repo_structure']));
    expect(pruned.steps.map((s) => s.name)).not.toContain('locate the code to change');
    expect(pruned.removed[0].reason).toMatch(/already known/);
  });

  it('never drops the step that makes the task mean what it means', () => {
    // Dropping the mandatory step would turn "implement this" into "look at it".
    const pruned = pruneTemplate(templateFor('implementation'), new Set(['repo_structure', 'edit', 'verification']));
    expect(pruned.steps.map((s) => s.name)).toEqual(['make the change']);
    expect(pruned.steps[0].optional).toBe(false);
  });

  it('changes nothing when nothing is known', () => {
    const template = templateFor('investigation');
    const pruned = pruneTemplate(template, new Set());
    expect(pruned.steps).toEqual(template.steps);
    expect(pruned.removed).toEqual([]);
  });

  it('names what it removed, so the saving is visible rather than an absence', () => {
    const pruned = pruneTemplate(templateFor('debugging'), new Set(['repo_structure', 'failure_evidence']));
    expect(pruned.removed.map((r) => r.step.name)).toEqual([
      'locate the failing path', 'reproduce the failure',
    ]);
  });
});
