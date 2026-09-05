import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { tuiClient } from './client.js';

interface Stats { active: number; complete: number; failed: number; totalCostUsd: number; pendingApprovals: number }

/** `refreshToken` is bumped by the shell whenever a bus event lands, so the
 *  line reacts immediately to something happening rather than waiting out the
 *  poll interval. The interval is the floor, not the mechanism. */
export function StatusLine({ refreshToken }: { refreshToken: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await tuiClient().daemon.stats.query();
        if (!alive) return;
        setStats(next);
        setReachable(true);
      } catch {
        if (alive) setReachable(false);
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, [refreshToken]);

  return (
    <Box paddingX={2}>
      {!reachable && <Text color="red">daemon unreachable</Text>}
      {reachable && stats && (
        <Text dimColor>
          {stats.active} running · {stats.pendingApprovals > 0
            ? <Text color="yellow">{stats.pendingApprovals} waiting on you</Text>
            : <Text>0 waiting</Text>} · ${stats.totalCostUsd.toFixed(4)} · daemon ok
        </Text>
      )}
      {reachable && !stats && <Text dimColor>connecting…</Text>}
    </Box>
  );
}
