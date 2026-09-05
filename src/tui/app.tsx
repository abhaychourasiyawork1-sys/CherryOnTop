import React, { useCallback, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { pushScreen, popScreen, breadcrumb, type Screen } from './navigation.js';
import { TextEntryContext, EscapeOwnerContext } from './input-mode.js';
import { tuiClient } from './client.js';
import { HomeScreen } from './screens/home.js';
import { TreeScreen } from './screens/tree.js';
import { NodeDetailScreen } from './screens/node-detail.js';
import { DecisionLogScreen } from './screens/decision-log.js';
import { OutputScreen } from './screens/output.js';
import { NewRunScreen } from './screens/new-run.js';

export function App() {
  const { exit } = useApp();
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }]);
  const [textEntry, setTextEntry] = useState(false);
  const [escapeHandled, setEscapeHandled] = useState(false);
  const current = stack[stack.length - 1];

  const push = useCallback((screen: Screen) => setStack((s) => pushScreen(s, screen)), []);
  const pop = useCallback(() => setStack((s) => popScreen(s)), []);
  // Replaces the top of the stack — leaving the submitted form on the stack
  // would make [esc] walk back into a spent form.
  const replace = useCallback((screen: Screen) => setStack((s) => pushScreen(popScreen(s), screen)), []);

  // Escape is handled unconditionally: a screen that has taken over the
  // keyboard (a text field, the tree's filter prompt) must still be leavable.
  // Screens that want to consume Escape themselves set escapeHandled.
  useInput((_input, key) => {
    if (key.escape && !escapeHandled) pop();
  });

  useInput((input, key) => {
    if (key.escape) return; // owned by the handler above
    if (input === 'q') { exit(); return; }
    if (input === 'a') {
      tuiClient().node.listPendingApprovals.query()
        .then((pending) => { if (pending[0]) push({ name: 'node', nodeId: pending[0].nodeId }); })
        .catch(() => {});
    }
  }, { isActive: !textEntry });

  return (
    <TextEntryContext.Provider value={setTextEntry}>
      <EscapeOwnerContext.Provider value={setEscapeHandled}>
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>org › {breadcrumb(stack)}</Text>
        <Box marginTop={1} flexDirection="column">
          {current.name === 'home' && (
            <HomeScreen onOpenTree={() => push({ name: 'tree' })} onNewRun={() => push({ name: 'new-run' })} />
          )}
          {current.name === 'tree' && (
            <TreeScreen onOpenNode={(nodeId) => push({ name: 'node', nodeId })} onNewRun={() => push({ name: 'new-run' })} />
          )}
          {current.name === 'node' && (
            <NodeDetailScreen
              nodeId={current.nodeId}
              onOpenDecisionLog={() => push({ name: 'decision-log', nodeId: current.nodeId })}
              onOpenOutput={() => push({ name: 'output', nodeId: current.nodeId })}
            />
          )}
          {current.name === 'decision-log' && <DecisionLogScreen nodeId={current.nodeId} />}
          {current.name === 'output' && <OutputScreen nodeId={current.nodeId} />}
          {current.name === 'new-run' && <NewRunScreen onCreated={(nodeId) => replace({ name: 'node', nodeId })} />}
        </Box>
      </Box>
      </EscapeOwnerContext.Provider>
    </TextEntryContext.Provider>
  );
}
