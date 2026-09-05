import React from 'react';
import { Box, Text } from 'ink';
import type { RenderedLine } from './stream-renderer.js';

function DiffLine({ line }: { line: string }) {
  const color = line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined;
  return <Text color={color} dimColor={!color}>  {line}</Text>;
}

/** One rendered stream line. The transcript view owns list layout and gutters;
 *  this only knows how a single line looks. */
export function StreamLine({ line }: { line: RenderedLine }) {
  if (line.kind === 'diff') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">✓ {line.content}</Text>
        {(line.diffLines ?? []).map((d, i) => <DiffLine key={i} line={d} />)}
      </Box>
    );
  }
  if (line.kind === 'tool-pending') return <Text color="yellow">◐ {line.content}</Text>;
  if (line.kind === 'tool-done') return <Text color="cyan">✓ {line.content}</Text>;
  if (line.kind === 'thinking') return <Text dimColor italic>{line.content}</Text>;
  if (line.kind === 'summary') return <Text color="magenta">— {line.content}</Text>;
  return <Text>{line.content}</Text>;
}
