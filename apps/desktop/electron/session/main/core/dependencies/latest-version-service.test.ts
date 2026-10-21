import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestVersionService } from './latest-version-service';

afterEach(() => vi.unstubAllGlobals());

function registry(agents: unknown[] = [{ id: 'antigravity-acp', version: '1.1.1' }, { id: 'kimi', version: '2.0.0' }]) {
  const fetcher = vi.fn(async (_url: string) => Response.json({ version: '1.0.0', agents }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('LatestVersionService — ACP 注册表(#6335)', () => {
  it('读注册表那一条的 version;一份 registry.json 供所有家', async () => {
    const fetcher = registry();
    const service = new LatestVersionService();
    const [a, b] = await Promise.all([
      service.fetchLatestVersion({ kind: 'acp-registry', agentId: 'antigravity-acp' }),
      service.fetchLatestVersion({ kind: 'acp-registry', agentId: 'kimi' }),
    ]);
    expect([a, b]).toEqual(['1.1.1', '2.0.0']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
  });

  it('注册表里没有这一家就是「不知道」(null),❌ 不编一个', async () => {
    registry();
    expect(await new LatestVersionService().fetchLatestVersion({ kind: 'acp-registry', agentId: 'nope' })).toBeNull();
  });

  it('检查更新会真的再问一次注册表', async () => {
    const fetcher = registry();
    const service = new LatestVersionService();
    const source = { kind: 'acp-registry' as const, agentId: 'antigravity-acp' };
    await service.fetchLatestVersion(source);
    service.invalidate(source);
    registry([{ id: 'antigravity-acp', version: '1.2.0' }]);
    expect(await service.fetchLatestVersion(source)).toBe('1.2.0');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('取不到索引不缓存失败 —— 网络好了下一次照常答', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const service = new LatestVersionService();
    const source = { kind: 'acp-registry' as const, agentId: 'antigravity-acp' };
    expect(await service.fetchLatestVersion(source)).toBeNull();
    service.invalidate(source);
    registry();
    expect(await service.fetchLatestVersion(source)).toBe('1.1.1');
  });
});

describe('LatestVersionService — 厂商按平台清单(#6335)', () => {
  it('问本机那一格的 version;检查更新会真的再问一次', async () => {
    const fetcher = vi.fn(async (_url: string) => Response.json({ version: '1.2.10', url: 'https://x/y.tar.gz', sha512: 'ab'.repeat(64) }));
    vi.stubGlobal('fetch', fetcher);
    const key = `${process.platform}-${process.arch}`;
    const source = {
      kind: 'vendor-manifest' as const,
      manifest: 'https://updater.example/manifests/{platform}.json',
      platforms: { [key]: 'here', 'linux-x64-musl': 'here_musl' },
    };
    const service = new LatestVersionService();
    expect(await service.fetchLatestVersion(source)).toBe('1.2.10');
    expect(fetcher.mock.calls[0]![0]).toMatch(/^https:\/\/updater\.example\/manifests\/here(_musl)?\.json$/);
    await service.fetchLatestVersion(source);
    expect(fetcher).toHaveBeenCalledTimes(1);
    service.invalidate(source);
    await service.fetchLatestVersion(source);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('本机这一格厂商没发 → null(不报更新),❌ 不拿别的平台的版本号', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const source = { kind: 'vendor-manifest' as const, manifest: 'https://u.example/{platform}.json', platforms: { 'aix-ppc64': 'x' } };
    expect(await new LatestVersionService().fetchLatestVersion(source)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
