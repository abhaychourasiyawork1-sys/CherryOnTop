// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { CommandPalette } from './CommandPalette.js';
import { render, typeInto, key } from '../testing/render.js';
import type { SearchItem } from '../lib/search.js';

const items: SearchItem[] = [
  { id: 'a', kind: 'action', title: 'Reset the layout' },
  { id: 'w', kind: 'workspace', title: 'auth-service', workspaceKey: '/host/auth-service' },
  { id: 'r', kind: 'run', title: 'Authentication refactor', workspaceKey: '/host/auth-service' },
];

afterEach(() => { document.body.innerHTML = ''; });

describe('command palette', () => {
  it('renders nothing while closed', () => {
    const view = render(<CommandPalette open={false} onClose={() => {}} items={items} onChoose={() => {}} />);
    expect(view.container.innerHTML).toBe('');
    view.unmount();
  });

  it('filters, moves with the arrows and chooses with Enter, keeping context', () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    const view = render(<CommandPalette open onClose={onClose} items={items} onChoose={onChoose} />);
    const input = view.container.querySelector('input')!;
    typeInto(input, 'auth');
    act(() => { /* deferred query settles */ });
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(onClose).toHaveBeenCalled();
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'r', workspaceKey: '/host/auth-service' }));
    view.unmount();
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    const view = render(<CommandPalette open onClose={onClose} items={items} onChoose={() => {}} />);
    key(view.container.querySelector('input')!, 'Escape');
    expect(onClose).toHaveBeenCalled();
    view.unmount();
  });
});
