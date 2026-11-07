import { afterEach, describe, expect, it, vi } from 'vitest';

const execSync = vi.hoisted(() => vi.fn(() => '/private/tmp/com.apple.launchd.fixture/Listeners\n'));
vi.mock('@gugu/core/local/childProcess', () => ({ execSync }));

describe('detectSshAuthSock', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('asks launchd once per process: later spawns reuse the answer instead of blocking on launchctl again', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { detectSshAuthSock } = await import('./shellEnv');
      expect(detectSshAuthSock()).toBe('/private/tmp/com.apple.launchd.fixture/Listeners');
      expect(detectSshAuthSock()).toBe('/private/tmp/com.apple.launchd.fixture/Listeners');
      expect(execSync).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
