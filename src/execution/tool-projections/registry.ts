/** Which reducer understands which tool's output.
 *
 *  A registry rather than a switch because the interesting property is
 *  *coverage*: "does anything understand `pnpm test` output" has to be
 *  answerable, and a switch statement buried in a reducer cannot answer it. The
 *  fallback is deliberate and explicit — unknown output is collapsed and
 *  bounded, never silently cut.
 *
 *  Every projection returns a reduction that keeps a ref to the full artifact.
 *  That is enforced by the caller (`projectObservation`), not left to each
 *  reducer's good intentions.
 */
import type { Observation, ObservationMode } from '../observation.js';
import { reduceGeneric, unreduced, type Reduction } from '../observation-reducer.js';
import { gitProjection } from './git.js';
import { searchProjection } from './search.js';
import { testProjection, buildProjection } from './test-build.js';
import { filesystemProjection } from './filesystem.js';
import { runtimeLogProjection } from './runtime-log.js';

export interface ToolProjection {
  /** What this projection is called in a receipt. */
  name: string;
  /** Whether it understands this observation. Asked in registration order, so
   *  a narrower projection must be registered before a broader one. */
  matches(observation: Observation): boolean;
  /** Deterministic, model-free. */
  reduce(raw: string): Reduction;
}

/** Narrowest first. `runtime-log` matches broadly and must come last, or it
 *  would claim output a real reducer understands. */
export const PROJECTIONS: ToolProjection[] = [
  gitProjection,
  testProjection,
  buildProjection,
  searchProjection,
  filesystemProjection,
  runtimeLogProjection,
];

/** How many lines survive when nothing understands the output. Generous: the
 *  cost of keeping too much of an unrecognised log is tokens, and the cost of
 *  keeping too little is a wrong answer. */
export const GENERIC_MAX_LINES = 60;

export function projectionFor(observation: Observation): ToolProjection | undefined {
  return PROJECTIONS.find((projection) => projection.matches(observation));
}

export interface ProjectedObservation {
  observationId: string;
  mode: ObservationMode;
  /** Which projection ran, or `generic` when none claimed it. Named so a
   *  receipt can show that a tool's output was understood rather than cut. */
  projection: string;
  text: string;
  reduction: Reduction;
  /** The semantic identity of the full, unreduced output. Every reduced view
   *  carries this — reduction is a view, and a view that cannot be un-taken is
   *  data loss. */
  fullRef: string;
}

export function projectObservation(observation: Observation, mode: ObservationMode = 'reduced'): ProjectedObservation {
  const base = { observationId: observation.observationId, mode, fullRef: observation.semanticId };

  if (mode === 'reference') {
    const summary = `${observation.tool.name}${observation.tool.operation ? ` ${observation.tool.operation}` : ''} → ${observation.semanticId}`;
    return { ...base, projection: 'reference', text: summary, reduction: unreduced(summary) };
  }
  if (mode === 'full') {
    return { ...base, projection: 'full', text: observation.raw, reduction: unreduced(observation.raw) };
  }

  const projection = projectionFor(observation);
  const reduction = projection
    ? projection.reduce(observation.raw)
    : reduceGeneric(observation.raw, GENERIC_MAX_LINES);
  return { ...base, projection: projection?.name ?? 'generic', text: reduction.text, reduction };
}
