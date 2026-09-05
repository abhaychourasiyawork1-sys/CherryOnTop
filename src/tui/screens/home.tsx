import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Badge } from '@inkjs/ui';
import { tuiClient } from '../client.js';

interface Stats { active: number; complete: number; failed: number; totalCostUsd: number }

export function HomeScreen({ onOpenTree, onNewRun }: { onOpenTree: () => void; onNewRun: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [s, approvals] = await Promise.all([
          tuiClient().daemon.stats.query(),
          tuiClient().node.listPendingApprovals.query(),
        ]);
        if (!alive) return;
        setStats(s);
        setPending(approvals.length);
        setError(false);
      } catch {
        if (alive) setError(true);
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  useInput((input, key) => {
    if (input === 't' || key.return) onOpenTree();
    if (input === 'n') onNewRun();
  });

  return (
    <Box flexDirection="column">
      <Text bold>Accountable Agent Organization Runtime</Text>
      {error && <Text color="red">daemon unreachable — start it with `org daemon start`</Text>}
      {!error && !stats && <Text dimColor>Loading...</Text>}
      {stats && (
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Badge color="green">{stats.complete} complete</Badge>
          <Badge color="yellow">{stats.active} active</Badge>
          <Badge color="red">{stats.failed} failed</Badge>
          <Text dimColor>${stats.totalCostUsd.toFixed(4)} spent</Text>
        </Box>
      )}
      {pending > 0 && (
        <Box marginTop={1}><Text color="yellow">{pending} awaiting approval — press [a] to jump to the next one</Text></Box>
      )}
      <Box marginTop={1}><Text dimColor>[t]/[enter] tree   [n] new run   [a] next approval   [q] quit</Text></Box>
    </Box>
  );
}
