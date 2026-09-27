import { useMemo, useState } from 'react';
import { Conversation } from '../panels/Conversation.js';
import { ActivitySurface } from './ActivitySurface.js';
import { subtreeOf } from '../lib/tasks.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';

/** One run in full, beside the conversation: the working as each agent said
 *  it (indented by delegation depth), or its history as a story with the raw
 *  record one step further. Both read the same event log. */
export function RunTranscript({ caseId, initial = 'working' }: { caseId: string; initial?: 'working' | 'history' }) {
  const ws = useWorkspace();
  const [view, setView] = useState(initial);
  const root = ws.org.nodes.find((node) => node.id === caseId);
  const nodes = useMemo(() => subtreeOf(ws.org.nodes, caseId), [ws.org.nodes, caseId]);
  if (!root) return <p className="surface-empty">This run is not in this Workspace.</p>;
  return (
    <div className="run-transcript">
      <div className="segmented" role="tablist" aria-label="How to read this run">
        <button type="button" role="tab" aria-selected={view === 'working'} onClick={() => setView('working')}>Working</button>
        <button type="button" role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>History</button>
      </div>
      {view === 'history' ? <ActivitySurface caseId={caseId} /> : (
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
      )}
    </div>
  );
}
