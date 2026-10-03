import { describe, it, expect } from 'vitest';
import { observationsFromEvents, operationOf, observationBytes, verifiedChangeAtTurnCap, isVerifyingCommand } from './observation.js';

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  payload: { message: { content: [{ type: 'tool_use', id, name, input }] } },
});

const result = (toolUseId: string, content: unknown, isError = false) => ({
  type: 'user',
  payload: { message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } },
});

describe('recovering observations from a runtime stream', () => {
  it('pairs a call with its result', () => {
    const [observation] = observationsFromEvents([
      call('t1', 'Read', { file_path: '/workspace/src/a.ts' }),
      result('t1', 'export const a = 1;'),
    ], 'n1');

    expect(observation.tool.name).toBe('Read');
    expect(observation.invocation.input.file_path).toBe('/workspace/src/a.ts');
    expect(observation.raw).toBe('export const a = 1;');
    expect(observation.execution).toMatchObject({ nodeId: 'n1', succeeded: true });
  });

  it('keeps a call that never got a result', () => {
    // A run cut off mid-tool is exactly the case worth being able to see.
    // Dropping it would make a truncated run look like one that never tried.
    const [observation] = observationsFromEvents([call('t1', 'Bash', { command: 'sleep 600' })], 'n1');
    expect(observation.raw).toBe('');
    expect(observation.execution.succeeded).toBe(false);
  });

  it('records a failed tool call as failed rather than as absent', () => {
    const [observation] = observationsFromEvents([
      call('t1', 'Bash', { command: 'exit 1' }),
      result('t1', 'command failed', true),
    ], 'n1');
    expect(observation.execution.succeeded).toBe(false);
    expect(observation.raw).toBe('command failed');
  });

  it('reads a result delivered as content blocks, not only as a string', () => {
    const [observation] = observationsFromEvents([
      call('t1', 'Read', { file_path: 'a.ts' }),
      result('t1', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]),
    ], 'n1');
    expect(observation.raw).toBe('line one\nline two');
  });

  it('gives the same call the same identity, so re-observing does not fork the graph', () => {
    const events = [call('t1', 'Read', { file_path: 'a.ts' }), result('t1', 'x')];
    const again = [call('t9', 'Read', { file_path: 'a.ts' }), result('t9', 'x')];
    expect(observationsFromEvents(events, 'n1')[0].semanticId)
      .toBe(observationsFromEvents(again, 'n2')[0].semanticId);
    // ...and a different call a different one.
    expect(observationsFromEvents([call('t1', 'Read', { file_path: 'b.ts' }), result('t1', 'x')], 'n1')[0].semanticId)
      .not.toBe(observationsFromEvents(events, 'n1')[0].semanticId);
  });

  it('orders observations without needing a clock', () => {
    const observations = observationsFromEvents([
      call('t1', 'Read', { file_path: 'a.ts' }),
      result('t1', 'a'),
      call('t2', 'Read', { file_path: 'b.ts' }),
      result('t2', 'b'),
    ], 'n1');
    expect(observations.map((o) => o.execution.sequence)).toEqual([0, 2]);
  });

  it('sums the raw output a run produced', () => {
    const observations = observationsFromEvents([
      call('t1', 'Read', { file_path: 'a.ts' }), result('t1', 'x'.repeat(100)),
      call('t2', 'Read', { file_path: 'b.ts' }), result('t2', 'y'.repeat(50)),
    ], 'n1');
    expect(observationBytes(observations)).toBe(150);
  });
});

describe('operationOf', () => {
  it('recovers the operation inside a shell command, because git status and git diff are not the same output', () => {
    expect(operationOf('Bash', { command: 'git status --porcelain' })).toBe('git/status');
    expect(operationOf('Bash', { command: '  git   diff HEAD' })).toBe('git/diff');
    expect(operationOf('Bash', { command: 'ls' })).toBe('ls');
    expect(operationOf('Read', { file_path: 'a.ts' })).toBeUndefined();
    expect(operationOf('Bash', { command: '' })).toBeUndefined();
  });
});

