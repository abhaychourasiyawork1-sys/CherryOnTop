import { describe, it, expect } from 'vitest';
import { activityOf, describeActivity } from './transcript.js';
import type { RenderedLine } from '../../../../../src/tui/stream-renderer.js';

const line = (kind: string, content: string): RenderedLine =>
  ({ key: `${kind}-${content}`, kind, content } as RenderedLine);

describe('what an agent did, as counts', () => {
  it('groups tool calls by what they do to the repository', () => {
    const activity = activityOf([
      line('tool', 'Read src/a.ts'), line('tool', 'Read src/b.ts'),
      line('tool', 'Grep for TODO'), line('tool', 'Edit src/a.ts'),
      line('tool', 'Bash npm test'),
    ]);
    expect(activity).toMatchObject({ read: 3, edited: 1, ran: 1, other: 0, total: 5 });
  });

  it('does not count speech or thinking as activity', () => {
    const activity = activityOf([
      line('text', 'I found three issues'),
      line('thinking', 'let me consider'),
      line('summary', 'session cost: $0.41'),
    ]);
    expect(activity.total).toBe(0);
  });

  it('counts a diff as an edit, since that is what produced it', () => {
    expect(activityOf([line('diff', 'src/a.ts')]).edited).toBe(1);
  });

  it('reads as a sentence, not a data dump', () => {
    expect(describeActivity({ read: 12, edited: 3, ran: 1, other: 0, total: 16 }))
      .toBe('12 read · 3 edited · 1 command');
  });

  it('pluralises commands, because one command is not "1 commands"', () => {
    expect(describeActivity({ read: 0, edited: 0, ran: 2, other: 0, total: 2 })).toBe('2 commands');
  });

  it('says nothing at all when there was no activity', () => {
    expect(describeActivity({ read: 0, edited: 0, ran: 0, other: 0, total: 0 })).toBe('');
  });
});
