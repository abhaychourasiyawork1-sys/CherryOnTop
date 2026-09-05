import React from 'react';
import { Box, Static, Text, useWindowSize } from 'ink';
import { StreamLine } from './stream-lines.js';
import type { Block, Tone } from './transcript.js';

const TONE_PROPS: Record<Tone, { color?: string; dimColor?: boolean }> = {
  info: { dimColor: true },
  warn: { color: 'yellow' },
  good: { color: 'green' },
  bad: { color: 'red' },
};

const indent = (depth: number) => '  '.repeat(depth);

function BlockView({ block, columns }: { block: Block; columns: number }) {
  if (block.kind === 'header') {
    return (
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          {indent(block.depth)}
          <Text color="cyan" bold>┌─ {block.nodeId.slice(0, 8)}</Text>
          <Text dimColor> · {block.goal}</Text>
          {block.state ? <Text color="cyan"> · {block.state}</Text> : null}
        </Text>
      </Box>
    );
  }

  if (block.kind === 'line') {
    return (
      <Box>
        <Text dimColor>{indent(block.depth)}│ </Text>
        <StreamLine line={block.line} />
      </Box>
    );
  }

  if (block.kind === 'system') {
    return (
      <Text wrap="truncate-end">
        {indent(block.depth)}<Text dimColor>│ </Text>
        <Text {...TONE_PROPS[block.tone]}>{block.text}</Text>
      </Text>
    );
  }

  // command
  return (
    <Box flexDirection="column" marginTop={1}>
      {block.input ? <Text color="magenta">{block.input}</Text> : null}
      {block.output.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line.length > columns ? line.slice(0, columns - 1) + '…' : line}</Text>
      ))}
    </Box>
  );
}

/** Finalized blocks go through Ink's `<Static>`: written once, never repainted,
 *  so a long run neither flickers nor pins a CPU, and the terminal's own
 *  scrollback keeps working. Only `live` — the working node's pending tool call
 *  and its spinner — sits in the repainting region.
 *
 *  `staticKey` remounts the Static region, which is the only way to make it
 *  start over after /clear. */
export function TranscriptView({
  blocks, live, staticKey,
}: { blocks: Block[]; live: Block[]; staticKey: number }) {
  const { columns } = useWindowSize();

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={blocks}>
        {(block) => <BlockView key={block.key} block={block} columns={columns} />}
      </Static>
      {live.map((block) => <BlockView key={block.key} block={block} columns={columns} />)}
    </Box>
  );
}
