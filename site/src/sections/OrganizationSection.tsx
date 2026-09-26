import type { JSX } from 'react';
import { DEMO_NODES, DEMO_PROJECT } from '../demo/data';
import { useDemoController } from '../demo/controller';
import type { DemoNodeId, DemoState } from '../demo/types';
import type { Status } from '../types';
import { track } from '../analytics/tracker';
import { ExecutionNode } from '../components/ExecutionNode';
import { ProductMetric } from '../components/ProductMetric';
import { BranchStem } from '../components/BranchStem';

const DEEP_STATES = new Set<DemoState>([
  'executing',
  'failure',
  'recovering',
  'validating',
  'verified',
  'receipt',
  'memory',
]);

const NODE_STATUS_BY_STATE: Record<DemoState, Status> = {
  goal: 'idle',
  organization: 'waiting',
  mandate: 'waiting',
  executing: 'working',
  failure: 'attention',
  recovering: 'recovering',
  validating: 'validating',
  verified: 'verified',
  receipt: 'verified',
  memory: 'verified',
};

export function OrganizationSection(): JSX.Element {
  const { snapshot, dispatch } = useDemoController();
  const { state, activeNodeId } = snapshot;

  if (state === 'goal') {
    return (
      <div className="organization">
        <BranchStem variant="organization" />
      <p className="organization__goal">{DEMO_PROJECT}</p>
      </div>
    );
  }

  const visibleNodes = DEMO_NODES.filter((node) => node.id !== 'data' || DEEP_STATES.has(state));
  const inspectedNode = DEMO_NODES.find((node) => node.id === activeNodeId) ?? null;
  const status = NODE_STATUS_BY_STATE[state];

  function handleInspect(nodeId: DemoNodeId) {
    if (activeNodeId === nodeId) {
      dispatch({ type: 'CLOSE_INSPECTOR' });
    } else {
      dispatch({ type: 'INSPECT_NODE', nodeId });
      track('organization_explored', { node: nodeId });
    }
  }

  return (
    <div className="organization">
      <p className="organization__goal">{DEMO_PROJECT}</p>
      <div className="organization__nodes">
        {visibleNodes.map((node) => (
          <ExecutionNode
            key={node.id}
            id={node.id}
            title={node.title}
            role={node.role}
            status={status}
            budget={node.budget}
            selected={activeNodeId === node.id}
            dimmed={activeNodeId !== null && activeNodeId !== node.id}
            onInspect={() => handleInspect(node.id)}
          />
        ))}
      </div>
      {inspectedNode ? (
        <div className="organization__inspector" data-testid="organization-inspector">
          <ProductMetric label="Role" value={inspectedNode.role} />
          <ProductMetric label="Authority" value={inspectedNode.authority} />
          <ProductMetric label="Budget" value={inspectedNode.budget} mono />
        </div>
      ) : null}
    </div>
  );
}
