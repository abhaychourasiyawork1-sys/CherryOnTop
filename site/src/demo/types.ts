export type DemoState =
  | 'goal'
  | 'organization'
  | 'mandate'
  | 'executing'
  | 'failure'
  | 'recovering'
  | 'validating'
  | 'verified'
  | 'receipt'
  | 'memory';

export type DemoNodeId = 'frontend' | 'backend' | 'data' | 'verification';

export interface DemoCounters {
  filesRead: number;
  filesChanged: number;
  commands: number;
  checks: number;
  checksPassed: number;
  artifacts: number;
  spend: number;
  budget: number;
}

export interface DemoSnapshot {
  state: DemoState;
  activeNodeId: DemoNodeId | null;
  counters: DemoCounters;
  approvalRequired: boolean;
  receiptVisible: boolean;
  memoryRun: 1 | 2 | null;
}

export type DemoEvent =
  | { type: 'NEXT' }
  | { type: 'RESET' }
  | { type: 'INSPECT_NODE'; nodeId: DemoNodeId }
  | { type: 'CLOSE_INSPECTOR' }
  | { type: 'REPLAY' };
