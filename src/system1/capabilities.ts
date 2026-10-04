/** Decision capability discovery.
 *
 *  What structured decisions this daemon can have evaluated, described by
 *  contract rather than by engine. A client (the Desktop's Deep Dive, a future
 *  planner) asks this instead of hardcoding "Laya answers decomposability": the
 *  provider behind a capability can be swapped — Laya, JEV, a future private
 *  evaluator — without anything that reads these descriptors changing.
 *
 *  A capability is only listed when System-1 is enabled. Listing one does not
 *  grant anything: every request still goes through the guard's per-scope
 *  budget, and a model-requested decision is still advice that cannot touch
 *  the lifecycle (see model-gateway.ts). */
import { HARNESS_QUESTIONS } from './compiler.js';
import { MODEL_QUESTION_VERSION } from './model-gateway.js';
import { PRIMITIVES, LIMITS, type DecisionPrimitive, type DecisionSurface } from './types.js';

export interface DecisionCapabilityDescriptor {
  /** The decision surface, stable across versions. */
  id: DecisionSurface;
  /** The question wording's version — a new wording is a new version. */
  version: string;
  /** Who may ask it: the runtime itself, or the execution model via
   *  `<cto_decide>`. */
  askedBy: 'harness' | 'model';
  supportedDecisionTypes: DecisionPrimitive[];
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface CapabilityDiscovery {
  enabled: boolean;
  /** Whether the provider can answer right now. Discovery does not depend on
   *  it — a capability exists while its provider is still loading. */
  ready: boolean;
  capabilities: DecisionCapabilityDescriptor[];
}

const INPUT_SCHEMA = {
  type: 'object',
  required: ['surface', 'primitive', 'question', 'questionVersion', 'state', 'candidates', 'inputDigest'],
  properties: {
    question: { type: 'string', maxLength: LIMITS.questionChars },
    candidates: {
      type: 'array',
      maxItems: LIMITS.maxOptions,
      items: { type: 'object', required: ['id', 'description'], properties: { id: { type: 'string', maxLength: LIMITS.idChars }, description: { type: 'string', maxLength: LIMITS.optionChars } } },
    },
    state: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
  },
} as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['requestId', 'result', 'calibration', 'confidence', 'metadata'],
  properties: {
    result: {
      type: 'object',
      properties: {
        selectedId: { type: 'string' },
        probabilities: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
        probability: { type: 'number', minimum: 0, maximum: 1 },
        score: { type: 'object', properties: { value: { type: 'number' }, min: { type: 'number' }, max: { type: 'number' } } },
      },
    },
  },
} as const;

/** Which primitive each harness surface is asked as. */
const HARNESS_PRIMITIVE: Record<keyof typeof HARNESS_QUESTIONS, DecisionPrimitive> = {
  'execution.decomposable': 'choice',
  'execution.change_requested': 'choice',
  'execution.difficulty': 'choice',
  'action.helpful': 'noul',
  'info.finish': 'noul',
  'info.elide': 'noul',
  'runtime.next_action': 'choice',
};

export function discoverDecisionCapabilities(system1: { mode: string; ready: boolean }): CapabilityDiscovery {
  if (system1.mode === 'off') return { enabled: false, ready: false, capabilities: [] };
  const harness = (Object.keys(HARNESS_QUESTIONS) as (keyof typeof HARNESS_QUESTIONS)[]).map((surface) => ({
    id: surface,
    version: HARNESS_QUESTIONS[surface].version,
    askedBy: 'harness' as const,
    supportedDecisionTypes: [HARNESS_PRIMITIVE[surface]],
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
  }));
  return {
    enabled: true,
    ready: system1.ready,
    capabilities: [
      ...harness,
      {
        id: 'model.request',
        version: MODEL_QUESTION_VERSION,
        askedBy: 'model',
        supportedDecisionTypes: [...PRIMITIVES],
        inputSchema: INPUT_SCHEMA,
        outputSchema: OUTPUT_SCHEMA,
      },
    ],
  };
}
