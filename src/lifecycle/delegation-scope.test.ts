import { describe, it, expect } from 'vitest';
import { pathInScope, writeScopeViolations, PROTECTED_PATHS } from './delegation-scope.js';

describe('pathInScope', () => {
  it('matches an exact path, a directory, and globs', () => {
    expect(pathInScope('src/cart.ts', ['src/cart.ts'])).toBe(true);
    expect(pathInScope('src/cart/index.ts', ['src/cart/'])).toBe(true);
    expect(pathInScope('src/cart/deep/x.ts', ['src/cart/**'])).toBe(true);
    expect(pathInScope('src/cart/x.ts', ['src/cart/*.ts'])).toBe(true);
    expect(pathInScope('src/cart/deep/x.ts', ['src/cart/*.ts'])).toBe(false); // * does not cross a slash
    expect(pathInScope('src/other.ts', ['src/cart/**'])).toBe(false);
  });

  it('is not fooled by a shared prefix', () => {
    expect(pathInScope('src/cartography.ts', ['src/cart'])).toBe(false);
    expect(pathInScope('src/cart.ts.bak', ['src/cart.ts'])).toBe(false);
  });

  it('normalises ./ and leading slashes, and refuses a path that climbs out', () => {
    expect(pathInScope('./src/cart.ts', ['src/cart.ts'])).toBe(true);
    expect(pathInScope('src/../secrets.env', ['src/**'])).toBe(false);
    expect(pathInScope('../outside.ts', ['**'])).toBe(false);
  });

  it('treats **/name as that name at any depth, including the root', () => {
    expect(pathInScope('package.json', ['**/package.json'])).toBe(true);
    expect(pathInScope('packages/a/package.json', ['**/package.json'])).toBe(true);
    expect(pathInScope('packages/a/package.json.bak', ['**/package.json'])).toBe(false);
  });

  it('does not treat regex characters in a path as regex', () => {
    expect(pathInScope('src/a+b.ts', ['src/a+b.ts'])).toBe(true);
    expect(pathInScope('src/aab.ts', ['src/a+b.ts'])).toBe(false);
  });
});

describe('writeScopeViolations', () => {
  it('with no granted scope, only protected paths are violations', () => {
    expect(writeScopeViolations(['src/anything.ts', 'docs/x.md'], undefined)).toEqual([]);
    const violations = writeScopeViolations(['src/a.ts', '.github/workflows/ci.yml', 'package.json', 'pnpm-lock.yaml', '.env.local'], undefined);
    expect(violations.map((v) => v.path).sort()).toEqual(['.env.local', '.github/workflows/ci.yml', 'package.json', 'pnpm-lock.yaml']);
    expect(violations.every((v) => v.reason === 'protected')).toBe(true);
  });

  it('protects manifests and lockfiles at any depth, and .git', () => {
    const paths = ['packages/a/package.json', 'a/b/yarn.lock', 'c/package-lock.json', '.git/config'];
    expect(writeScopeViolations(paths, undefined).map((v) => v.path).sort()).toEqual([...paths].sort());
  });

  it('with a scope, anything outside it is a violation', () => {
    const violations = writeScopeViolations(['src/cart/a.ts', 'src/auth/b.ts'], ['src/cart/**']);
    expect(violations).toEqual([{ path: 'src/auth/b.ts', reason: 'outside_scope' }]);
  });

  it('a protected path needs an explicit grant — a broad scope is not one', () => {
    expect(writeScopeViolations(['package.json'], ['**'])).toEqual([{ path: 'package.json', reason: 'protected' }]);
    expect(writeScopeViolations(['package.json'], ['package.json'])).toEqual([]);
    expect(writeScopeViolations(['packages/a/package.json'], ['**/package.json'])).toEqual([]);
    expect(writeScopeViolations(['.github/workflows/ci.yml'], ['.github/workflows/ci.yml'])).toEqual([]);
  });

  it('reports each path once, in a stable order', () => {
    const violations = writeScopeViolations(['b.ts', 'a.ts', 'b.ts'], ['nothing/**']);
    expect(violations.map((v) => v.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('exposes the protected set so it can be documented and changed in one place', () => {
    expect(PROTECTED_PATHS).toContain('.github/**');
    expect(PROTECTED_PATHS).toContain('**/package.json');
  });
});
