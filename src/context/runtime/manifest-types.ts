/** The vocabulary of a task's context index.
 *
 *  What a manifest is *not* is the point of it. The node's contract owns the goal,
 *  its constraints and its authority; `EconomicState` owns the phase and the
 *  uncertainty; the `events` chain and `artifacts` table own every byte of
 *  evidence; the context store owns each object's freshness. A manifest that
 *  copied any of those would be a second source of truth with a synchronization
 *  bug waiting for it. So it holds exactly one thing nothing else holds:
 *  **which refs belong to this task, in which role.**
 */
import type { ContextRef } from '../types.js';

export const MANIFEST_SECTIONS = [
  'workingSet',    // repository artifacts the task's dispatches were shown or read
  'facts',         // what a finished piece of work established (child findings)
  'decisions',     // choices the task committed to
  'artifacts',     // what the task produced
  'validation',    // checks that ran, and what they said
  'openQuestions', // what is still unknown
] as const;

export type ManifestSection = typeof MANIFEST_SECTIONS[number];

export interface TaskContextManifest {
  taskId: string;
  /** Monotonic per task; increments once per update that changed anything. */
  revision: number;
  /** A hash of the sections' contents. Two manifests with the same refs share
   *  it whatever order the refs arrived in — what a handoff names. */
  contentRevision: string;
  /** The committed repository revision the working set was last recorded
   *  against. Absent when the task is not in a repository. */
  repositoryRevision?: string;
  workingSet: ContextRef[];
  facts: ContextRef[];
  decisions: ContextRef[];
  artifacts: ContextRef[];
  validation: ContextRef[];
  openQuestions: ContextRef[];
  updatedAt: string;
}

export interface ManifestDelta {
  add?: Partial<Record<ManifestSection, ContextRef[]>>;
  remove?: Partial<Record<ManifestSection, ContextRef[]>>;
  repositoryRevision?: string;
}

export interface RejectedRef {
  section: ManifestSection;
  ref: ContextRef;
  reason: 'unknown_ref' | 'superseded' | 'invalid' | 'expired';
}

export interface ManifestUpdate {
  manifest: TaskContextManifest;
  /** False when the delta added nothing new: the revision did not move. */
  changed: boolean;
  rejected: RejectedRef[];
}
