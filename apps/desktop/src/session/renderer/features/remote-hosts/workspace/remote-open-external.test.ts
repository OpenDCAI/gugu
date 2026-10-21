import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('../remote-hosts-store', () => ({ remoteHostsStore: { device: () => null } }));

const { openExternalFromMachine, LOGIN_FORWARD_MS } = await import('./remote-open-external');

function setup(hasBrowserTab = false) {
  const target = {
    deviceId: 'd1',
    sessionId: 'c1',
    hasBrowserTab: () => hasBrowserTab,
    openInBrowserTab: vi.fn(),
  };
  const deps = {
    openSystemBrowser: vi.fn(),
    forward: vi.fn(async (): Promise<'ok' | 'busy' | 'failed'> => 'ok'),
    release: vi.fn(),
    tell: vi.fn(),
    deviceLabel: () => 'box',
  };
  return { target, deps };
}

describe('a program on that machine opens a web page (VS Code remote $BROWSER)', () => {
  it("opens the machine's own localhost in the session browser tab (it forwards the port)", () => {
    const { target, deps } = setup();
    expect(openExternalFromMachine(target, { url: 'http://localhost:5173/', requestId: 'r', browser: true }, deps)).toEqual({ ok: true });
    expect(target.openInBrowserTab).toHaveBeenCalledWith('http://localhost:5173/');
    expect(deps.openSystemBrowser).not.toHaveBeenCalled();
  });

  it('says plainly that a cloud-only machine has no localhost pages here', () => {
    const { target, deps } = setup();
    expect(openExternalFromMachine(target, { url: 'http://localhost:5173/', requestId: 'r', browser: false }, deps)).toEqual({
      ok: false,
      failure: 'no_browser',
    });
    expect(deps.tell).toHaveBeenCalledWith(expect.stringContaining('remotePorts.tunnelLoopback'));
  });

  it('opens other pages in the system browser, or in the session browser tab when one is open', () => {
    const none = setup(false);
    openExternalFromMachine(none.target, { url: 'https://github.com/login/device', requestId: 'r', browser: true }, none.deps);
    expect(none.deps.openSystemBrowser).toHaveBeenCalledWith('https://github.com/login/device');
    const withTab = setup(true);
    openExternalFromMachine(withTab.target, { url: 'https://github.com/login/device', requestId: 'r', browser: true }, withTab.deps);
    expect(withTab.target.openInBrowserTab).toHaveBeenCalledWith('https://github.com/login/device');
    expect(withTab.deps.openSystemBrowser).not.toHaveBeenCalled();
  });

  it('forwards the sign-in callback port (same number) and lets go of it after a while', () => {
    const { target, deps } = setup();
    const url = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
    openExternalFromMachine(target, { url, requestId: 'req-9', browser: true }, deps);
    expect(deps.forward).toHaveBeenCalledWith({ deviceId: 'd1', sessionId: 'c1', remotePort: 1455, holder: 'login:req-9' });
    expect(deps.release).toHaveBeenCalledWith({ deviceId: 'd1', remotePort: 1455, holder: 'login:req-9' }, LOGIN_FORWARD_MS);
    expect(deps.openSystemBrowser).toHaveBeenCalledWith(url);
  });

  it('still opens the sign-in page on a cloud-only machine, and says the callback cannot come back', () => {
    const { target, deps } = setup();
    const url = 'https://x.test/?redirect_uri=http://localhost:1455/cb';
    openExternalFromMachine(target, { url, requestId: 'r', browser: false }, deps);
    expect(deps.forward).not.toHaveBeenCalled();
    expect(deps.tell).toHaveBeenCalledWith(expect.stringContaining('remotePorts.tunnelLoginCallback'));
    expect(deps.openSystemBrowser).toHaveBeenCalledWith(url);
  });

  it('never moves a sign-in callback to another local port: busy here = say so', async () => {
    const { target, deps } = setup();
    deps.forward.mockImplementation(async () => 'busy' as const);
    openExternalFromMachine(target, { url: 'https://x.test/?redirect_uri=http://localhost:1455/cb', requestId: 'r', browser: true }, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.tell).toHaveBeenCalledWith(expect.stringContaining('remotePorts.localPortBusy'));
  });
});
