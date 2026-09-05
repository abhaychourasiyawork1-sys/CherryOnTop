import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { tuiClient } from '../client.js';
import { useTextEntry } from '../input-mode.js';
import type { BusEvent } from '../../events/bus.js';

interface NodeRow { id: string; state: string; goal: string; parentId: string | null }

function badge(state: string): string {
  if (state === 'COMPLETE') return '✓';
  if (state === 'FAILED') return '✗';
  if (state === 'WAIT_APPROVAL') return '!';
  return '●';
}

function stateColor(state: string): string | undefined {
  if (state === 'COMPLETE') return 'green';
  if (state === 'FAILED') return 'red';
  if (state === 'WAIT_APPROVAL') return 'yellow';
  return 'cyan';
}

/** Depth-first ordering with a depth per row, so children sit under the parent
 *  they were delegated by instead of in flat insertion order. */
export function orderAsTree(rows: NodeRow[]): { node: NodeRow; depth: number }[] {
  const byParent = new Map<string | null, NodeRow[]>();
  for (const row of rows) {
    const key = row.parentId && rows.some((r) => r.id === row.parentId) ? row.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const out: { node: NodeRow; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function TreeScreen({ onOpenNode, onNewRun }: { onOpenNode: (nodeId: string) => void; onNewRun: () => void }) {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const setTextEntry = useTextEntry();

  useEffect(() => {
    let alive = true;
    const refresh = () => tuiClient().node.tree.query()
      .then((rows) => { if (alive) setNodes(rows as NodeRow[]); })
      .catch(() => {});
    refresh();

    const subscription = tuiClient().events.subscribe.subscribe(
      {},
      {
        onData: (event: BusEvent) => {
          if (!alive || event.type !== 'state.transition') return;
          const state = (event.payload as { state: string }).state;
          setNodes((prev) => {
            // A transition for a node we have never seen means delegation just
            // created one — refetch rather than inventing a half-populated row.
            if (!prev.some((n) => n.id === event.nodeId)) { refresh(); return prev; }
            return prev.map((n) => (n.id === event.nodeId ? { ...n, state } : n));
          });
        },
      },
    );
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  const matches = (n: NodeRow) => !filter
    || n.goal.toLowerCase().includes(filter.toLowerCase())
    || n.state.toLowerCase().includes(filter.toLowerCase());
  const visible = orderAsTree(nodes).filter(({ node }) => matches(node));
  const cursor = Math.min(selected, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (filtering) {
      if (key.return || key.escape) { setFiltering(false); setTextEntry(false); }
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input) setFilter((f) => f + input);
      return;
    }
    if (input === '/') { setFiltering(true); setTextEntry(true); return; }
    if (input === 'n') { onNewRun(); return; }
    if (key.upArrow || input === 'k') setSelected(Math.max(0, cursor - 1));
    if (key.downArrow || input === 'j') setSelected(Math.min(visible.length - 1, cursor + 1));
    if (key.return && visible[cursor]) onOpenNode(visible[cursor].node.id);
  });

  return (
    <Box flexDirection="column">
      {filtering && <Text>filter: {filter}▌</Text>}
      {!filtering && filter && <Text dimColor>filter: {filter}</Text>}
      {visible.length === 0 && <Text dimColor>No nodes{filter ? ' match that filter' : ' yet'}. Press [n] to start one.</Text>}
      {visible.map(({ node, depth }, i) => (
        <Text key={node.id} inverse={i === cursor} wrap="truncate-end">
          {'  '.repeat(depth)}
          <Text color={stateColor(node.state)}>{badge(node.state)}</Text>
          {' '}{node.id.slice(0, 8)}  {node.state.padEnd(20)} {node.goal}
        </Text>
      ))}
      <Box marginTop={1}><Text dimColor>[↑↓/jk] move  [enter] open  [/] filter  [n] new run  [esc] back</Text></Box>
    </Box>
  );
}
