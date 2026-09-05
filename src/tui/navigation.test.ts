import { describe, it, expect } from 'vitest';
import { pushScreen, popScreen, breadcrumb, type Screen } from './navigation.js';

describe('navigation stack', () => {
  it('pushes a new screen onto the stack', () => {
    const stack: Screen[] = [{ name: 'home' }];
    expect(pushScreen(stack, { name: 'tree' })).toEqual([{ name: 'home' }, { name: 'tree' }]);
  });

  it('pops back to the previous screen', () => {
    const stack: Screen[] = [{ name: 'home' }, { name: 'tree' }, { name: 'node', nodeId: 'n1' }];
    expect(popScreen(stack)).toEqual([{ name: 'home' }, { name: 'tree' }]);
  });

  it('never pops the last remaining screen (Home is the floor)', () => {
    const stack: Screen[] = [{ name: 'home' }];
    expect(popScreen(stack)).toEqual([{ name: 'home' }]);
  });

  it('renders a readable breadcrumb with shortened node ids', () => {
    expect(breadcrumb([{ name: 'home' }, { name: 'tree' }, { name: 'output', nodeId: 'abcdefgh-1234' }]))
      .toBe('home › tree › output:abcdefgh');
  });
});