describe('verifiedChangeAtTurnCap', () => {
  const call = (id: string, name: string, input: Record<string, unknown>) =>
    ({ type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id, name, input }] } } });
  const done = (id: string, isError = false) =>
    ({ type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] } } });
  const capped = { type: 'result', payload: { subtype: 'error_max_turns' } };

  it('accepts an edit followed by a passing test, cut off at the cap', () => {
    expect(verifiedChangeAtTurnCap([
      call('1', 'Edit', { file_path: 'a.py' }), done('1'),
      call('2', 'Bash', { command: 'python -m pytest tests/test_a.py -q' }), done('2'),
      capped,
    ])).toBe(true);
  });

  it('refuses when the last test after the edit failed, the test predates the edit, or it was not the cap', () => {
    expect(verifiedChangeAtTurnCap([
      call('1', 'Edit', {}), done('1'), call('2', 'Bash', { command: 'pytest' }), done('2', true), capped,
    ])).toBe(false);
    expect(verifiedChangeAtTurnCap([
      call('2', 'Bash', { command: 'pytest' }), done('2'), call('1', 'Edit', {}), done('1'), capped,
    ])).toBe(false);
    expect(verifiedChangeAtTurnCap([
      call('1', 'Edit', {}), done('1'), call('2', 'Bash', { command: 'pytest' }), done('2'),
      { type: 'result', payload: { subtype: 'error_during_execution' } },
    ])).toBe(false);
  });

  it('does not take a command that mentions a runner, a piped run, or failing output as a pass', () => {
    const after = (command: string, output = 'ok') => verifiedChangeAtTurnCap([
      call('1', 'Edit', {}), done('1'), call('2', 'Bash', { command }),
      { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: '2', content: output, is_error: false }] } } },
      capped,
    ]);
    expect(after('pip install pytest')).toBe(false);
    expect(after('python -m pytest tests/t.py 2>&1 | tail -20')).toBe(false);
    expect(after('pytest tests/t.py', '=== 1 failed, 3 passed in 0.2s ===')).toBe(false);
    expect(after('cd /workspace && python -m pytest tests/t.py -q', '4 passed in 0.3s')).toBe(true);
    expect(after('pytest -x || true', '4 passed')).toBe(true);
  });
});

describe('isVerifyingCommand', () => {
  it('counts a command that runs tests, a build, or a script, not one that only mentions tests', () => {
    for (const c of [
      'python -m pytest tests/test_x.py -q', '/opt/env/bin/python -m pytest -k content', 'cd /workspace && pytest',
      'timeout 60 python -m pytest x', 'python -c "import requests; print(1)"', 'python3 repro.py', 'npm test',
      'npx tsc --noEmit', 'cargo test', 'go test ./...', 'make test', 'PYTHONPATH=src pytest tests',
    ]) expect(isVerifyingCommand(c), c).toBe(true);
    for (const c of [
      'grep -rn "Content-Length" test_requests.py; ls test*.py', 'ls tests', 'cat tests/test_x.py',
      'sed -n 1,40p test_utils.py', 'find . -name "test_*"', 'git diff', 'pip install pytest', 'which pytest',
    ]) expect(isVerifyingCommand(c), c).toBe(false);
  });

  it('counts an inline script fed to any interpreter, the same check as python -c (missed live on Terminal-Bench)', () => {
    for (const c of [
      "cd /app && python3 << 'EOF'\nimport pandas as pd\nprint(pd.read_csv('x.csv').shape)\nEOF",
      'cd /app && R --vanilla --slave -e "source(\'ars.R\'); test()"', "R --vanilla --quiet << 'EOF'\nsource('ars.R')\nEOF",
      'Rscript test.R', 'node -e "require(\'./x\')"', 'node --test', 'ruby spec.rb', 'julia run.jl', 'perl -e "print 1"',
      'bash run_tests.sh', './build/app --selftest', 'dotnet test', 'mvn -q test', './gradlew test', 'ctest --output-on-failure',
    ]) expect(isVerifyingCommand(c), c).toBe(true);
    for (const c of [
      "cat > /tmp/verify.py << 'EOF'\nprint(1)\nEOF", 'apt-get install -y r-base', 'which R', 'pip install pgmpy',
      'sleep 30 && which R', 'ps aux | grep apt', 'ls -la /app/*.txt', 'echo done',
    ]) expect(isVerifyingCommand(c), c).toBe(false);
  });
});

describe('where an observation’s output lives', () => {
  it('records the event that carries the output, distinct from the one that carries the call', () => {
    const events = [
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } } },
      { type: 'system', payload: {} },
      { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a b c' }] } } },
    ];
    const [observation] = observationsFromEvents(events, 'n');
    expect(observation.execution.sequence).toBe(0);
    expect(observation.execution.resultSequence).toBe(2);
  });

  it('has no result sequence for a call that never returned', () => {
    const [observation] = observationsFromEvents([
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'sleep 999' } }] } } },
    ], 'n');
    expect(observation.execution.resultSequence).toBeUndefined();
  });
});
