import { describe, it, expect } from 'vitest';
import { isToolAllowed, isRestricted, allowedTools, isReadOnly } from './enforce-tools.js';

const grant = (tools: string[]) => ({ tools });

describe('tool enforcement', () => {
  it('treats an empty list as unrestricted, so historical nodes keep working', () => {
    expect(isRestricted(grant([]))).toBe(false);
    expect(isToolAllowed(grant([]), 'Bash')).toBe(true);
    expect(allowedTools(grant([]))).toBeNull();
  });

  it('allows only what was granted', () => {
    const g = grant(['Read', 'Grep']);
    expect(isToolAllowed(g, 'Read')).toBe(true);
    expect(isToolAllowed(g, 'Write')).toBe(false);
    expect(isToolAllowed(g, 'Bash')).toBe(false);
  });

  it('grants a whole MCP server by name', () => {
    const g = grant(['mcp__github']);
    expect(isToolAllowed(g, 'mcp__github__create_issue')).toBe(true);
    expect(isToolAllowed(g, 'mcp__gitlab__create_issue')).toBe(false);
  });

  it('does not let a prefix match a different tool', () => {
    expect(isToolAllowed(grant(['Read']), 'ReadWrite')).toBe(false);
  });

  it('knows a read-only grant from one that can change the repository', () => {
    expect(isReadOnly(grant(['Read', 'Grep', 'Glob']))).toBe(true);
    expect(isReadOnly(grant(['Read', 'Edit']))).toBe(false);
    expect(isReadOnly(grant(['Bash']))).toBe(false);
    // Unrestricted is not read-only.
    expect(isReadOnly(grant([]))).toBe(false);
  });
});
