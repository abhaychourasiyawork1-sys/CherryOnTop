import { Listr } from 'listr2';

export interface DoctorCheckResult {
  ok: boolean;
  message: string;
}

export interface DoctorCheck {
  name: string;
  run(): Promise<DoctorCheckResult>;
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
