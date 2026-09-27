import { describe, it, expect } from 'vitest';
import {
  EMPTY, open, close, setPinned, setCollapsed, resize, dropTransients, reset,
  serialize, restore, visible, closeDeepDive, MIN_WIDTH, MAX_WIDTH, MAX_OPEN,
} from './surfaces.js';

describe('adaptive surfaces', () => {
  it('opens and closes a transient surface', () => {
    const opened = open(EMPTY, 'artifact', 'src/a.ts');
    expect(opened.side).toHaveLength(1);
    expect(opened.side[0]).toMatchObject({ kind: 'artifact', contextId: 'src/a.ts', persistence: 'transient' });
    expect(close(opened, opened.side[0].id)).toEqual(EMPTY);
  });

  it('re-focuses a surface that is already open instead of duplicating it', () => {
    let layout = open(EMPTY, 'artifact', 'a');
    layout = open(layout, 'plan', 'case-1');
    layout = open(layout, 'artifact', 'a');
    expect(layout.side.map((s) => s.id)).toEqual(['plan:case-1', 'artifact:a']);
  });

  it('never shows more than MAX_OPEN side surfaces; the oldest transient goes', () => {
    let layout = open(EMPTY, 'artifact', 'a');
    layout = open(layout, 'artifact', 'b');
    layout = open(layout, 'artifact', 'c');
    expect(layout.side.map((s) => s.contextId)).toEqual(['b', 'c']);
    expect(layout.side.length).toBe(MAX_OPEN);
  });

  it('keeps a pinned surface through transient cleanup and through eviction', () => {
    let layout = open(EMPTY, 'plan', 'case-1', { pinned: true });
    layout = open(layout, 'artifact', 'a');
    layout = open(layout, 'artifact', 'b');
    expect(layout.side.map((s) => s.id)).toEqual(['plan:case-1', 'artifact:b']);
    expect(dropTransients(layout).side.map((s) => s.id)).toEqual(['plan:case-1']);
  });

  it('collapses rather than discards a pinned surface when everything visible is pinned', () => {
    let layout = open(EMPTY, 'plan', 'x', { pinned: true });
    layout = open(layout, 'memory', null, { pinned: true });
    layout = open(layout, 'artifact', 'a');
    expect(layout.side.find((s) => s.id === 'plan:x')?.collapsed).toBe(true);
    expect(layout.side).toHaveLength(3);
  });

  it('pinning changes the persistence class', () => {
    const layout = open(EMPTY, 'artifact', 'a');
    const pinned = setPinned(layout, 'artifact:a', true);
    expect(pinned.side[0].persistence).toBe('pinned');
    expect(setPinned(pinned, 'artifact:a', false).side[0].persistence).toBe('transient');
  });

  it('a decision pushes transient context aside but keeps pinned work', () => {
    let layout = open(EMPTY, 'plan', 'x', { pinned: true });
    layout = open(layout, 'artifact', 'a');
    layout = open(layout, 'decision', 'd1');
    expect(layout.side.map((s) => s.id)).toEqual(['plan:x', 'decision:d1']);
  });

  it('a deep dive replaces the main area without touching side surfaces', () => {
    const base = open(EMPTY, 'artifact', 'a');
    const deep = open(base, 'deep-dive', 'decision:1', { deepDive: true });
    expect(deep.deepDive?.contextId).toBe('decision:1');
    expect(deep.side).toEqual(base.side);
    expect(closeDeepDive(deep)).toEqual(base);
  });

  it('collapsing and reopening a surface retains its context and width', () => {
    let layout = open(EMPTY, 'artifact', 'a');
    layout = resize(layout, 'artifact:a', 500);
    layout = setCollapsed(layout, 'artifact:a', true);
    layout = setCollapsed(layout, 'artifact:a', false);
    expect(layout.side[0]).toMatchObject({ contextId: 'a', width: 500, collapsed: false });
  });

  it('clamps resize to safe bounds', () => {
    const layout = open(EMPTY, 'artifact', 'a');
    expect(resize(layout, 'artifact:a', 10).side[0].width).toBe(MIN_WIDTH);
    expect(resize(layout, 'artifact:a', 5000).side[0].width).toBe(MAX_WIDTH);
    expect(resize(layout, 'artifact:a', Number.NaN).side[0].width).toBe(MIN_WIDTH);
  });

  it('reset returns to the known baseline', () => {
    expect(reset()).toEqual(EMPTY);
  });

  it('shows one side column on a narrow window, two on a wide one', () => {
    let layout = open(EMPTY, 'artifact', 'a');
    layout = open(layout, 'plan', 'x');
    expect(visible(layout, 900).map((s) => s.id)).toEqual(['plan:x']);
    expect(visible(layout, 1600)).toHaveLength(2);
  });

  it('round-trips pinned surfaces and forgets transient ones', () => {
    let layout = open(EMPTY, 'plan', 'x', { pinned: true });
    layout = resize(layout, 'plan:x', 420);
    layout = open(layout, 'artifact', 'a');
    const restored = restore(serialize(layout));
    expect(restored.side).toEqual([layout.side[0]]);
    expect(restore(serialize(restored))).toEqual(restored);
  });

  it('ignores invalid and stale surfaces instead of crashing', () => {
    expect(restore('not json')).toEqual(EMPTY);
    expect(restore(null)).toEqual(EMPTY);
    expect(restore(JSON.stringify({ version: 2, side: [] }))).toEqual(EMPTY);
    const raw = JSON.stringify({
      version: 1,
      side: [
        { kind: 'bogus', contextId: 'x' },
        { kind: 'plan', contextId: 'gone' },
        { kind: 'artifact', contextId: 'kept', width: 99999 },
        { kind: 'artifact', contextId: 'kept' },
        'garbage',
      ],
    });
    const restored = restore(raw, (surface) => surface.contextId !== 'gone');
    expect(restored.side.map((s) => s.id)).toEqual(['artifact:kept']);
    expect(restored.side[0].width).toBe(MAX_WIDTH);
  });
});
