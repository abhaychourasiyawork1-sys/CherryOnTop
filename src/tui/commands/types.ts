import type { Block } from '../transcript.js';

/** The handles a command needs onto the running TUI. Everything a command can
 *  do to the shell goes through here, so the registry stays testable without
 *  rendering anything. */
export interface CommandContext {
  /** Appends blocks mid-run. Commands that produce output over time — /doctor
   *  running checks one at a time — use this instead of only returning. */
  emit(blocks: Block[]): void;
  setFocus(nodeId: string | null): void;
  focus(): string | null;
  setVerbose(on: boolean): void;
  verbose(): boolean;
  clear(): void;
  quit(): void;
  loadHistory(count: number): Promise<number>;
  toggleNotify(): boolean;
}

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  /** Completions for the argument after the command name — pending approval ids
   *  for /approve, running nodes for /stop, and so on. This is what makes the
   *  command line usable without memorising ids off the transcript. */
  completeArg?: (partial: string) => Promise<string[]>;
  run(args: string, ctx: CommandContext): Promise<Block[]>;
}

export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'unknown'; name: string }
  | { kind: 'command'; name: string; args: string };
