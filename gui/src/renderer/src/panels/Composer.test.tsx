// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Composer, compose } from './Composer.js';
import { act } from 'react';
import { render, typeInto, key, flush } from '../testing/render.js';

const base = {
  variant: 'docked' as const,
  hasCase: true,
  liveRun: null,
  suggestions: [],
  mandates: [],
  mandateId: null,
  onSelectMandate: () => {},
  blockedReason: null,
  offline: false,
  draftScope: 'test',
};

function setup(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onQuestion = vi.fn(async () => {});
  const onWork = vi.fn(async () => {});
  const onRedirect = vi.fn(async () => {});
  const view = render(<Composer {...base} onQuestion={onQuestion} onWork={onWork} onRedirect={onRedirect} {...overrides} />);
  const box = view.container.querySelector('textarea')!;
  return { ...view, box, onQuestion, onWork, onRedirect };
}

afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

describe('composer', () => {
  it('a question never starts a run', async () => {
    const { box, onQuestion, onWork, unmount } = setup();
    typeInto(box, 'why did it delegate?');
    key(box, 'Enter');
    await flush();
    expect(onQuestion).toHaveBeenCalledWith('why did it delegate?');
    expect(onWork).not.toHaveBeenCalled();
    unmount();
  });

  it('shift+enter is a new line, enter sends work', async () => {
    const { box, onWork, unmount } = setup();
    typeInto(box, 'Add a cache');
    key(box, 'Enter', { shiftKey: true });
    await flush();
    expect(onWork).not.toHaveBeenCalled();
    key(box, 'Enter');
    await flush();
    expect(onWork).toHaveBeenCalledWith('Add a cache', []);
    expect(box.value).toBe('');
    unmount();
  });

  it('will not start work where it is not permitted, and says why', async () => {
    const { container, box, onWork, unmount } = setup({ blockedReason: 'Open CherryOnTop from that repository.' });
    typeInto(box, 'Add a cache');
    key(box, 'Enter');
    await flush();
    expect(onWork).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Open CherryOnTop from that repository.');
    unmount();
  });

  it('offers redirecting a live run, and redirects only when chosen', async () => {
    const { container, box, onWork, onRedirect, unmount } = setup({ liveRun: { id: 'r1', title: 'Auth' } });
    typeInto(box, 'Actually keep the old token format');
    const redirect = [...container.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Redirect current run')!;
    expect(redirect.getAttribute('aria-checked')).toBe('true');
    const add = [...container.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Add as new work') as HTMLButtonElement;
    act(() => add.click());
    key(box, 'Enter');
    await flush();
    expect(onRedirect).not.toHaveBeenCalled();
    expect(onWork).toHaveBeenCalled();
    unmount();
  });

  it('attaches offered context without touching the draft', async () => {
    const { container, box, onWork, unmount } = setup({ suggestions: [{ kind: 'file', id: '/workspace/a.ts', label: 'a.ts' }] });
    typeInto(box, 'Fix this');
    (container.querySelector('.chip[data-attached="false"]') as HTMLButtonElement).click();
    await flush();
    expect(box.value).toBe('Fix this');
    key(box, 'Enter');
    await flush();
    expect(onWork).toHaveBeenCalledWith('Fix this', [{ kind: 'file', id: '/workspace/a.ts', label: 'a.ts' }]);
    unmount();
  });

  it('keeps an unsent draft across a remount', () => {
    const first = setup();
    typeInto(first.box, 'half a thought');
    first.unmount();
    const second = setup();
    expect(second.box.value).toBe('half a thought');
    second.unmount();
  });

  it('stops a live run only on a second press, and only when nothing is typed', async () => {
    const onStop = vi.fn(async () => {});
    const { container, box, unmount } = setup({ liveRun: { id: 'r1', title: 'Auth' }, onStop });
    const stop = () => container.querySelector('.send.stop') as HTMLButtonElement | null;
    act(() => stop()!.click());
    expect(onStop).not.toHaveBeenCalled();
    expect(stop()!.getAttribute('aria-label')).toMatch(/again/);
    act(() => stop()!.click());
    await flush();
    expect(onStop).toHaveBeenCalledTimes(1);
    typeInto(box, 'more work');
    expect(stop()).toBeNull();
    unmount();
  });

  it('takes text from “Edit request” without losing focus', () => {
    const { box, unmount } = setup();
    act(() => compose('Refactor the auth flow'));
    expect(box.value).toBe('Refactor the auth flow');
    unmount();
  });

  it('says before sending when a request needs GitHub the mandate lacks, and offers one that has it', () => {
    const onSelectMandate = vi.fn();
    const auth = (tools: string[]) => ({ tools, spawn_children: false, max_child_count: 0, budget_usd: 5 });
    const mandates = [
      { id: 'focused', name: 'Focused change', description: '', authority: auth(['Bash']), constraints: [], builtin: true },
      { id: 'ship', name: 'Ship', description: '', authority: auth(['Bash', 'GitHub']), constraints: [], builtin: true },
    ];
    const { container, box, unmount } = setup({ mandates, mandateId: 'focused', onSelectMandate });
    typeInto(box, 'close PR #4 and raise a PR to the feature branch');
    expect(container.textContent).toContain('needs GitHub access');
    const use = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use Ship for this') as HTMLButtonElement;
    act(() => use.click());
    expect(onSelectMandate).toHaveBeenCalledWith('ship');
    unmount();
  });
});
