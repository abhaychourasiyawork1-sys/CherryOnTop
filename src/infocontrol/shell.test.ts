import { describe, it, expect } from 'vitest';
import { classifyShell } from './shell.js';

describe('classifyShell', () => {
  it.each([
    ['ls -la src', 'navigate'],
    ['grep -rn "foo" src | head -20', 'navigate'],
    ['cd /app && git status && git diff', 'navigate'],
    ["sed -n '10,40p' a.py", 'navigate'],
    ['find . -name "*.py" -type f', 'navigate'],
    ['pytest tests/test_a.py -x', 'exec'],
    ['python -c "print(1)"', 'exec'],
    ['echo hi > out.txt', 'exec'],
    ["sed -i 's/a/b/' f.py", 'exec'],
    ['find . -name "*.pyc" -delete', 'exec'],
    ['git commit -am x', 'exec'],
    ['FOO=1 ./run.sh', 'exec'],
    ['', 'exec'],
  ])('%s → %s', (command, kind) => {
    expect(classifyShell(command).kind).toBe(kind);
  });

  it('does not count stderr merging or /dev/null as a write', () => {
    expect(classifyShell('ls missing 2>&1').kind).toBe('navigate');
    expect(classifyShell('grep x f 2>/dev/null').kind).toBe('navigate');
  });

  it('ignores separators and redirects inside quotes', () => {
    expect(classifyShell('grep "a > b; rm -rf /" file').kind).toBe('navigate');
  });

  it('marks agent-bounded output as ranged', () => {
    expect(classifyShell('cat big.log | tail -50').ranged).toBe(true);
    expect(classifyShell("sed -n '1,20p' f").ranged).toBe(true);
    expect(classifyShell('cat big.log').ranged).toBe(false);
  });

  it('treats an unknown program as execution (the safe direction)', () => {
    expect(classifyShell('frobnicate --all').kind).toBe('exec');
  });
});
