import { describe, it, expect } from 'vitest';
import { daemonEnv } from './manager.js';

describe('daemonEnv', () => {
  it('forwards every ORG_ setting, including the ones the old allowlist dropped', () => {
    const env = daemonEnv({
      ORG_SYSTEM1: 'off', ORG_LAYA_URL: 'http://gpu:8000', ORG_TASK_SPEND_CAP_USD: '5', ORG_DB_PATH: '/x.db',
      ANTHROPIC_API_KEY: 'k', PATH: '/usr/bin', HOME: '/home/u', SECRET_TOKEN: 's',
    });
    expect(env).toEqual({
      ORG_SYSTEM1: 'off', ORG_LAYA_URL: 'http://gpu:8000', ORG_TASK_SPEND_CAP_USD: '5', ORG_DB_PATH: '/x.db',
      ANTHROPIC_API_KEY: 'k', PATH: '/usr/bin',
    });
  });
});
