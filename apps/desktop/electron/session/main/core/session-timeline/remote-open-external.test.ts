import { describe, expect, it, vi } from 'vitest';
import {
  answerOpenExternal,
  classifyOpenTarget,
  openExternalFromMachine,
  pickSessionForCwd,
  type OpenExternalDeps,
} from './remote-open-external';
import { RemotePaneError } from './remote-pane';

function deps(overrides: Partial<OpenExternalDeps> = {}) {
  const open = vi.fn(async () => ({ opened: true as const }));
  const base: OpenExternalDeps = {
    route: { open, watching: () => false },
    sessionFromPtyId: () => null,
    sessionRoots: async () => [
      { sessionId: 'recent', root: '/srv/app' },
      { sessionId: 'older', root: '/srv/app' },
      { sessionId: 'deep', root: '/srv/app/web' },
    ],
    isFile: async () => true,
    ...overrides,
  };
  return { deps: base, open };
}

describe('open a web page from a program on this machine', () => {
  it('takes http(s) URLs and files; refuses other schemes', () => {
    expect(classifyOpenTarget('https://github.com/login/device', '/')).toEqual({ url: 'https://github.com/login/device' });
    expect(classifyOpenTarget('report.html', '/srv/app/')).toEqual({ path: '/srv/app/report.html' });
    expect(classifyOpenTarget('./out/a.html', '/srv/app')).toEqual({ path: '/srv/app/out/a.html' });
    expect(classifyOpenTarget('file:///srv/app/%E6%8A%A5%E5%91%8A.html', '/')).toEqual({ path: '/srv/app/报告.html' });
    expect(() => classifyOpenTarget('mailto:a@b.c', '/')).toThrow(/only web pages/);
    expect(() => classifyOpenTarget('  ', '/')).toThrow();
  });

  it('finds the session: deepest folder wins, then one someone is watching, then the most recent', () => {
    const roots = [
      { sessionId: 'recent', root: '/srv/app' },
      { sessionId: 'watched', root: '/srv/app/' },
      { sessionId: 'deep', root: '/srv/app/web' },
    ];
    expect(pickSessionForCwd('/srv/app/web/src', roots, () => false)).toBe('deep');
    expect(pickSessionForCwd('/srv/app/api', roots, () => false)).toBe('recent');
    expect(pickSessionForCwd('/srv/app/api', roots, (id) => id === 'watched')).toBe('watched');
    expect(pickSessionForCwd('/home/alice', roots, () => false)).toBeNull();
  });

  it('prefers the session named by GUGU_PTY_ID over the folder', async () => {
    const { deps: d, open } = deps({ sessionFromPtyId: () => 'from-pty' });
    await openExternalFromMachine({ target: 'https://x.test/', cwd: '/srv/app', ptyId: 'claude:from-pty' }, d);
    expect(open).toHaveBeenCalledWith('from-pty', { kind: 'external', url: 'https://x.test/' }, 'pinned');
  });

  it('hands an unknown session to the route as "" (it falls back to whoever is looking at the machine)', async () => {
    const { deps: d, open } = deps();
    await openExternalFromMachine({ target: 'https://x.test/', cwd: '/home/alice', ptyId: '' }, d);
    expect(open).toHaveBeenCalledWith('', { kind: 'external', url: 'https://x.test/' }, 'pinned');
  });

  it('renders a file inside the session folder in the desktop browser tab; refuses anything outside', async () => {
    const { deps: d, open } = deps();
    await openExternalFromMachine({ target: 'dist/index.html', cwd: '/srv/app/web', ptyId: '' }, d);
    expect(open).toHaveBeenCalledWith('deep', { kind: 'browser', url: 'file:///srv/app/web/dist/index.html' }, 'pinned');
    await expect(openExternalFromMachine({ target: '/etc/passwd', cwd: '/srv/app', ptyId: '' }, d)).rejects.toMatchObject({
      code: 'outside_workspace',
    });
    const missing = deps({ isFile: async () => false }).deps;
    await expect(openExternalFromMachine({ target: 'nope.html', cwd: '/srv/app', ptyId: '' }, missing)).rejects.toMatchObject({
      code: 'not_a_file',
    });
    await expect(openExternalFromMachine({ target: 'a.html', cwd: '/home/x', ptyId: '' }, d)).rejects.toMatchObject({
      code: 'no_session',
    });
  });

  it('answers the socket call in the device-RPC shape, queued included', async () => {
    const queued = deps({
      route: { open: async () => ({ queued: true as const }), watching: () => false },
    }).deps;
    await expect(answerOpenExternal({ target: 'https://x.test/', cwd: '/srv/app' }, queued)).resolves.toEqual({
      result: { outcome: 'queued', note: expect.stringContaining('next time') },
    });
    const failing = deps({
      route: {
        open: async () => {
          throw new RemotePaneError('no_viewer');
        },
        watching: () => false,
      },
    }).deps;
    await expect(answerOpenExternal({ target: 'https://x.test/' }, failing)).resolves.toMatchObject({ error: { code: 'no_viewer' } });
    await expect(answerOpenExternal({ target: 'ftp://x' }, failing)).resolves.toMatchObject({ error: { code: 'unsupported' } });
  });
});
