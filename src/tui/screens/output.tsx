import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useNodeStream } from '../use-node-stream.js';
import { StreamLines } from '../stream-lines.js';

/** Rows of stream kept on screen. Ink repaints the whole tree every update, so
 *  an unbounded log makes a long run's redraw crawl. */
const WINDOW = 40;

export function OutputScreen({ nodeId }: { nodeId: string }) {
  const lines = useNodeStream(nodeId);
  const [offset, setOffset] = useState(0); // rows scrolled back from the tail

  const maxOffset = Math.max(0, lines.length - WINDOW);
  const clamped = Math.min(offset, maxOffset);
  const end = lines.length - clamped;
  const following = clamped === 0;

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setOffset(Math.min(maxOffset, clamped + 1));
    if (key.downArrow || input === 'j') setOffset(Math.max(0, clamped - 1));
    if (key.pageUp) setOffset(Math.min(maxOffset, clamped + WINDOW));
    if (key.pageDown) setOffset(Math.max(0, clamped - WINDOW));
    if (input === 'f') setOffset(0); // snap back to following the tail
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        Full output {following ? <Text color="green">● following</Text> : <Text color="yellow">↑ scrolled back {clamped}</Text>}
      </Text>
      {lines.length === 0 && <Text dimColor>No output yet.</Text>}
      <StreamLines lines={lines.slice(Math.max(0, end - WINDOW), end)} />
      <Box marginTop={1}><Text dimColor>[↑↓/jk] scroll  [pgup/pgdn] page  [f] jump to live  [esc] back</Text></Box>
    </Box>
  );
}
