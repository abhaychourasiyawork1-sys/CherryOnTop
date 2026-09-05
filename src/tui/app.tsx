import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { tuiClient } from './client.js';
import { createTranscript, type Block, type NodeMeta } from './transcript.js';
import { TranscriptView } from './transcript-view.js';
import { StatusLine } from './status-line.js';
import { InputBox } from './input-box.js';
import { runInput } from './commands/index.js';
import type { CommandContext } from './commands/types.js';
import { notifyApprovalNeeded, notifyFinished, toggleNotify } from './notify.js';
import type { BusEvent } from '../events/bus.js';

const HISTORY_ON_OPEN = 200;
const TERMINAL_STATES = ['COMPLETE', 'FAILED', 'CANCELLED'];

interface TreeRow { id: string; parentId: string | null; state: string; goal: string }

export function App() {
  const { exit } = useApp();
  const { write } = useStdout();

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [live, setLive] = useState<Block[]>([]);
  const [staticKey, setStaticKey] = useState(0);
  const [statusToken, setStatusToken] = useState(0);
  const [busy, setBusy] = useState(false);

  // Read synchronously by the transcript on every event, so a child created by
  // delegation mid-run indents correctly without re-creating the reducer.
  const nodeMeta = useRef<Record<string, NodeMeta>>({});
  const nodeRows = useRef<TreeRow[]>([]);
  const transcript = useRef(createTranscript(() => nodeMeta.current));
  const oldestLoadedId = useRef<number | undefined>(undefined);

  const refreshTree = useCallback(async () => {
    const rows = (await tuiClient().node.tree.query().catch(() => null)) as TreeRow[] | null;
    if (!rows) return;
    nodeRows.current = rows;
    nodeMeta.current = Object.fromEntries(rows.map((r) => [r.id, { goal: r.goal, parentId: r.parentId }]));
  }, []);

  /** A pending tool call lives in the repainting region so its spinner and
   *  elapsed time can update; everything else is final the moment it is
   *  produced and goes straight into <Static>. When an update arrives for a
   *  pending line, the resolved version is what gets finalized. */
  const apply = useCallback((produced: Block[]) => {
    if (produced.length === 0) return;
    const finalized: Block[] = [];

    for (const block of produced) {
      if (block.kind === 'line' && block.action === 'update') {
        setLive((prev) => prev.filter((l) => !(l.kind === 'line' && l.line.key === block.line.key)));
        finalized.push(block);
        continue;
      }
      if (block.kind === 'line' && block.line.kind === 'tool-pending') {
        setLive((prev) => [...prev, block]);
        continue;
      }
      // Anything else means the pending call's node has moved on; a tool call
      // left unresolved must still reach the permanent transcript rather than
      // being stranded in a region that later repaints over it.
      setLive((prev) => {
        if (prev.length === 0) return prev;
        finalized.unshift(...prev);
        return [];
      });
      finalized.push(block);
    }

    if (finalized.length > 0) setBlocks((prev) => [...prev, ...finalized]);
  }, []);

  const emit = useCallback((extra: Block[]) => {
    if (extra.length > 0) setBlocks((prev) => [...prev, ...extra]);
  }, []);

  // History first, then live — with the subscription opened before the history
  // query so nothing emitted in between is lost, and buffered events replayed
  // afterwards de-duplicated by row id.
  useEffect(() => {
    let alive = true;
    let replayed = false;
    let highestReplayedId = 0;
    const buffered: BusEvent[] = [];

    // Events are handled through a promise chain so they cannot reorder while
    // one of them waits on a tree refresh.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(() => {}); };

    const handle = async (event: BusEvent): Promise<void> => {
      setStatusToken((t) => t + 1);

      // Resolve the node's goal and parent BEFORE rendering it. A header is
      // written into <Static> permanently, so one printed as "(unknown goal)"
      // because the tree had not been fetched yet can never be corrected —
      // which is exactly what a freshly created node hits, every time.
      if (!nodeMeta.current[event.nodeId]) await refreshTree();

      apply(transcript.current.feed(event));

      if (event.type !== 'state.transition') return;
      const state = (event.payload as { state?: string })?.state;
      if (!state) return;

      const known = nodeMeta.current[event.nodeId];
      if (!known) return;

      if (state === 'WAIT_APPROVAL') notifyApprovalNeeded(event.nodeId, known.goal);
      if (TERMINAL_STATES.includes(state) && known.parentId === null) {
        notifyFinished(event.nodeId, known.goal, state);
      }
    };

    const subscription = tuiClient().events.subscribe.subscribe(
      {},
      {
        onData: (event: BusEvent) => {
          if (!alive) return;
          if (!replayed) { buffered.push(event); return; }
          if (event.id !== undefined && event.id <= highestReplayedId) return;
          enqueue(() => handle(event));
        },
      },
    );

    void (async () => {
      await refreshTree();
      const historical = await tuiClient().events.recent.query({ limit: HISTORY_ON_OPEN }).catch(() => []);
      if (!alive) return;
      for (const event of historical) {
        highestReplayedId = Math.max(highestReplayedId, event.id);
        apply(transcript.current.feed(event as BusEvent));
      }
      oldestLoadedId.current = historical[0]?.id;
      replayed = true;
      for (const event of buffered) {
        if (event.id !== undefined && event.id <= highestReplayedId) continue;
        enqueue(() => handle(event));
      }
      buffered.length = 0;
    })();

    return () => { alive = false; subscription.unsubscribe(); };
  }, [apply, refreshTree]);

  const context: CommandContext = {
    emit,
    setFocus: (nodeId) => transcript.current.setFocus(nodeId),
    focus: () => transcript.current.focus(),
    setVerbose: (on) => transcript.current.setVerbose(on),
    verbose: () => transcript.current.verbose(),
    clear: () => {
      // <Static> output is permanent, so clearing means clearing the terminal
      // and remounting the region — the event log itself is untouched.
      write('\x1b[2J\x1b[3J\x1b[H');
      setBlocks([]);
      setLive([]);
      setStaticKey((k) => k + 1);
    },
    quit: () => exit(),
    loadHistory: async (count) => {
      const older = await tuiClient().events.recent.query({
        limit: count, before: oldestLoadedId.current,
      });
      if (older.length === 0) return 0;
      oldestLoadedId.current = older[0].id;
      // Prepending into <Static> cannot rewrite what is already on screen, so
      // older activity is appended under a marker instead of pretending to
      // scroll up. Honest, and it matches how a terminal actually works.
      emit([{ kind: 'command', key: `hist${older[0].id}`, input: '── earlier activity ──', output: [] }]);
      for (const event of older) apply(transcript.current.feed(event as BusEvent));
      return older.length;
    },
    toggleNotify,
  };

  const handleSubmit = useCallback((raw: string) => {
    setBusy(true);
    // Echo immediately: node.create starts the node synchronously, so its first
    // events can otherwise beat the command's own output into the transcript.
    emit([{ kind: 'command', key: `echo${Date.now()}`, input: `> ${raw}`, output: [] }]);
    void runInput(raw, context)
      .then((produced) => emit(produced))
      .finally(() => { setBusy(false); void refreshTree(); setStatusToken((t) => t + 1); });
  }, [context, emit, refreshTree]);

  const handleInterrupt = useCallback(() => {
    const focused = transcript.current.focus();
    const running = nodeRows.current.filter((r) => !TERMINAL_STATES.includes(r.state));
    const target = focused ?? (running.length === 1 ? running[0].id : null);

    if (!target) {
      emit([{
        kind: 'command', key: `int${Date.now()}`, input: 'esc',
        output: running.length === 0
          ? ['Nothing is running.']
          : ['Several nodes are running — /stop <id>, or /focus one first:',
             ...running.map((r) => `  ${r.id.slice(0, 8)}  ${r.goal}`)],
      }]);
      return;
    }
    void runInput(`/stop ${target}`, context).then((produced) => emit(produced));
  }, [context, emit]);

  return (
    <Box flexDirection="column">
      <TranscriptView blocks={blocks} live={live} staticKey={staticKey} />
      {blocks.length === 0 && live.length === 0 && (
        <Box paddingX={2} marginY={1}>
          <Text dimColor>Nothing yet — type what you want done, or / for commands.</Text>
        </Box>
      )}
      <InputBox onSubmit={handleSubmit} onInterrupt={handleInterrupt} onQuit={exit} busy={busy} />
      <StatusLine refreshToken={statusToken} />
    </Box>
  );
}
