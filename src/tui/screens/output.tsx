import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useNodeStream } from '../use-node-stream.js';
import { StreamLines } from '../stream-lines.js';

/** Rows of stream kept on screen. Ink repaints the whole tree every update, so
 *  an unbounded log makes a long run's redraw crawl. */
const WINDOW = 40;

export function OutputScreen({ nodeId }: { nodeId: string }) {
  const lines = useNodeStream(nodeId);
  // Absolute index of the first visible line, or null while following the tail.
  // Anchoring to the index rather than to a distance from the end is what keeps
  // the passage you are reading still while new lines arrive underneath it.
  const [anchor, setAnchor] = useState<number | null>(null);

  const tailStart = Math.max(0, lines.length - WINDOW);
  const start = anchor === null ? tailStart : Math.min(anchor, tailStart);
  const following = anchor === null;

  const scrollTo = (index: number) => setAnchor(index >= tailStart ? null : Math.max(0, index));

  useInput((input, key) => {
    if (key.upArrow || input === 'k') scrollTo(start - 1);
    if (key.downArrow || input === 'j') scrollTo(start + 1);
    if (key.pageUp) scrollTo(start - WINDOW);
    if (key.pageDown) scrollTo(start + WINDOW);
    if (input === 'f') setAnchor(null); // snap back to following the tail
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        Full output {following
          ? <Text color="green">● following</Text>
          : <Text color="yellow">↑ lines {start + 1}–{Math.min(lines.length, start + WINDOW)} of {lines.length}</Text>}
      </Text>
      {lines.length === 0 && <Text dimColor>No output yet.</Text>}
      <StreamLines lines={lines.slice(start, start + WINDOW)} />
      <Box marginTop={1}><Text dimColor>[↑↓/jk] scroll  [pgup/pgdn] page  [f] jump to live  [esc] back</Text></Box>
    </Box>
  );
}
