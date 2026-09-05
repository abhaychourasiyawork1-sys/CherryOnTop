import type { Command } from 'commander';
import React, { useEffect, useState } from 'react';
import { render, Box, Text } from 'ink';
import { Badge } from '@inkjs/ui';
import { createDaemonClient } from '../../daemon/client.js';
import { formatNodeLine } from './watch-format.js';

interface NodeRow { id: string; state: string; goal: string }

function WatchApp() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = createDaemonClient();
    const poll = async () => {
      try {
        const tree = await client.node.tree.query();
        setNodes(tree);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold>Accountable Organization — live tree</Text>
      {error && <Badge color="red">daemon unreachable</Badge>}
      {nodes.length === 0 && !error && <Text dimColor>No nodes yet.</Text>}
      {nodes.map((node) => (
        <Text key={node.id}>{formatNodeLine(node)}</Text>
      ))}
    </Box>
  );
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Live dashboard of the organization tree')
    .action(() => {
      render(<WatchApp />);
    });
}
