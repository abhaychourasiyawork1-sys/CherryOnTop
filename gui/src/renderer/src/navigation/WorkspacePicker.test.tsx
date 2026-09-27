// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { WorkspacePicker } from './WorkspacePicker.js';
import { render, typeInto, key, flush } from '../testing/render.js';
import type { Workspace } from '../lib/workspaces.js';

const ws = (key: string, name: string): Workspace =>
  ({ key, name, cases: [], lastActivity: '', running: 0, needsYou: 0, organized: false });

describe('workspace picker', () => {
  it('chooses a known Workspace', () => {
    const onSelect = vi.fn();
    const view = render(<WorkspacePicker workspaces={[ws('/host/a', 'a'), ws('/host/b', 'b')]} selected={null} status="ready" onSelect={onSelect} onOpenFolder={async () => null} />);
    act(() => (view.container.querySelector('.ws-picker-trigger') as HTMLButtonElement).click());
    act(() => ([...view.container.querySelectorAll('.ws-picker-option')][1] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith('/host/b');
    view.unmount();
  });

  it('checks a typed folder without submitting the composer it sits in', async () => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    const onOpenFolder = vi.fn(async () => 'is not a git repository');
    const view = render(
      <form onSubmit={(e) => submit(e.nativeEvent)}>
        <WorkspacePicker workspaces={[]} selected={null} status="unusable" onSelect={() => {}} onOpenFolder={onOpenFolder} />
      </form>,
    );
    act(() => (view.container.querySelector('.ws-picker-trigger') as HTMLButtonElement).click());
    act(() => (view.container.querySelector('.ws-picker-open') as HTMLButtonElement).click());
    const input = view.container.querySelector('.ws-picker-path-form input') as HTMLInputElement;
    typeInto(input, '/home/me/notes');
    key(input, 'Enter');
    await flush();
    expect(onOpenFolder).toHaveBeenCalledWith('/home/me/notes');
    expect(submit).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('is not a git repository');
    view.unmount();
  });
});
