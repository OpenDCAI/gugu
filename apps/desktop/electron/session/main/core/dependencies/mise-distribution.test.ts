import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpRegistryExecutable, resolveMiseDistribution } from './mise-distribution';
import { miseProgress } from './mise-process';

const target = {
  kind: 'mise' as const,
  package: '@vendor/agent',
  binary: 'agent',
  backend: { kind: 'platform-archive' as const, executables: { 'win32-x64': 'bin/agent.exe' } },
};
const npmTarget = {
  kind: 'mise' as const,
  package: '@vendor/js-agent',
  binary: 'js-agent',
  backend: { kind: 'npm' as const, node: '24.21.0' },
};
const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
afterEach(() => vi.unstubAllGlobals());

function registry(tarball = '/@vendor/agent/-/agent.tgz', digest = integrity) {
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/latest')
    ? { version: '1.2.3', optionalDependencies: { '@vendor/agent-win32-x64': 'npm:@vendor/agent@1.2.3-win32-x64' } }
    : { dist: { tarball, integrity: digest } }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('mise source resolution', () => {
  it('resolves aliases and path-mounted mirror URLs into an exact checksum-bound mise recipe', async () => {
    const fetcher = registry();
    const result = await resolveMiseDistribution(target, 'huawei', undefined, 'win32', 'x64');
    expect(fetcher.mock.calls[1]![0]).toContain(encodeURIComponent('1.2.3-win32-x64'));
    expect(result.config).toContain('https://repo.huaweicloud.com/repository/npm/@vendor/agent/-/agent.tgz');
    expect(result.config).toContain('sha512:' + Buffer.alloc(64, 7).toString('hex'));
    expect(result.config).toContain('strip_components = 1');
    expect(result.config).toContain('bin_path = "bin"');
    expect(result.version).toBe('1.2.3');
  });
  it('does not relabel another source’s cached version', async () => {
    registry();
    const a = await resolveMiseDistribution(target, 'official', undefined, 'win32', 'x64');
    const b = await resolveMiseDistribution(target, 'npmmirror', undefined, 'win32', 'x64');
    expect(a.installVersion).not.toBe(b.installVersion);
  });
  it('rejects a missing checksum instead of giving mise an unverified URL', async () => {
    registry('https://example.test/tool.tgz', 'sha512-bad');
    await expect(resolveMiseDistribution(target, 'official', undefined, 'win32', 'x64')).rejects.toThrow('Invalid platform package SHA-512');
  });
  it('refuses unsupported architectures before fetching metadata', async () => {
    const fetcher = registry();
    await expect(resolveMiseDistribution(target, 'official', undefined, 'win32', 'ia32')).rejects.toThrow('Unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('npm backend source resolution', () => {
  function npmRegistry(version = '4.5.6') {
    const fetcher = vi.fn(async (url: string) => Response.json({ version, url }));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('钉死版本再交给 mise —— 「装的是哪个版本」在装之前就是个已知值', async () => {
    // ❌ 不把 `@latest` 交给 mise:那样 inventory 与 `--version` 没有东西可核。
    const fetcher = npmRegistry('4.5.6');
    const result = await resolveMiseDistribution(npmTarget, 'official');
    expect(fetcher.mock.calls[0]![0]).toBe('https://registry.npmjs.org/%40vendor%2Fjs-agent/latest');
    expect(result).toMatchObject({ kind: 'npm', tool: 'npm:@vendor/js-agent', version: '4.5.6', installVersion: '4.5.6', node: '24.21.0' });
  });

  it('托管配置同时钉 node —— mise 把它当安装依赖,配置里没有就直接拒绝装包', async () => {
    npmRegistry();
    const result = await resolveMiseDistribution(npmTarget, 'official');
    expect(result.config).toBe('[tools]\nnode = "24.21.0"\n"npm:@vendor/js-agent" = "4.5.6"\n');
  });

  it('下载源经 NPM_CONFIG_REGISTRY 交给 mise 与 aube —— 显示版本与实际取包同一个源', async () => {
    npmRegistry();
    const official = await resolveMiseDistribution(npmTarget, 'official');
    const huawei = await resolveMiseDistribution(npmTarget, 'huawei');
    expect(official.kind === 'npm' && official.env).toEqual({ NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' });
    expect(huawei.kind === 'npm' && huawei.env).toEqual({ NPM_CONFIG_REGISTRY: 'https://repo.huaweicloud.com/repository/npm' });
  });

  it('镜像不进版本号 —— 同一个版本在哪个镜像上都是同一份包', () => {
    // 平台归档那条相反(URL 本身不同),上面那条用例钉的就是它。
    return (async () => {
      npmRegistry();
      const a = await resolveMiseDistribution(npmTarget, 'official');
      const b = await resolveMiseDistribution(npmTarget, 'npmmirror');
      expect(a.installVersion).toBe(b.installVersion);
    })();
  });

  it('发布的版本号不合规就停 —— ❌ 不把一个看不懂的字符串钉进配置', async () => {
    npmRegistry('not-a-version');
    await expect(resolveMiseDistribution(npmTarget, 'official')).rejects.toThrow('Invalid published version');
  });
});

describe('mise captured progress', () => {
  it('reads actual transfer counters and rates from the pinned engine', () => {
    expect(miseProgress('  http:gugu-codex@v  downloading  3.0s  25.3/145.2 MB · 12.2 MB/s', 3000)).toEqual({ phase: 'downloading', elapsedMs: 3000, bytesDone: 25_300_000, bytesTotal: 145_200_000, bytesPerSecond: 12_200_000, etaSeconds: 10 });
  });
  it('剩余时间由同一行的分子、分母、速度除出来 —— 逐字取自 antigravity-acp 真装那一次(#6335)', () => {
    expect(miseProgress('  http:gugu-agy_acp_server@1.1.1-test  downloading  12.0s  29.0/316.0 MB · 2.6 MB/s', 12000))
      .toEqual({ phase: 'downloading', elapsedMs: 12000, bytesDone: 29_000_000, bytesTotal: 316_000_000, bytesPerSecond: 2_600_000, etaSeconds: 110 });
    // 没有速度、或者速度小到算出来超过 6 小时,就不报剩余时间。
    expect(miseProgress('http:gugu-x@v downloading 1.0s 1.0/316.0 MB', 1000)).not.toHaveProperty('etaSeconds');
    expect(miseProgress('http:gugu-x@v downloading 1.0s 1.0/316.0 MB · 1 B/s', 1000)).not.toHaveProperty('etaSeconds');
  });
  it('does not invent a percentage while extracting or mistake a completion bar for byte progress', () => {
    expect(miseProgress('http:gugu-codex@v extracting 12.0s', 12000)).toEqual({ phase: 'installing', elapsedMs: 12000 });
    expect(miseProgress('mise by @jdx – installing 1 tool', 0)).toBeUndefined();
    expect(miseProgress('mise ████████████████ 1/1 · installed 1 tool in 13.9s', 13900)).toBeUndefined();
  });
  it('认 npm 后端那两种工具行 —— 一次安装最多牵包与 node 两样东西', () => {
    // 逐字取自 2026-09-22 打包那份 mise(2026.9.12)的真实输出。
    expect(miseProgress('  node@24.21.0                   downloading  6.0s  32.0/52.9 MB · 6.2 MB/s', 6000))
      .toEqual({ phase: 'downloading', elapsedMs: 6000, bytesDone: 32_000_000, bytesTotal: 52_900_000, bytesPerSecond: 6_200_000, etaSeconds: 3 });
    expect(miseProgress('  npm:@google/gemini-cli@0.60.0  checking package  3.0s', 3000))
      .toEqual({ phase: 'resolving', elapsedMs: 3000 });
    expect(miseProgress('  npm:@earendil-works/pi-coding-agent@0.87.0  resolving  9.0s  122/205 pkgs · 19.5 MiB', 9000))
      .toEqual({ phase: 'resolving', elapsedMs: 9000 });
    expect(miseProgress('  node@24.21.0                   node -v  12.0s', 12000))
      .toEqual({ phase: 'installing', elapsedMs: 12000 });
  });
  it('❌ 不把「几个包」当字节,也不把「还没开始」当一个阶段', () => {
    // `6/12 pkgs · 936.9 KiB` 里那一对数字是**包数**,后面那个才是总量 —— 分子分母凑一对
    // 就是凭空造一个百分比。分母永远只从 `<已完成>/<总量> <单位>` 那种形状来。
    expect(miseProgress('  npm:@google/gemini-cli@0.60.0  fetching  6.0s  6/12 pkgs · 936.9 KiB', 6000))
      .toEqual({ phase: 'downloading', elapsedMs: 6000 });
    expect(miseProgress('  npm:@google/gemini-cli@0.60.0  waiting for node@24.21.0', 100)).toBeUndefined();
  });
});

describe('ACP 注册表来源解析(#6335)', () => {
  const acpTarget = {
    kind: 'mise' as const,
    package: 'antigravity-acp',
    binary: 'agy_acp_server',
    backend: { kind: 'acp-registry' as const, agentId: 'antigravity-acp' },
  };
  const macZip = 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip';
  // 形状照抄 2026-09-23 的 registry.json:antigravity-acp 1.1.1 没有 sha256、没有 darwin-x86_64。
  function acpRegistry(binary: Record<string, unknown> = {
    'darwin-aarch64': { archive: macZip, cmd: './agy_acp_server.par' },
    'linux-x86_64': { archive: 'https://dl.google.com/x/linux.zip', cmd: './agy_acp_server.par', args: ['--uid='] },
    'windows-x86_64': { archive: 'https://dl.google.com/x/win.zip', cmd: './agy_acp_server.exe' },
  }, version: unknown = '1.1.1') {
    const fetcher = vi.fn(async (_url: string) => Response.json({
      version: '1.0.0',
      agents: [{ id: 'other', version: '9.9.9' }, { id: 'antigravity-acp', version, distribution: { binary } }],
    }));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('取注册表那一格:URL 原样、不剥层、bin_path 是 cmd 所在目录、没给 sha256 就不写校验和', async () => {
    const fetcher = acpRegistry();
    const result = await resolveMiseDistribution(acpTarget, 'official', undefined, 'darwin', 'arm64');
    expect(fetcher.mock.calls[0]![0]).toBe('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
    expect(result).toMatchObject({ kind: 'acp-registry', tool: 'http:gugu-agy_acp_server', version: '1.1.1', executable: 'agy_acp_server.par' });
    expect(result.installVersion).toMatch(/^1\.1\.1-acp-[0-9a-f]{32}$/);
    expect(result.config).toBe([
      '[tools."http:gugu-agy_acp_server"]',
      'version = ' + JSON.stringify(result.installVersion),
      'url = ' + JSON.stringify(macZip),
      'strip_components = 0',
      'bin_path = "."',
      '',
    ].join('\n'));
  });

  it('注册表给了 sha256 就交给 mise 校验', async () => {
    acpRegistry({ 'linux-x86_64': { archive: 'https://example.test/a.tar.gz', cmd: './bin/a', sha256: 'AB'.repeat(32) } });
    const result = await resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64');
    expect(result.config).toContain('checksum = "sha256:' + 'ab'.repeat(32) + '"');
    expect(result.config).toContain('bin_path = "bin"');
  });

  it('同一个版本号换了 URL 就是另一份字节 —— 版本目录不复用', async () => {
    acpRegistry({ 'darwin-aarch64': { archive: macZip, cmd: './agy_acp_server.par' } });
    const a = await resolveMiseDistribution(acpTarget, 'official', undefined, 'darwin', 'arm64');
    acpRegistry({ 'darwin-aarch64': { archive: macZip + '?v=2', cmd: './agy_acp_server.par' } });
    const b = await resolveMiseDistribution(acpTarget, 'official', undefined, 'darwin', 'arm64');
    expect(a.installVersion).not.toBe(b.installVersion);
  });

  it('这一格的启动参数原样带给启动器 —— Linux 那格的 `--uid=` 丢了,进程起来就 abort', async () => {
    acpRegistry();
    const linux = await resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64');
    expect(linux).toMatchObject({ kind: 'acp-registry', args: ['--uid='] });
    const mac = await resolveMiseDistribution(acpTarget, 'official', undefined, 'darwin', 'arm64');
    expect(mac).not.toHaveProperty('args');
    // 没有参数的那格,版本目录与从前逐字相同 —— 已装的不会被当成新版本重装。
    const legacy = createHash('sha256').update(macZip + '\n').digest('hex').slice(0, 32);
    expect(mac.installVersion).toBe('1.1.1-acp-' + legacy);
  });

  it('参数换了就是另一种启动法 —— 版本目录不复用,启动器跟着重写', async () => {
    acpRegistry({ 'linux-x86_64': { archive: 'https://dl.google.com/x/linux.zip', cmd: './a' } });
    const a = await resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64');
    acpRegistry({ 'linux-x86_64': { archive: 'https://dl.google.com/x/linux.zip', cmd: './a', args: ['--uid='] } });
    const b = await resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64');
    expect(a.installVersion).not.toBe(b.installVersion);
  });

  it('参数不是字符串数组就停', async () => {
    acpRegistry({ 'linux-x86_64': { archive: 'https://dl.google.com/x/linux.zip', cmd: './a', args: '--uid=' } });
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64')).rejects.toThrow('args must be a string array');
  });

  it('npm 下载源与这条无关 —— 传进来镜像 id 也只问注册表', async () => {
    const fetcher = acpRegistry();
    await resolveMiseDistribution(acpTarget, 'huawei', undefined, 'win32', 'x64');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('厂商没发的平台说「装不了」:darwin-x86_64 没有这一格', async () => {
    acpRegistry();
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'darwin', 'x64')).rejects.toThrow('darwin-x86_64 is not published');
  });

  it('注册表不认识的平台,不问网络就停', async () => {
    const fetcher = acpRegistry();
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'win32', 'ia32')).rejects.toThrow('Unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('拒绝指出解压根的 cmd、非 https 的归档、不支持的归档格式与坏版本号', async () => {
    acpRegistry({ 'linux-x86_64': { archive: 'https://example.test/a.zip', cmd: '../evil' } });
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64')).rejects.toThrow('Invalid ACP registry command path');
    acpRegistry({ 'linux-x86_64': { archive: 'http://example.test/a.zip', cmd: './a' } });
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64')).rejects.toThrow('https');
    acpRegistry({ 'linux-x86_64': { archive: 'https://example.test/a.dmg', cmd: './a' } });
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'linux', 'x64')).rejects.toThrow('archive format');
    acpRegistry(undefined, 'latest');
    await expect(resolveMiseDistribution(acpTarget, 'official', undefined, 'darwin', 'arm64')).rejects.toThrow('Invalid published version');
  });

  it('注册表里没有这一家就明说', async () => {
    acpRegistry();
    await expect(resolveMiseDistribution({ ...acpTarget, backend: { kind: 'acp-registry', agentId: 'nope' } }, 'official', undefined, 'darwin', 'arm64')).rejects.toThrow('no agent: nope');
  });
});

describe('acpRegistryExecutable', () => {
  it('照注册表里真实出现过的写法折成解压根下的 POSIX 相对路径', () => {
    expect(acpRegistryExecutable('./agy_acp_server.par')).toBe('agy_acp_server.par');
    expect(acpRegistryExecutable('amp-acp.exe')).toBe('amp-acp.exe');
    expect(acpRegistryExecutable('./dist-package\\cursor-agent.cmd')).toBe('dist-package/cursor-agent.cmd');
  });
  it('❌ 绝对路径、盘符、`..` 一律拒绝', () => {
    for (const bad of ['/usr/bin/x', 'C:\\x.exe', './a/../../x', '']) {
      expect(() => acpRegistryExecutable(bad)).toThrow('Invalid ACP registry command path');
    }
  });
});

describe('厂商按平台版本清单(vendor-manifest,#6335 的 agy)', () => {
  const sha512 = 'ab'.repeat(64);
  const vendorTarget = {
    kind: 'mise' as const,
    package: 'agy',
    binary: 'agy',
    backend: {
      kind: 'vendor-manifest' as const,
      manifest: 'https://updater.example/manifests/{platform}.json',
      platforms: {
        'darwin-arm64': 'darwin_arm64',
        'linux-x64': 'linux_amd64',
        'linux-x64-musl': 'linux_amd64_musl',
        'win32-x64': 'windows_amd64',
      },
      archiveExecutable: 'antigravity',
    },
  };
  function manifest(body: Record<string, unknown>) {
    const fetcher = vi.fn(async (_url: string) => Response.json(body));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('归档载荷:问本机那一格,sha512 交给 mise,原样解压、不剥层,可执行文件是包里那个', async () => {
    const fetcher = manifest({ version: '1.2.10', url: 'https://cdn.example/cli_mac_arm64.tar.gz', sha512 });
    const result = await resolveMiseDistribution(vendorTarget, 'official', undefined, 'darwin', 'arm64');
    expect(fetcher.mock.calls[0]![0]).toBe('https://updater.example/manifests/darwin_arm64.json');
    expect(result.kind).toBe('vendor-manifest');
    expect(result.version).toBe('1.2.10');
    expect(result.installVersion).toMatch(/^1\.2\.10-vm-[0-9a-f]{32}$/);
    expect(result.config).toContain('[tools."http:gugu-agy"]');
    expect(result.config).toContain('checksum = "sha512:' + sha512 + '"');
    expect(result.config).toContain('strip_components = 0');
    expect((result as { executable: string }).executable).toBe('antigravity');
    // 启动器与 mise 工具名都叫 agy —— ❌ 不出现一个叫 antigravity 的 bin(会顶掉 IDE 的命令)。
    expect(result.config).not.toContain('bin = "antigravity"');
  });

  it('裸 .exe 载荷(Windows):不当归档,用 `bin` 定名为 agy.exe', async () => {
    manifest({ version: '1.2.10', url: 'https://cdn.example/cli_windows_x64.exe', sha512 });
    const result = await resolveMiseDistribution(vendorTarget, 'official', undefined, 'win32', 'x64');
    expect(result.config).toContain('bin = "agy.exe"');
    expect(result.config).not.toContain('strip_components');
    expect((result as { executable: string }).executable).toBe('agy.exe');
  });

  it('musl 的 Linux 问 `_musl` 那一格;glibc 问普通那一格', async () => {
    const fetcher = manifest({ version: '1.2.10', url: 'https://cdn.example/cli_linux.tar.gz', sha512 });
    await resolveMiseDistribution(vendorTarget, 'official', undefined, 'linux', 'x64', true);
    await resolveMiseDistribution(vendorTarget, 'official', undefined, 'linux', 'x64', false);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'https://updater.example/manifests/linux_amd64_musl.json',
      'https://updater.example/manifests/linux_amd64.json',
    ]);
  });

  it('厂商没发的平台:取清单之前就说装不了', async () => {
    const fetcher = manifest({});
    await expect(resolveMiseDistribution(vendorTarget, 'official', undefined, 'linux', 'arm64', false)).rejects.toThrow('Unsupported mise target: linux-arm64');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('清单里 sha512 缺失或不是 128 位十六进制 → 响亮失败,❌ 不给 mise 一个没校验的 URL', async () => {
    manifest({ version: '1.2.10', url: 'https://cdn.example/x.tar.gz', sha512: 'abc' });
    await expect(resolveMiseDistribution(vendorTarget, 'official', undefined, 'darwin', 'arm64')).rejects.toThrow('SHA-512');
    manifest({ version: '1.2.10', url: 'http://cdn.example/x.tar.gz', sha512 });
    await expect(resolveMiseDistribution(vendorTarget, 'official', undefined, 'darwin', 'arm64')).rejects.toThrow('https');
  });

  it('同一个版本号换了字节(URL / 校验和)就是另一个版本目录', async () => {
    manifest({ version: '1.2.10', url: 'https://cdn.example/a.tar.gz', sha512 });
    const a = await resolveMiseDistribution(vendorTarget, 'official', undefined, 'darwin', 'arm64');
    manifest({ version: '1.2.10', url: 'https://cdn.example/a.tar.gz', sha512: 'cd'.repeat(64) });
    const b = await resolveMiseDistribution(vendorTarget, 'official', undefined, 'darwin', 'arm64');
    expect(a.installVersion).not.toBe(b.installVersion);
  });
});
