import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { Spinner } from '@inkjs/ui';
import { matchCommands, COMMANDS } from './commands/index.js';
import type { Command } from './commands/types.js';

interface Props {
  onSubmit: (raw: string) => void;
  onInterrupt: () => void;
  onQuit: () => void;
  busy?: boolean;
}

const MENU_ROWS = 8;
const DOUBLE_CTRL_C_MS = 2000;

/** The command name being typed, or null when the menu should not be open.
 *  Only while the value is a bare `/word` — once there is a space the user is
 *  typing arguments and a menu over the top of them is noise. */
function menuPrefix(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const rest = value.slice(1);
  return /\s/.test(rest) ? null : rest;
}

/** The command and the argument being typed, once the user is past the command
 *  name. This is what lets `/approve ⇥` offer the ids actually waiting, instead
 *  of making someone copy one off the transcript by eye. */
function argContext(value: string): { command: Command; partial: string } | null {
  if (!value.startsWith('/')) return null;
  const match = /^\/(\S+)\s(.*)$/.exec(value);
  if (!match) return null;
  const command = COMMANDS.find((c) => c.name === match[1].toLowerCase());
  if (!command?.completeArg) return null;
  return { command, partial: match[2] };
}

export function InputBox({ onSubmit, onInterrupt, onQuit, busy = false }: Props) {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [quitHint, setQuitHint] = useState(false);
  const { columns } = useWindowSize();

  // The line in progress when history recall started, so walking back down
  // restores it instead of destroying what was being typed.
  const draft = useRef('');
  const lastCtrlC = useRef(0);

  const [argOptions, setArgOptions] = useState<string[]>([]);

  const prefix = menuPrefix(value);
  const menu: Command[] = prefix === null ? [] : matchCommands(prefix);
  const menuOpen = menu.length > 0;
  const cursor = Math.min(selected, Math.max(0, menu.length - 1));

  const argCtx = argContext(value);
  const argMenuOpen = argOptions.length > 0 && argCtx !== null;
  const argCursor = Math.min(selected, Math.max(0, argOptions.length - 1));

  // Argument completions come from the daemon, so they are fetched rather than
  // computed. Stale responses are discarded — typing fast otherwise leaves an
  // earlier query's ids on screen under a later prefix.
  useEffect(() => {
    if (!argCtx) { setArgOptions([]); return; }
    let current = true;
    argCtx.command.completeArg!(argCtx.partial)
      .then((options) => { if (current) setArgOptions(options); })
      .catch(() => { if (current) setArgOptions([]); });
    return () => { current = false; };
  }, [value]);

  const complete = useCallback((command: Command) => {
    setValue(`/${command.name} `);
    setSelected(0);
  }, []);

  const submit = useCallback((raw: string) => {
    const trimmed = raw.trim();
    setValue('');
    setSelected(0);
    setHistoryIndex(null);
    if (!trimmed) return;
    setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed]));
    onSubmit(trimmed);
  }, [onSubmit]);

  // Bracketed paste arrives as one string on its own channel. Without this a
  // pasted multi-line goal is read as a burst of keystrokes and submits itself
  // on the first newline.
  usePaste((text) => {
    setValue((v) => v + text.replace(/\r?\n/g, ' ').trim());
    setQuitHint(false);
  });

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (now - lastCtrlC.current < DOUBLE_CTRL_C_MS) { onQuit(); return; }
      lastCtrlC.current = now;
      setQuitHint(true);
      return;
    }
    setQuitHint(false);

    if (key.escape) {
      // Close the menu first; only an already-closed menu means "interrupt".
      if (menuOpen) { setValue(''); setSelected(0); return; }
      onInterrupt();
      return;
    }

    if (key.tab && menuOpen && menu[cursor]) { complete(menu[cursor]); return; }
    if (key.tab && argMenuOpen) {
      setValue(`/${argCtx!.command.name} ${argOptions[argCursor]} `.trimEnd() + ' ');
      setSelected(0);
      return;
    }

    if (key.return) {
      // Enter on an open menu completes rather than submitting a half-typed
      // command name — the same reflex Claude Code's menu has.
      if (menuOpen && prefix !== null && !COMMANDS.some((c) => c.name === prefix) && menu[cursor]) {
        complete(menu[cursor]);
        return;
      }
      submit(value);
      return;
    }

    if (key.upArrow) {
      if (menuOpen) { setSelected(Math.max(0, cursor - 1)); return; }
      if (argMenuOpen) { setSelected(Math.max(0, argCursor - 1)); return; }
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      if (historyIndex === null) draft.current = value;
      setHistoryIndex(next);
      setValue(history[next]);
      return;
    }

    if (key.downArrow) {
      if (menuOpen) { setSelected(Math.min(menu.length - 1, cursor + 1)); return; }
      if (argMenuOpen) { setSelected(Math.min(argOptions.length - 1, argCursor + 1)); return; }
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) { setHistoryIndex(null); setValue(draft.current); return; }
      setHistoryIndex(next);
      setValue(history[next]);
      return;
    }

    // `?` on an empty line is the help shortcut; anywhere else it is just a
    // character, since goals legitimately contain question marks.
    if (input === '?' && value === '') { submit('/help'); return; }

    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
    // Ctrl/meta chords are commands, not text — appending them would put
    // control characters into a goal.
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        {busy ? <Box marginRight={1}><Spinner /></Box> : <Text color="cyan">{'> '}</Text>}
        <Text>{value}</Text>
        <Text inverse> </Text>
      </Box>

      {menuOpen && (
        <Box flexDirection="column" paddingX={2}>
          {menu.slice(0, MENU_ROWS).map((command, i) => (
            <Text key={command.name} inverse={i === cursor} wrap="truncate-end">
              {`/${command.name}`.padEnd(12)} <Text dimColor={i !== cursor}>{command.summary}</Text>
            </Text>
          ))}
          {menu.length > MENU_ROWS && <Text dimColor>  …{menu.length - MENU_ROWS} more</Text>}
          <Text dimColor>  ⏎ run · ⇥ complete · esc dismiss</Text>
        </Box>
      )}

      {!menuOpen && argMenuOpen && (
        <Box flexDirection="column" paddingX={2}>
          {argOptions.slice(0, MENU_ROWS).map((option, i) => (
            <Text key={option} inverse={i === argCursor} wrap="truncate-end">{option}</Text>
          ))}
          <Text dimColor>  ⇥ complete · ↑↓ choose</Text>
        </Box>
      )}

      {!menuOpen && !argMenuOpen && (
        <Box paddingX={2}>
          <Text dimColor wrap="truncate-end">
            {quitHint
              ? 'press ctrl+c again to quit'
              : `/ for commands · ↑↓ history · esc interrupt${columns < 60 ? '' : ' · type a goal to start a run'}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
