import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledMisePath, launcherRelease, managedLauncher, miseEnvironment, miseToolSlug, readManagedLauncherRelease, runMiseOperation } from './mise-installer';
import { managedMiseBinDir } from './managed-agent-home';

const mocks = vi.hoisted(() => ({ appRoot: '', run: vi.fn(), exec: vi.fn(), resolve: vi.fn() }));
vi.mock('@gugu/session-core/exec', async (original) => {
  const real = await original<typeof import('@gugu/session-core/exec')>();
  return { ...real, execInProcessGroup: mocks.exec };
});
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => mocks.appRoot } }));
vi.mock('./mise-process', async (original) => ({ ...(await original<typeof import('./mise-process')>()), runMiseProcess: mocks.run }));
vi.mock('./mise-distribution', () => ({ resolveMiseDistribution: mocks.resolve }));
let home: string;
let entries: Array<{ version: string; install_path: string; installed: boolean }>;
const target = {
  kind: 'mise' as const,
  package: '@vendor/agent',
  binary: 'agent',
  backend: { kind: 'platform-archive' as const, executables: {} },
};
const npmTarget = {
  kind: 'mise' as const,
  package: '@vendor/js-agent',
  binary: 'agent',
  backend: { kind: 'npm' as const, node: '24.21.0' },
};
const tool = 'http:gugu-agent';
const version = '1.2.3-official-content';
const launcher = () => path.join(managedMiseBinDir(), process.platform === 'win32' ? 'agent.cmd' : 'agent');
let abort: AbortController | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'gugu mise '));
  mocks.appRoot = home;
  vi.stubEnv('GUGU_HOME', home);
  const binary = bundledMisePath();
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'bundled engine');
  await mkdir(managedMiseBinDir(), { recursive: true });
  await writeFile(launcher(), 'previous launcher');
  entries = [];
  abort = undefined;
  mocks.exec.mockReset().mockResolvedValue({ stdout: 'agent 1.2.3', stderr: '' });
  mocks.resolve.mockReset().mockResolvedValue({ kind: 'platform-archive', tool, version: '1.2.3', installVersion: version, executable: 'bin/agent', config: '[tools]\n' });
  mocks.run.mockReset().mockImplementation(async (_command, args, options) => {
    if (args[0] === '--version') return '2026.9.12 test';
    if (args[0] === 'ls') return JSON.stringify(entries);
    if (args[0] === 'install') {
      const install_path = path.join(home, 'agents/mise/data/installs/http-gugu-agent', version);
      await mkdir(path.join(install_path, 'bin'), { recursive: true });
      await writeFile(path.join(install_path, 'bin/agent'), 'actual native program');
      entries.push({ version, install_path, installed: true });
      if (abort) { abort.abort(); options.signal.throwIfAborted(); }
      return '';
    }
    if (args[0] === 'uninstall') {
      for (const entry of entries) await rm(entry.install_path, { recursive: true, force: true });
      entries = [];
      return '';
    }
    throw new Error('Unexpected mise operation: ' + args.join(' '));
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('application-owned mise lifecycle', () => {
  it('publishes a stable launcher after verifying the installed executable, then removes through mise', async () => {
    expect((await runMiseOperation({ mise: { target, operation: 'install' } })).success).toBe(true);
    expect(await readFile(launcher(), 'utf8')).toContain('http-gugu-agent');
    expect(mocks.exec.mock.calls[0]![0]).toContain(version);
    expect((await runMiseOperation({ mise: { target, operation: 'uninstall', selectedPath: launcher() } })).success).toBe(true);
    expect(mocks.run.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify(['uninstall', '--all', tool]))).toBe(true);
    await expect(readFile(launcher())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  /**
   * 换源重试要分得出「取包那一段挂了」与「装完之后才挂」(#6157)。这一层不判断换不换,
   * 只负责如实说这次挂在哪一段 —— 判据在 `isDownloadStageFailure`。
   */
  it('取包那一段挂了要标出来 —— 上层据此换个源再试一次', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('Package metadata HTTP 502'));
    const result = await runMiseOperation({ mise: { target, operation: 'install', registry: 'npmmirror' } });
    expect(result).toMatchObject({ success: false, error: { stage: 'download' } });
  });

  it('下载到一半断了:失败里带着停下那一刻的进度(哪一步、已下多少 / 共多少)—— 说得清卡在哪一步(#7199)', async () => {
    mocks.run.mockImplementation(async (_command, args, options) => {
      if (args[0] === '--version') return '2026.9.12 test';
      if (args[0] === 'ls') return JSON.stringify(entries);
      if (args[0] === 'uninstall') return '';
      if (args[0] === 'install') {
        options.onOutput?.(tool + '@' + version + '  downloading  41.0s  45.0/119.5 MB · 1.1 MB/s');
        throw new Error('error sending request: connection reset by peer');
      }
      throw new Error('Unexpected mise operation: ' + args.join(' '));
    });
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { type: 'command-failed', stage: 'download', lastProgress: { phase: 'downloading' } } });
    const last = !result.success && 'lastProgress' in result.error ? result.error.lastProgress : undefined;
    expect(last?.bytesTotal).toBeGreaterThan(last?.bytesDone ?? 0);
    expect(last?.bytesDone).toBeGreaterThan(0);
  });

  it('还没开始下就挂了(取清单那一步):停在 resolving,❌ 编一个字节数', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('Package metadata HTTP 502'));
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { lastProgress: { phase: 'resolving' } } });
    const last = !result.success && 'lastProgress' in result.error ? result.error.lastProgress : undefined;
    expect(last?.bytesDone).toBeUndefined();
  });

  it('阴控:装完之后才挂的失败不带这个标记 —— 换源不会有任何不同', async () => {
    // 装出来的东西自报的版本与选定的发行物对不上。这时换个镜像重来一遍只是把同一件事做两遍。
    mocks.exec.mockResolvedValue({ stdout: 'agent 9.9.9', stderr: '' });
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result.success).toBe(false);
    expect(result).not.toMatchObject({ error: { stage: 'download' } });
  });

  it('rejects the unfiltered inventory shape instead of silently interpreting it as no installations', async () => {
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (command, args, options) => args[0] === 'ls' ? '{}' : run(command, args, options));
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { output: 'Invalid mise installation inventory' } });
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
  });

  it('reports a lock-release failure after publication without hiding that the new entry is active', async () => {
    const lock = lockfile.lock;
    vi.spyOn(lockfile, 'lock').mockImplementationOnce(async (...args) => {
      const release = await lock(...args);
      return async () => { await release(); throw new Error('release failed'); };
    });
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { type: 'command-failed', output: expect.stringContaining('new installation is active') } });
    expect(await readFile(launcher(), 'utf8')).toContain('http-gugu-agent');
  });

  it('retains the old launcher if mise installs bytes reporting the wrong version', async () => {
    mocks.exec.mockResolvedValue({ stdout: 'agent 0.0.0', stderr: '' });
    const result = await runMiseOperation({ mise: { target, operation: 'update' } });
    expect(result).toMatchObject({ success: false, error: { type: 'command-failed' } });
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    expect(entries).toEqual([]);
  });
  it('cleans the new version on cancellation and leaves the published entry unchanged', async () => {
    abort = new AbortController();
    const result = await runMiseOperation({ signal: abort.signal, mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { type: 'cancelled' } });
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    expect(entries).toEqual([]);
    const cleanup = mocks.run.mock.calls.find((call) => call[1][0] === 'uninstall');
    expect(cleanup?.[2].signal).toBeInstanceOf(AbortSignal);
    expect(cleanup?.[2].signal.aborted).toBe(false);
  });
  /**
   * npm backend —— 纯 JS 的那些家(#6098)。这一组钉三件事:配置里必须钉 node、
   * 安装命令里必须带上 node、发布出去的启动器必须把 node 的 bin 目录前置到 PATH。
   */
  describe('npm 后端', () => {
    const nodeInstall = () => path.join(home, 'agents/mise/data/installs/node/24.21.0');
    const packageInstall = () => path.join(home, 'agents/mise/data/installs/npm-vendor-js-agent/4.5.6');

    beforeEach(() => {
      mocks.resolve.mockResolvedValue({
        kind: 'npm',
        tool: 'npm:@vendor/js-agent',
        version: '4.5.6',
        installVersion: '4.5.6',
        node: '24.21.0',
        config: '[tools]\nnode = "24.21.0"\n"npm:@vendor/js-agent" = "4.5.6"\n',
        env: { NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' },
      });
      mocks.exec.mockResolvedValue({ stdout: '4.5.6', stderr: '' });
      const run = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) => {
        if (args[0] === 'ls' && args[2] === 'node') {
          return JSON.stringify([{ version: '24.21.0', install_path: nodeInstall(), installed: true }]);
        }
        if (args[0] === 'install') {
          // aube 落在 `node_modules/.bin/`;mise 的 node 发行包把 node 放在 bin/。
          await mkdir(path.join(packageInstall(), 'node_modules', '.bin'), { recursive: true });
          await writeFile(path.join(packageInstall(), 'node_modules', '.bin', 'agent'), '#!/usr/bin/env node\n');
          await mkdir(path.join(nodeInstall(), 'bin'), { recursive: true });
          await writeFile(path.join(nodeInstall(), 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), 'node');
          entries.push({ version: '4.5.6', install_path: packageInstall(), installed: true });
          return '';
        }
        return run(command, args, options);
      });
    });

    it('node 与包一条命令一起装,下载源经 NPM_CONFIG_REGISTRY 递给 mise', async () => {
      const result = await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } });
      expect(result.success).toBe(true);
      const install = mocks.run.mock.calls.find((call) => call[1][0] === 'install')!;
      // 顺序有意义:mise 把 node 当安装依赖,它没装好就直接拒绝装包(实测)。
      expect(install[1]).toEqual(['install', 'node@24.21.0', 'npm:@vendor/js-agent@4.5.6']);
      expect(install[2].env.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org');
      // 托管配置写下去的就是解析器给的那份(钉着 node)。
      expect(await readFile(path.join(home, 'agents/mise/operations/agent/global.toml'), 'utf8'))
        .toContain('node = "24.21.0"');
    });

    it('启动器把咕咕自己那份 node 前置到 PATH —— 那个壳是 `#!/usr/bin/env node`', async () => {
      // 阴控见 `managedLauncher` 那一组:平台归档那条后端不写 PATH 行。
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).success).toBe(true);
      const published = await readFile(launcher(), 'utf8');
      expect(published).toContain(path.join('node_modules', '.bin', 'agent'));
      expect(published).toContain(process.platform === 'win32' ? 'set "PATH=' : 'PATH=');
      if (process.platform !== 'win32') expect(published).toContain(path.join(nodeInstall(), 'bin'));
    });

    it('装完验版本交给 execInProcessGroup:包壳由它经 planDirectSpawn 做,超时时整树停(Windows 的 .cmd 入口)', async () => {
      // w1 真机 2026-09-22:从前这里手拼 `'"' + exe + '" --version'` 交给 execFile,Node 把引号再转义一遍,
      // cmd 报「系统找不到指定的路径」,装好的包被回滚 —— Windows 上 npm 那条托管安装全挂。
      // execFile 自带的超时只杀得到 cmd 壳 ⇒ 版本探测交给执行层的进程组那条路,原路径原样交出去。
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).success).toBe(true);
      const [exe, args, options] = mocks.exec.mock.calls.at(-1)!;
      expect(exe).toContain(path.join('node_modules', '.bin', 'agent'));
      expect(args).toEqual(['--version']);
      expect(options).toMatchObject({ timeout: 15_000 });
    });

    it('mise 没报出那份 node 就判失败 —— ❌ 不发布一个跑不起来的启动器', async () => {
      const run = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) =>
        args[0] === 'ls' && args[2] === 'node' ? '[]' : run(command, args, options));
      const result = await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } });
      expect(result).toMatchObject({ success: false, error: { output: expect.stringContaining('node runtime') } });
      expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    });

    it('包里没有那个名字的可执行文件就响亮报错,❌ 不猜一个路径', async () => {
      const run = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) => {
        if (args[0] === 'install') {
          await mkdir(path.join(packageInstall(), 'node_modules', '.bin'), { recursive: true });
          entries.push({ version: '4.5.6', install_path: packageInstall(), installed: true });
          return '';
        }
        return run(command, args, options);
      });
      const result = await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } });
      expect(result).toMatchObject({ success: false, error: { output: expect.stringContaining('has no "agent" executable') } });
    });

    it('卸载走 npm 那个工具名', async () => {
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).success).toBe(true);
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'uninstall', selectedPath: launcher() } })).success).toBe(true);
      expect(mocks.run.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify(['uninstall', '--all', 'npm:@vendor/js-agent']))).toBe(true);
    });

    /**
     * 判「卡住」看的是真实进展,不是 mise 出不出声。实测(CodeBuddy 61MB):包边下边解进 aube 的 store,
     * mise 那一整段只刷一行不变的 `fetching … 97/106 pkgs · 5.9 MiB`,installs 目录要到最后才长。
     * 计时器假的(只假 setTimeout / setInterval),量目录的 I/O 是真的:模拟三分钟、一声不出。
     */
    describe('下包那一段 mise 一声不出', () => {
      const files = () => path.join(home, 'agents/mise/cache/npm/aube/store/v1/files');
      /** 别家早先装进 store 的一个文件。 */
      const earlier = () => path.join(files(), 'ab', 'earlier-package-file');
      const silentFetch = (each: 'land' | 'nothing' | 'rewrite-earlier') => {
        const run = mocks.run.getMockImplementation()!;
        mocks.run.mockImplementation(async (command, args, options) => {
          if (args[0] === 'install') {
            const blob = path.join(files(), '.aube-stream-test');
            for (let step = 0; step < 36; step += 1) {
              if (each === 'land') await appendFile(blob, Buffer.alloc(64 * 1024));
              if (each === 'rewrite-earlier') await writeFile(earlier(), Buffer.alloc(64 * 1024));
              await vi.advanceTimersByTimeAsync(5_000);
              // 让量目录那一轮真实的 readdir / stat 跑完再推下一段时间。
              for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
              options.signal.throwIfAborted();
            }
          }
          return run(command, args, options);
        });
      };
      beforeEach(async () => {
        await mkdir(path.dirname(earlier()), { recursive: true });
        await writeFile(earlier(), Buffer.alloc(64 * 1024));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      });
      afterEach(() => { vi.useRealTimers(); });

      it('字节一直落进 aube 的 store:不算卡住,装得完', async () => {
        silentFetch('land');
        expect(await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).toMatchObject({ success: true });
      });

      it('阴控:同样一声不出、也没有字节落地 —— 一分钟后判卡住', async () => {
        silentFetch('nothing');
        expect(await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } }))
          .toMatchObject({ success: false, error: { type: 'stalled', stage: 'download' } });
      });

      it('store 里早先就有的文件被反复改写(大小不变):最多涨一次,照样判卡住', async () => {
        silentFetch('rewrite-earlier');
        expect(await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } }))
          .toMatchObject({ success: false, error: { type: 'stalled', stage: 'download' } });
      });
    });
  });

  describe('managedLauncher', () => {
    it('平台归档那条不写 PATH 行 —— 归档里就是一个可直接执行的文件', () => {
      const script = managedLauncher(path.join(managedMiseBinDir(), '..', 'x', 'agent'));
      expect(script).not.toContain('PATH');
    });
    it('注册表给的启动参数排在调用方参数前面', () => {
      const script = managedLauncher('/x/agy_acp_server.par', undefined, '1.2.1', ['--uid=']);
      expect(script.endsWith("exec '/x/agy_acp_server.par' '--uid=' \"$@\"\n")).toBe(true);
    });
    it('发行标记写进启动器,读得回来 —— 不执行它也知道装的是哪个版本(#6335)', () => {
      const script = managedLauncher(path.join(managedMiseBinDir(), '..', 'x', 'agent'), undefined, '1.1.1');
      expect(launcherRelease(script)).toBe('1.1.1');
      expect(launcherRelease('#!/bin/sh\nexec /x "$@"\n')).toBeNull();
      expect(launcherRelease('@echo off\r\nrem gugu-release: 2.0.0-beta.1\r\n"%~dp0x" %*\r\n')).toBe('2.0.0-beta.1');
      expect(launcherRelease('# gugu-release: not-a-version\n')).toBeNull();
    });
  });

  describe('ACP 注册表形态(#6335)', () => {
    const acpTarget = {
      kind: 'mise' as const,
      package: 'antigravity-acp',
      binary: 'agent',
      backend: { kind: 'acp-registry' as const, agentId: 'antigravity-acp' },
    };
    beforeEach(() => {
      mocks.resolve.mockResolvedValue({ kind: 'acp-registry', tool, version: '1.1.1', installVersion: version, executable: 'bin/agent', config: '[tools]\n' });
      const base = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) => {
        const output = await base(command, args, options);
        if (args[0] === 'install') await chmod(path.join(home, 'agents/mise/data/installs/http-gugu-agent', version, 'bin/agent'), 0o755);
        return output;
      });
    });

    it('❌ 不执行装出来的 ACP 服务验版本;启动器指向 cmd 那个文件并带发行标记', async () => {
      expect((await runMiseOperation({ mise: { target: acpTarget, operation: 'install' } })).success).toBe(true);
      expect(mocks.exec).not.toHaveBeenCalled();
      const published = await readFile(launcher(), 'utf8');
      expect(published).toContain(path.join('http-gugu-agent', version, 'bin', 'agent'));
      expect(launcherRelease(published)).toBe('1.1.1');
      expect(await readManagedLauncherRelease(launcher())).toBe('1.1.1');
    });

    it('cmd 指的文件不在就失败并回滚,❌ 不发布一个指向空处的启动器', async () => {
      mocks.resolve.mockResolvedValue({ kind: 'acp-registry', tool, version: '1.1.1', installVersion: version, executable: 'bin/missing', config: '[tools]\n' });
      const result = await runMiseOperation({ mise: { target: acpTarget, operation: 'install' } });
      expect(result.success).toBe(false);
      expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    });

    it('只认咕咕自己 bin 目录里的启动器 —— 别处同名文件不算', async () => {
      const elsewhere = path.join(home, 'agent');
      await writeFile(elsewhere, managedLauncher('/x', undefined, '1.1.1'));
      expect(await readManagedLauncherRelease(elsewhere)).toBeNull();
    });
  });

  describe('miseToolSlug', () => {
    it('照 mise 折目录名的规则来 —— 量进度要按它找目录', () => {
      // 实测(2026-09-22,2026.9.12):这两行就是盘上真实的目录名。
      expect(miseToolSlug('npm:@google/gemini-cli')).toBe('npm-google-gemini-cli');
      expect(miseToolSlug('http:gugu-claude')).toBe('http-gugu-claude');
      // 实测(2026-09-23,同一份 mise):下划线也折成连字符。
      expect(miseToolSlug('http:gugu-agy_acp_server')).toBe('http-gugu-agy-acp-server');
    });
  });

  it('isolates mise configuration while forwarding only required OS and transport inputs', () => {
    const env = miseEnvironment(home, path.join(home, 'owned.toml'), {
      HOME: '/user', PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', ANTHROPIC_API_KEY: 'not-for-installer', MISE_GLOBAL_CONFIG_FILE: '/user/mise.toml', MISE_NO_CONFIG: '1',
    });
    expect(env.HOME).toBe('/user');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MISE_NO_CONFIG).toBeUndefined();
    expect(env.MISE_GLOBAL_CONFIG_FILE).toBe(path.join(home, 'owned.toml'));
    expect(env.MISE_SYSTEM_CONFIG_DIR).toBe(path.join(home, 'system'));
  });
});
