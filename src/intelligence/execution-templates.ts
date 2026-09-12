/** What a task of this kind usually takes, as a prior rather than a workflow.
 *
 *  The distinction matters. A workflow is steps that must happen; a prior is
 *  steps that usually help, every one of which the decision engine may remove
 *  when existing context already satisfies it. A template that cannot be
 *  shortened is a script, and a script is how a runtime ends up paying for the
 *  same four steps on a task that needed one.
 *
 *  Nothing here dispatches. A template is a list of intentions that the
 *  decision engine prices and prunes.
 */
import type { TaskClass } from './task-judge.js';
import type { DecisionType } from '../decision/types.js';

export interface TemplateStep {
  /** What this step is for, in the common decision vocabulary. */
  intent: DecisionType;
  /** A short name for a receipt. */
  name: string;
  /** The semantic identities this step would establish. If they are already
   *  known, the step is redundant and is dropped. */
  establishes: string[];
  /** False when removing the step would change what the task means rather than
   *  only what it costs. Verification is the usual case. */
  optional: boolean;
}

export interface ExecutionTemplate {
  taskClass: TaskClass;
  steps: TemplateStep[];
}

const step = (
  intent: DecisionType,
  name: string,
  establishes: string[],
  optional = true,
): TemplateStep => ({ intent, name, establishes, optional });

const TEMPLATES: Record<TaskClass, TemplateStep[]> = {
  trivial_edit: [
    step('RUN_MODEL', 'make the edit', ['edit'], false),
  ],
  investigation: [
    // Reading before running is the whole shape of an investigation, and the
    // reading is what a prior context projection can often skip.
    step('RETRIEVE_CONTEXT', 'locate the relevant code', ['repo_structure']),
    step('RUN_MODEL', 'investigate', ['findings'], false),
  ],
  debugging: [
    step('RETRIEVE_CONTEXT', 'locate the failing path', ['repo_structure']),
    step('RUN_TEST', 'reproduce the failure', ['failure_evidence']),
    step('RUN_MODEL', 'diagnose', ['root_cause'], false),
  ],
  implementation: [
    step('RETRIEVE_CONTEXT', 'locate the code to change', ['repo_structure']),
    step('RUN_MODEL', 'make the change', ['edit'], false),
    step('RUN_TEST', 'verify the change', ['verification']),
  ],
  test_authoring: [
    step('RETRIEVE_CONTEXT', 'locate the code under test', ['repo_structure']),
    step('RUN_MODEL', 'write the tests', ['edit'], false),
    step('RUN_TEST', 'run them', ['verification']),
  ],
  documentation: [
    step('RETRIEVE_CONTEXT', 'locate what is being documented', ['repo_structure']),
    step('RUN_MODEL', 'write the documentation', ['edit'], false),
  ],
  multi_workstream: [
    step('RUN_MODEL', 'plan the split', ['plan']),
    step('SPAWN_AGENT', 'delegate the pieces', ['child_results'], false),
    step('SYNTHESIZE', 'combine the answers', ['answer']),
  ],
};

export function templateFor(taskClass: TaskClass): ExecutionTemplate {
  return { taskClass, steps: TEMPLATES[taskClass] };
}

export interface PrunedTemplate {
  taskClass: TaskClass;
  steps: TemplateStep[];
  /** Steps removed because what they would establish is already known. Named,
   *  so a saving is visible rather than an absence. */
  removed: { step: TemplateStep; reason: string }[];
}

/** Drops the steps whose product the runtime already holds.
 *
 *  A step is only droppable when it is optional *and* everything it would
 *  establish is known. Both conditions: a mandatory step whose product is known
 *  is still the step that makes the task mean what it means, and dropping it
 *  would turn "implement this" into "look at it". */
export function pruneTemplate(template: ExecutionTemplate, known: Set<string>): PrunedTemplate {
  const steps: TemplateStep[] = [];
  const removed: { step: TemplateStep; reason: string }[] = [];

  for (const step of template.steps) {
    const satisfied = step.establishes.length > 0 && step.establishes.every((id) => known.has(id));
    if (satisfied && step.optional) {
      removed.push({ step, reason: `${step.establishes.join(', ')} is already known` });
      continue;
    }
    steps.push(step);
  }
  return { taskClass: template.taskClass, steps, removed };
}
