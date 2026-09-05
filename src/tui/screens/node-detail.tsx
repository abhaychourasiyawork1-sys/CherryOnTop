import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { tuiClient } from '../client.js';
import { useNodeStream } from '../use-node-stream.js';
import { StreamLines } from '../stream-lines.js';
import type { Decision } from '../../schemas/decision.js';
import type { NodeRecord } from '../../db/queries/nodes.js';
import type { BusEvent } from '../../events/bus.js';

const LIFECYCLE_ORDER = [
  'CREATED', 'ORIENT', 'PLAN', 'INTELLIGENCE_GATE', 'EXECUTION_DECISION',
  'SELF_EXECUTE', 'DELEGATE', 'VERIFY', 'COMPLETE',
];

/** How many of the newest stream lines the summary view shows. The full,
 *  unabridged log lives one keypress away on the output screen. */
const LIVE_TAIL = 8;

export function NodeDetailScreen({
  nodeId, onOpenDecisionLog, onOpenOutput,
}: { nodeId: string; onOpenDecisionLog: () => void; onOpenOutput: () => void }) {
  const [node, setNode] = useState<NodeRecord | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lines = useNodeStream(nodeId);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [n, d] = await Promise.all([
          tuiClient().node.get.query({ id: nodeId }),
          tuiClient().decision.listForNode.query({ nodeId }),
        ]);
        if (!alive) return;
        setNode(n as NodeRecord);
        setDecisions(d);
        if (n.state === 'WAIT_APPROVAL') {
          const pending = await tuiClient().node.listPendingApprovals.query();
          if (alive) setPendingApprovalId(pending.find((a) => a.nodeId === nodeId)?.id ?? null);
        } else if (alive) {
          setPendingApprovalId(null);
        }
      } catch (err) {
        if (alive) setNotice(err instanceof Error ? err.message : String(err));
      }
    };
    refresh();

    const subscription = tuiClient().events.subscribe.subscribe(
      { nodeId },
      { onData: (event: BusEvent) => { if (event.type === 'state.transition') refresh(); } },
    );
    return () => { alive = false; subscription.unsubscribe(); };
  }, [nodeId]);

  async function resolve(decision: 'approved' | 'rejected') {
    if (!pendingApprovalId) return;
    setPendingApprovalId(null);
    try {
      await tuiClient().node.resolveApproval.mutate({ approvalId: pendingApprovalId, decision });
      setNotice(`Approval ${decision}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  useInput((input) => {
    if (input === 'd') onOpenDecisionLog();
    if (input === 'l') onOpenOutput();
    if (input === 'y') void resolve('approved');
    if (input === 'r') void resolve('rejected');
  });

  if (!node) return <Text dimColor>{notice ?? 'Loading...'}</Text>;

  const latestDecision = decisions[decisions.length - 1];
  const reached = LIFECYCLE_ORDER.indexOf(node.state);

  return (
    <Box flexDirection="column">
      <Text bold>{node.goal}</Text>
      <Text dimColor>
        {node.id}  budget ${node.contract.authority.budget_usd.toFixed(2)}
        {node.contract.authority.spawn_children ? `  max children ${node.contract.authority.max_child_count}` : '  no delegation'}
      </Text>

      <Box marginTop={1} flexWrap="wrap">
        {LIFECYCLE_ORDER.map((s, i) => (
          <Text key={s}>
            {i > 0 ? ' → ' : ''}
            <Text
              bold={s === node.state}
              color={s === node.state ? 'cyan' : undefined}
              dimColor={reached >= 0 && i > reached}
            >
              {s === node.state ? `[${s}]` : s}
            </Text>
          </Text>
        ))}
        {!LIFECYCLE_ORDER.includes(node.state) && <Text color="yellow">{'  '}({node.state})</Text>}
      </Box>

      {latestDecision && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Decision: <Text color="cyan">{latestDecision.outcome}</Text></Text>
          {Object.entries(latestDecision.breakdown).map(([k, v]) => (
            <Text key={k} dimColor>  {k}: {v}</Text>
          ))}
          {decisions.length > 1 && <Text dimColor>  ({decisions.length} decisions — [d] for all)</Text>}
        </Box>
      )}

      {lines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Output {lines.length > LIVE_TAIL ? `(last ${LIVE_TAIL} of ${lines.length} — [l] for all)` : ''}</Text>
          <StreamLines lines={lines.slice(-LIVE_TAIL)} />
        </Box>
      )}

      {pendingApprovalId && (
        <Box marginTop={1}><Text color="yellow">Awaiting approval — [y] approve  [r] reject</Text></Box>
      )}
      {notice && <Box marginTop={1}><Text dimColor>{notice}</Text></Box>}

      <Box marginTop={1}><Text dimColor>[d] decision log  [l] full output  [esc] back</Text></Box>
    </Box>
  );
}
