import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { tuiClient } from '../client.js';
import type { Decision } from '../../schemas/decision.js';

export function DecisionLogScreen({ nodeId }: { nodeId: string }) {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);

  useEffect(() => {
    let alive = true;
    tuiClient().decision.listForNode.query({ nodeId })
      .then((d) => { if (alive) setDecisions(d); })
      .catch(() => { if (alive) setDecisions([]); });
    return () => { alive = false; };
  }, [nodeId]);

  return (
    <Box flexDirection="column">
      <Text bold>Full decision log</Text>
      {decisions === null && <Text dimColor>Loading...</Text>}
      {decisions?.length === 0 && <Text dimColor>No decisions yet.</Text>}
      {decisions?.map((d) => (
        <Box key={d.id} flexDirection="column" marginTop={1}>
          <Text bold>{d.type}: <Text color="cyan">{d.outcome}</Text> <Text dimColor>{d.createdAt}</Text></Text>
          {Object.entries(d.breakdown).map(([k, v]) => <Text key={k} dimColor>  {k}: {v}</Text>)}
        </Box>
      ))}
      <Box marginTop={1}><Text dimColor>[esc] back</Text></Box>
    </Box>
  );
}
