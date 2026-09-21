import { describe, it, expect } from 'vitest';
import { validateDelegationPlan, parentDeliverables, type DelegationPlan } from './delegation-validator.js';
import type { Authority } from '../schemas/node-contract.js';

const PARENT: Authority = {
  tools: ['Read', 'Edit'], spawn_children: true, max_child_count: 4, budget_usd: 10,
};

function parent(over: Partial<Parameters<typeof validateDelegationPlan>[0]> = {}) {
  return { goal: 'Improve the parser', authority: PARENT, ...over };
}

function plan(...subgoals: DelegationPlan['subgoals']): DelegationPlan {
  return { subgoals };
}

describe('validateDelegationPlan', () => {
  it('rejects duplicate work before child creation', () => {
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'add parser tests', writePaths: ['parser.test.ts'], dependencies: [] },
      { id: 'b', goal: 'add parser tests', writePaths: ['parser.test.ts'], dependencies: [] },
    ));
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('duplicate_or_clone_subgoal');
  });

  it('rejects a plan that drops one of the parent\'s named deliverables', () => {
    const result = validateDelegationPlan(
      parent({ goal: 'Fix the auth bug; also add parser tests; also update the README' }),
      plan(
        { id: 'a', goal: 'Fix the auth bug', writePaths: ['src/auth.ts'], dependencies: [] },
        { id: 'b', goal: 'add parser tests', writePaths: ['src/parser.test.ts'], dependencies: [] },
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.coverage).toBeLessThan(1);
    expect(result.reasons).toContain('incomplete_coverage');
  });

  it('accepts a plan that covers every named deliverable', () => {
    const result = validateDelegationPlan(
      parent({ goal: 'Fix the auth bug; also add parser tests' }),
      plan(
        { id: 'a', goal: 'Fix the auth bug in the session handler', writePaths: ['src/auth.ts'], dependencies: [] },
        { id: 'b', goal: 'add parser tests for the tokenizer', writePaths: ['src/parser.test.ts'], dependencies: [] },
      ),
    );
    expect(result.coverage).toBe(1);
    expect(result.valid).toBe(true);
  });

  it('rejects a write conflict that cannot be serialized', () => {
    // Two branches writing one file, and a dependency cycle that leaves the
    // scheduler nowhere to put them.
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'rewrite the tokenizer', writePaths: ['src/parser.ts'], dependencies: ['b'] },
      { id: 'b', goal: 'extract the lexer helpers', writePaths: ['src/parser.ts'], dependencies: ['a'] },
    ));
    expect(result.valid).toBe(false);
    expect(result.dependencySafe).toBe(false);
    expect(result.reasons).toContain('dependency_cycle');
  });

  it('accepts a serializable write overlap and says it serialized it', () => {
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'rewrite the tokenizer entry point', writePaths: ['src/parser.ts'], dependencies: [] },
      { id: 'b', goal: 'extract shared lexer helpers', writePaths: ['src/parser.ts'], dependencies: [] },
    ));
    expect(result.conflictFree).toBe(false);
    expect(result.reasons).toContain('write_overlap_serialized');
    expect(result.valid).toBe(true);
  });

  it('rejects a child scoped to write outside its parent', () => {
    const result = validateDelegationPlan(
      parent({ writeScope: ['src/parser'] }),
      plan(
        { id: 'a', goal: 'tidy the tokenizer', writePaths: ['src/parser/token.ts'], dependencies: [] },
        { id: 'b', goal: 'change deployment secrets', writePaths: ['infra/secrets.yaml'], dependencies: [] },
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.scopeSafe).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('child_scope_exceeds_parent'))).toBe(true);
  });

  it('rejects children that write when the parent is read-only', () => {
    const result = validateDelegationPlan(
      parent({ authority: { ...PARENT, tools: ['Read'] } }),
      plan(
        { id: 'a', goal: 'audit the tokenizer', writePaths: ['src/parser.ts'], dependencies: [] },
        { id: 'b', goal: 'review the lexer for bugs', writePaths: [], dependencies: [] },
      ),
    );
    expect(result.scopeSafe).toBe(false);
    expect(result.reasons).toContain('child_writes_beyond_read_only_parent');
  });

  it('rejects a plan wider than the node\'s agent allowance', () => {
    const narrow = { ...PARENT, max_child_count: 1 };
    const result = validateDelegationPlan(parent({ authority: narrow }), plan(
      { id: 'a', goal: 'tidy the tokenizer', writePaths: [], dependencies: [] },
      { id: 'b', goal: 'rewrite the emitter', writePaths: [], dependencies: [] },
    ));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('plan_exceeds_agent_allowance'))).toBe(true);
  });

  it('accepts dependent subgoals and leaves the ordering to the scheduler', () => {
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'extract the token type enum', writePaths: ['src/token.ts'], dependencies: [] },
      { id: 'b', goal: 'rewrite the emitter against the new enum', writePaths: ['src/emit.ts'], dependencies: ['a'] },
    ));
    expect(result.valid).toBe(true);
    expect(result.dependencySafe).toBe(true);
    expect(result.conflictFree).toBe(true);
  });

  it('accepts truly independent nonconflicting subgoals', () => {
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'add tokenizer tests', writePaths: ['src/token.test.ts'], dependencies: [] },
      { id: 'b', goal: 'document the emitter options', writePaths: ['docs/emit.md'], dependencies: [] },
    ));
    expect(result.valid).toBe(true);
    expect(result.reasons).toContain('plan_valid');
  });

  it('rejects a dependency on a subgoal that does not exist', () => {
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'add tokenizer tests', writePaths: [], dependencies: ['ghost'] },
      { id: 'b', goal: 'document the emitter options', writePaths: [], dependencies: [] },
    ));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('unknown_dependency'))).toBe(true);
  });

  it('rejects an empty plan and a one-child plan', () => {
    expect(validateDelegationPlan(parent(), plan()).reasons).toContain('empty_plan');
    const single = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'do the whole thing', writePaths: [], dependencies: [] },
    ));
    expect(single.valid).toBe(false);
    expect(single.reasons).toContain('single_child_plan_is_not_a_split');
  });

  it('rejects a plan from a node with no spawn authority', () => {
    const result = validateDelegationPlan(
      parent({ authority: { ...PARENT, spawn_children: false } }),
      plan(
        { id: 'a', goal: 'add tokenizer tests', writePaths: [], dependencies: [] },
        { id: 'b', goal: 'document the emitter options', writePaths: [], dependencies: [] },
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('parent_may_not_spawn_children');
  });
});

describe('parentDeliverables', () => {
  it('finds explicitly enumerated parts', () => {
    expect(parentDeliverables('Fix auth; also optimize the DB; also update the UI')).toHaveLength(3);
  });

  it('infers nothing from prose that enumerates nothing', () => {
    expect(parentDeliverables('Make the parser faster and more correct')).toEqual([]);
  });
});

describe('similarity edge cases', () => {
  it('does not call two unreadable subgoals clones of each other', () => {
    // A planner that returns placeholders gives nothing to compare. Refusing to
    // fund on no evidence is worse than funding, so this is not a clone.
    const result = validateDelegationPlan(parent(), plan(
      { id: 'a', goal: 'a', writePaths: [], dependencies: [] },
      { id: 'b', goal: 'b', writePaths: [], dependencies: [] },
    ));
    expect(result.reasons).not.toContain('duplicate_or_clone_subgoal');
    expect(result.valid).toBe(true);
  });
});
