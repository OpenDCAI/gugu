import { describe, expect, it } from 'vitest';
import { parseTmeetPrompt, tmeetCliRecipe } from './tmeet-cli';

describe('official Tencent Meeting CLI', () => {
  it('uses an isolated config and credential directory and never opens a browser on the agent host', () => {
    expect(tmeetCliRecipe.env('/tmp/gugu-tmeet')).toEqual({ HOME: '/tmp/gugu-tmeet', TMEET_CLI_CONFIG_DIR: '/tmp/gugu-tmeet/config', TMEET_CLI_DATA_DIR: '/tmp/gugu-tmeet/data' });
    expect(tmeetCliRecipe.loginArgs('/tmp/work')).toEqual(['auth', 'login', '--no-browser']);
  });
  it('only accepts the real authorization prompt, including a link without a separate device code', () => {
    expect(parseTmeetPrompt('Please open docs https://meeting.tencent.com')).toBeNull();
    expect(parseTmeetPrompt('authorize url: https://meeting.tencent.com/authorize?code=test\nwaiting for authorization...'))
      .toEqual({ kind: 'device-link', url: 'https://meeting.tencent.com/authorize?code=test', code: '' });
    expect(() => parseTmeetPrompt('authorize url: https://meeting.tencent.com.evil.test/login')).toThrow('Unexpected');
  });
  it('does not mistake cached credentials or a failed user lookup for a verified account', () => {
    expect(tmeetCliRecipe.parseStatus('Not logged in.')).toBe(false);
    expect(() => tmeetCliRecipe.parseStatus('Logged in\nRefreshToken: valid')).toThrow('could not verify');
    expect(tmeetCliRecipe.parseStatus('Logged in\nUserName: Test user\nRefreshToken: valid (expires later)')).toBe(true);
  });
});
