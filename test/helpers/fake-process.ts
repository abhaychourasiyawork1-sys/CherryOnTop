export interface FakeProcess {
  readonly commands: readonly { command: string; args: readonly string[] }[];
  run(command: string, args?: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function createFakeProcess(results: Array<{ exitCode?: number; stdout?: string; stderr?: string }> = []): FakeProcess {
  const commands: { command: string; args: readonly string[] }[] = [];
  return {
    commands,
    async run(command, args = []) {
      commands.push({ command, args });
      const next = results.shift() ?? {};
      return { exitCode: next.exitCode ?? 0, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
    },
  };
}
