import { describe, expect, it, vi } from 'vitest';
import { RemotePageSession } from './remote-page-session';

function setup(overrides: Partial<ConstructorParameters<typeof RemotePageSession>[0]> = {}) {
  const deps = {
    root: vi.fn(async () => '/root/proj'),
    register: vi.fn(async () => 'p1'),
    release: vi.fn(),
    ...overrides,
  };
  return { deps, session: new RemotePageSession(deps) };
}

describe('RemotePageSession (浏览器页签里那台机器上的网页)', () => {
  it('registers once per tab and maps file: urls in the session folder to its preview origin', async () => {
    const { deps, session } = setup();
    await expect(session.resolve('file:///root/proj/site/index.html')).resolves.toEqual({
      url: 'gugu-preview://p1/site/index.html',
    });
    await expect(session.resolve('file:///root/proj/other.html#x')).resolves.toEqual({
      url: 'gugu-preview://p1/other.html#x',
    });
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.register).toHaveBeenCalledWith('/root/proj');
  });

  it('concurrent first loads share one registration', async () => {
    const { deps, session } = setup();
    await Promise.all([session.resolve('file:///root/proj/a.html'), session.resolve('file:///root/proj/b.html')]);
    expect(deps.register).toHaveBeenCalledTimes(1);
  });

  it('shows the file: address, not the internal one, in the address bar', async () => {
    const { session } = setup();
    expect(session.present('gugu-preview://p1/a.html')).toBeNull(); // 还没登记:原样
    await session.resolve('file:///root/proj/a.html');
    expect(session.present('gugu-preview://p1/docs/b.html?q=1')).toBe('file:///root/proj/docs/b.html?q=1');
    expect(session.present('https://example.com/')).toBeNull();
  });

  it('refuses pages outside the session folder in words the tab can show', async () => {
    const { session } = setup();
    await expect(session.resolve('file:///root/.ssh/id_rsa')).resolves.toEqual({ error: 'outside' });
    await expect(session.resolve('file:///etc/passwd')).resolves.toEqual({ error: 'outside' });
  });

  it('says unavailable when the folder cannot be read or the preview cannot be registered, and retries next time', async () => {
    const root = vi.fn().mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'timeout' })).mockResolvedValue('/root/proj');
    const { deps, session } = setup({ root });
    await expect(session.resolve('file:///root/proj/a.html')).resolves.toEqual({ error: 'unavailable' });
    await expect(session.resolve('file:///root/proj/a.html')).resolves.toEqual({ url: 'gugu-preview://p1/a.html' });
    expect(deps.register).toHaveBeenCalledTimes(1);

    const { session: noRegistration } = setup({ register: vi.fn(async () => null) });
    await expect(noRegistration.resolve('file:///root/proj/a.html')).resolves.toEqual({ error: 'unavailable' });
  });

  it('releases the registration when the tab closes (the files stop being reachable)', async () => {
    const { deps, session } = setup();
    await session.resolve('file:///root/proj/a.html');
    session.dispose();
    expect(deps.release).toHaveBeenCalledWith('p1');
    expect(session.present('gugu-preview://p1/a.html')).toBeNull();
  });

  it('releases a registration that lands after the tab already closed', async () => {
    let finish: (id: string) => void = () => undefined;
    const register = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const { deps, session } = setup({ register });
    const pending = session.resolve('file:///root/proj/a.html');
    await Promise.resolve();
    await Promise.resolve();
    session.dispose();
    finish('late');
    await expect(pending).resolves.toEqual({ error: 'unavailable' });
    expect(deps.release).toHaveBeenCalledWith('late');
  });
});
