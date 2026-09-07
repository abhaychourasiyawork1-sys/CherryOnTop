import { describe, it, expect } from 'vitest';
import { missingRouters, outOfDateMessage, REQUIRED_ROUTERS } from './compat.js';

describe('detecting a daemon older than the window', () => {
  it('is happy when the daemon serves everything the window needs', () => {
    expect(missingRouters([...REQUIRED_ROUTERS])).toEqual([]);
  });

  it('tolerates a daemon that serves more than the window needs', () => {
    expect(missingRouters([...REQUIRED_ROUTERS, 'somethingNew'])).toEqual([]);
  });

  it('names exactly what is missing, rather than failing call by call', () => {
    // The real case: a daemon built before the case and mandate routers existed.
    const old = REQUIRED_ROUTERS.filter((r) => r !== 'case' && r !== 'mandate');
    expect(missingRouters([...old])).toEqual(['mandate', 'case']);
  });

  it('treats a daemon too old to report its routers as too old', () => {
    expect(missingRouters(undefined)).toEqual([...REQUIRED_ROUTERS]);
  });

  it('tells the user what to actually do about it', () => {
    const message = outOfDateMessage(['case', 'mandate']);
    expect(message).toContain('npm run build');
    expect(message).toContain('org daemon stop');
    expect(message).toContain('case, mandate');
  });
});
