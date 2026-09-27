import { useMemo } from 'react';
import { Conversation } from '../panels/Conversation.js';
import { subtreeOf } from '../lib/tasks.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';

/** The full working of one run — every agent, indented by depth — as a
 *  surface beside the conversation rather than the conversation itself. */
export function RunTranscript({ caseId }: { caseId: string }) {
  const ws = useWorkspace();
  const root = ws.org.nodes.find((node) => node.id === caseId);
  const nodes = useMemo(() => subtreeOf(ws.org.nodes, caseId), [ws.org.nodes, caseId]);
  if (!root) return <p className="surface-empty">This run is not in this Workspace.</p>;
  return (
    <div className="run-transcript">
      <Conversation
        task={root}
        nodes={nodes}
        events={ws.org.events}
        approvals={[]}
        exchanges={[]}
        revision={ws.org.revision}
        onOpenNode={(nodeId) => ws.openSection('agents', nodeId)}
        onResolveApproval={ws.resolveApproval}
      />
    </div>
  );
}
