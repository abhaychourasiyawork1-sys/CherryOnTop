import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput, ConfirmInput } from '@inkjs/ui';
import { tuiClient } from '../client.js';
import { useTextEntry } from '../input-mode.js';
import { nonNegativeNumber, resolveRepoPath } from '../../cli/validation.js';
import { toContainerPath } from '../../k8s/kind.js';

type Field = 'goal' | 'repo' | 'spawn' | 'budget' | 'maxChildren' | 'submitting' | 'error';

export function NewRunScreen({ onCreated }: { onCreated: (nodeId: string) => void }) {
  const [field, setField] = useState<Field>('goal');
  const [goal, setGoal] = useState('');
  const [repo, setRepo] = useState(process.cwd());
  const [spawn, setSpawn] = useState(false);
  const [budget, setBudget] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const setTextEntry = useTextEntry();

  // The form owns the keyboard for as long as it is on screen; otherwise typing
  // "quit" into the goal field would quit on the q.
  useEffect(() => {
    setTextEntry(true);
    return () => setTextEntry(false);
  }, [setTextEntry]);

  async function submit(maxChildrenRaw: string) {
    setField('submitting');
    try {
      const authority = {
        tools: [],
        spawn_children: spawn,
        max_child_count: nonNegativeNumber('max children')(maxChildrenRaw),
        budget_usd: nonNegativeNumber('budget')(budget),
      };
      const repoPath = toContainerPath(resolveRepoPath(repo));
      const result = await tuiClient().node.create.mutate({
        goal, definition_of_done: [goal], authority, constraints: [], repoPath,
      });
      setTextEntry(false);
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setField('error');
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold>New run</Text>
      {goal && field !== 'goal' && <Text dimColor>goal: {goal}</Text>}
      {field === 'goal' && (
        <Box><Text>Goal: </Text><TextInput onSubmit={(v) => { setGoal(v); setField('repo'); }} /></Box>
      )}
      {field === 'repo' && (
        <Box><Text>Repo: </Text><TextInput defaultValue={repo} onSubmit={(v) => { setRepo(v); setField('spawn'); }} /></Box>
      )}
      {field === 'spawn' && (
        <Box>
          <Text>Allow delegation? </Text>
          <ConfirmInput
            defaultChoice="cancel"
            onConfirm={() => { setSpawn(true); setField('budget'); }}
            onCancel={() => { setSpawn(false); setField('budget'); }}
          />
        </Box>
      )}
      {field === 'budget' && (
        <Box><Text>Budget (USD): </Text><TextInput defaultValue="0" onSubmit={(v) => { setBudget(v); setField('maxChildren'); }} /></Box>
      )}
      {field === 'maxChildren' && (
        <Box><Text>Max children: </Text><TextInput defaultValue="0" onSubmit={(v) => void submit(v)} /></Box>
      )}
      {field === 'submitting' && <Text dimColor>Creating...</Text>}
      {field === 'error' && <Text color="red">Error: {error} — [esc] back</Text>}
    </Box>
  );
}
