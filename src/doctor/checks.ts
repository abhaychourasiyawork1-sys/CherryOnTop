import { Listr } from 'listr2';
import { execFileSync } from 'node:child_process';

export interface DoctorCheckResult {
  ok: boolean;
  message: string;
}

export interface DoctorCheck {
  name: string;
  run(): Promise<DoctorCheckResult>;
}

function defaultProbe(args: string[]): string {
  return execFileSync('claude', args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Which models the current auth can actually call. Advisory: `org doctor`
 *  prints it so a Pro-plan user knows tiering will fall back before they run. */
export function probeModels(run: (args: string[]) => string = defaultProbe): { haiku: boolean; sonnet: boolean } {
  const test = (model: string): boolean => {
    try { run(['--print', '--model', model, 'reply with the single word ok']); return true; }
    catch { return false; }
  };
  return { haiku: test('haiku'), sonnet: test('sonnet') };
}

export async function runChecks(checks: DoctorCheck[]): Promise<boolean> {
  let allOk = true;
  const listr = new Listr(
    checks.map((check) => ({
      title: check.name,
      task: async (_ctx, task) => {
        const result = await check.run();
        if (!result.ok) allOk = false;
        task.title = `${check.name}: ${result.message}`;
        if (!result.ok) throw new Error(result.message);
      },
    })),
    { exitOnError: false },
  );
  await listr.run();
  return allOk;
}
