import type { DemoCounters, DemoNodeId, DemoState } from './types';

/**
 * The recurring illustrative scenario used everywhere the product demo appears:
 * one goal, organized into accountable responsibilities, that hits a real
 * failure and recovers in front of the visitor before it is verified.
 */
export const DEMO_PROJECT = 'Build a customer support platform';

export interface DemoNodeInfo {
  id: DemoNodeId;
  title: string;
  role: string;
  authority: string;
  budget: string;
}

export const DEMO_NODES: DemoNodeInfo[] = [
  {
    id: 'frontend',
    title: 'Frontend',
    role: 'Builds the customer-facing support UI',
    authority: 'Development',
    budget: '$1.25',
  },
  {
    id: 'backend',
    title: 'Backend',
    role: 'Implements the support-ticket API',
    authority: 'Development',
    budget: '$1.80',
  },
  {
    id: 'verification',
    title: 'Verification',
    role: 'Independently checks the work produced',
    authority: 'Validation',
    budget: '$0.95',
  },
  {
    id: 'data',
    title: 'Data',
    role: 'Owns the schema and database migrations',
    authority: 'Development',
    budget: '$1.00',
  },
];

/**
 * The exact illustrative sequence, in order. `transition()` walks this array
 * on every `NEXT` event so the lifecycle can never skip failure or recovery.
 */
export const DEMO_STATE_SEQUENCE: DemoState[] = [
  'goal',
  'organization',
  'mandate',
  'executing',
  'failure',
  'recovering',
  'validating',
  'verified',
  'receipt',
  'memory',
];

const BUDGET = 5;
const VERIFIED_SPEND = 2.31;
const TOTAL_CHECKS = 47;

/**
 * Illustrative counters snapshot per lifecycle state. Kept separate from the
 * transition logic so later visual refinements never alter demo behavior.
 */
export const DEMO_COUNTERS: Record<DemoState, DemoCounters> = {
  goal: {
    filesRead: 0,
    filesChanged: 0,
    commands: 0,
    checks: 0,
    checksPassed: 0,
    artifacts: 0,
    spend: 0,
    budget: BUDGET,
  },
  organization: {
    filesRead: 0,
    filesChanged: 0,
    commands: 0,
    checks: 0,
    checksPassed: 0,
    artifacts: 0,
    spend: 0,
    budget: BUDGET,
  },
  mandate: {
    filesRead: 0,
    filesChanged: 0,
    commands: 0,
    checks: 0,
    checksPassed: 0,
    artifacts: 0,
    spend: 0.42,
    budget: BUDGET,
  },
  executing: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: 0,
    artifacts: 17,
    spend: 1.42,
    budget: BUDGET,
  },
  failure: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: 38,
    artifacts: 17,
    spend: 1.98,
    budget: BUDGET,
  },
  recovering: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: 38,
    artifacts: 17,
    spend: 2.1,
    budget: BUDGET,
  },
  validating: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: 44,
    artifacts: 17,
    spend: 2.2,
    budget: BUDGET,
  },
  verified: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: TOTAL_CHECKS,
    artifacts: 17,
    spend: VERIFIED_SPEND,
    budget: BUDGET,
  },
  receipt: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: TOTAL_CHECKS,
    artifacts: 17,
    spend: VERIFIED_SPEND,
    budget: BUDGET,
  },
  memory: {
    filesRead: 18,
    filesChanged: 12,
    commands: 31,
    checks: TOTAL_CHECKS,
    checksPassed: TOTAL_CHECKS,
    artifacts: 17,
    spend: VERIFIED_SPEND,
    budget: BUDGET,
  },
};
