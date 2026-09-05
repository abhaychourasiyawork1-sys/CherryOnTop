import { describe, it, expect } from 'vitest';
import { nonNegativeNumber, resolveRepoPath } from './validation.js';

describe('nonNegativeNumber', () => {
  it('parses a valid non-negative number', () => {
    expect(nonNegativeNumber('budget')('5')).toBe(5);
    expect(nonNegativeNumber('budget')('0')).toBe(0);
  });

  it('rejects a negative number with a labeled message', () => {
    expect(() => nonNegativeNumber('budget')('-1')).toThrow(/budget must be a non-negative number/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => nonNegativeNumber('budget')('abc')).toThrow(/budget must be a non-negative number/);
  });
});

describe('resolveRepoPath', () => {
  it('accepts a real git repository and returns an absolute path', () => {
    expect(resolveRepoPath(process.cwd())).toBe(process.cwd());
  });

  it('defaults to the current directory', () => {
    expect(resolveRepoPath(undefined)).toBe(process.cwd());
    expect(resolveRepoPath('   ')).toBe(process.cwd());
  });

  it('rejects a directory that is not a git repository', () => {
    expect(() => resolveRepoPath('/tmp')).toThrow(/not a git repository/);
  });
});
