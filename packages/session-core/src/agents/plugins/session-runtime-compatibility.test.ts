import { describe, expect, it } from 'vitest';
import { resolveSessionRuntimeCompatible, SessionRuntimeCompatibilityError } from './session-runtime-compatibility';
import type { IExecutionContext } from '../../exec';
import type { SessionBundleDescriptor } from './capabilities/session-bundle';

/**
 * 这一格钉的是**边界的形状**:版本探针拿到的必须是「将要跑的那个可执行文件 + 它自己声明的
 * versionArgs」,❌ 不是调用方替它包好的一条 Windows 命令行。
 *
 * 为什么钉它:`{executable, args}` 这个形状装不下 `windowsVerbatimArguments`,而包了
 * `cmd.exe /d /s /c "…"` 的命令行少了那个开关就是一条散架的命令行(Windows 真机实撞,
 * codex 的 Code/TUI 会话因此一条都开不起来)。包壳的属主只有一个:执行上下文自己的
 * `planDirectSpawn`,它同时产出 argv 与那组必须一起带上的 spawn 开关。
 */

/** 只读 surfaces / sessionpage / runtimeCompatibility 三格,其余字段与本用例无关。 */
function descriptor(): SessionBundleDescriptor {
  return {
    surfaces: ['app-server', 'tui'],
    sessionpage: { 'tui': { identity: 'addressable', messageTransport: 'router' } },
    runtimeCompatibility: {
      'app-server': {
        kind: 'semver-supported-floor',
        supportedFloor: '0.80.0',
        versionArgs: ['--version'],
      },
    },
  } as unknown as SessionBundleDescriptor;
}

function recordingContext(stdout: string): {
  context: IExecutionContext;
  calls: { command: string; args: string[] }[];
  options: Record<string, unknown>[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const options: Record<string, unknown>[] = [];
  const context = {
    supportsLocalSpawn: true,
    exec: async (command: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      options.push(opts);
      return { stdout, stderr: '' } as never;
    },
    execStreaming: async () => {},
    dispose: () => {},
  } as unknown as IExecutionContext;
  return { context, calls, options };
}

describe('resolveSessionRuntimeCompatible', () => {
  it('探的是 harness 可执行文件本体 + 声明的 versionArgs,不是包好的 launcher argv', async () => {
    const { context, calls } = recordingContext('codex-cli 0.145.0');
    const executable = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd';

    const resolution = await resolveSessionRuntimeCompatible({
      providerId: 'codex',
      surface: 'app-server',
      descriptor: descriptor(),
      executable,
      executionContext: context,
    });

    expect(calls).toEqual([{ command: executable, args: ['--version'] }]);
    expect(resolution.executable).toBe(executable);
  });

  // #6183: 探针等「进程退出」这个事实,没有时钟;放弃等待只走启动属主的 signal。
  it('不给探针设时钟,只带调用方的 signal', async () => {
    const { context, options } = recordingContext('codex-cli 0.145.0');
    const started = new AbortController();

    await resolveSessionRuntimeCompatible({
      providerId: 'codex',
      surface: 'app-server',
      descriptor: descriptor(),
      executable: '/usr/local/bin/codex',
      executionContext: context,
      signal: started.signal,
    });

    expect(options).toHaveLength(1);
    expect(options[0]).not.toHaveProperty('timeout');
    expect(options[0]?.signal).toBe(started.signal);
  });

  // 阳控:同一套装置在版本不够时必须红 —— 否则上面那条绿说明不了探针真的跑过。
  it('版本低于 floor 时响亮失败', async () => {
    const { context } = recordingContext('codex-cli 0.79.9');
    await expect(
      resolveSessionRuntimeCompatible({
        providerId: 'codex',
        surface: 'app-server',
        descriptor: descriptor(),
        executable: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
        executionContext: context,
      })
    ).rejects.toThrow(/requires harness runtime 0\.80\.0 or newer; found 0\.79\.9/);
  });

  // #6186:版本探测也是一次「跑它」—— copilot 的 `--version` 会把新版下进缓存。声明了关自更新的家,探测必须带上开关。
  it('带上 descriptor 声明的关自更新开关', async () => {
    const envs: (Record<string, string> | undefined)[] = [];
    const context = {
      supportsLocalSpawn: true,
      exec: async (_command: string, _args: string[] = [], opts: { env?: Record<string, string> } = {}) => {
        envs.push(opts.env);
        return { stdout: 'codex-cli 0.145.0', stderr: '' } as never;
      },
      execStreaming: async () => {},
      dispose: () => {},
    } as unknown as IExecutionContext;
    await resolveSessionRuntimeCompatible({
      providerId: 'codex-like',
      surface: 'app-server',
      descriptor: {
        ...descriptor(),
        selfUpdate: { kind: 'session-env', env: { COPILOT_AUTO_UPDATE: 'false' }, evidence: 'https://x.test' },
      } as SessionBundleDescriptor,
      executable: '/bin/codex-like',
      executionContext: context,
      env: { PATH: '/caller/bin' },
    });
    expect(envs).toEqual([{ PATH: '/caller/bin', COPILOT_AUTO_UPDATE: 'false' }]);
  });
});

/**
 * #3685 / #6183(原在 tests/unit/desktop/electron/codexEnginePreflight3685.test.ts,被 #6177 删掉;
 * codex 的私有预检已由本 PR 并进唯一的版本探针属主,这条事故契约挪到属主自己的测试里守):
 * 引擎在这份 env 下跑不起来时当场抛,报错指向**真因**(引擎自己的话)并摆出 PATH;
 * 可执行文件不存在时带出 errno=ENOENT(#2576 的分支依据)。
 */
function failingContext(failure: Error): IExecutionContext {
  return {
    supportsLocalSpawn: true,
    exec: async () => {
      throw failure;
    },
    execStreaming: async () => {},
    dispose: () => {},
  } as unknown as IExecutionContext;
}

describe('resolveSessionRuntimeCompatible — 引擎跑不起来时的报错 (#3685)', () => {
  const env = { PATH: '/usr/bin:/bin' };

  it('当场抛,带出引擎自己的话与 PATH', async () => {
    const shim = '/Users/u/.nvm/versions/node/v24/bin/codex';
    const failure = Object.assign(new Error(`Command failed: ${shim} --version`), {
      code: 127,
      stderr: 'env: gugu-fake-node: No such file or directory',
      stdout: '',
    });
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'codex',
      surface: 'app-server',
      descriptor: descriptor(),
      executable: shim,
      executionContext: failingContext(failure),
      env,
    }).then(() => null, (error: unknown) => error as Error);

    expect(thrown, '引擎跑不起来时必须抛,❌ 不许继续走到 spawn').toBeInstanceOf(SessionRuntimeCompatibilityError);
    expect(thrown!.message).toContain(shim);
    expect(thrown!.message).toContain('gugu-fake-node');
    expect(thrown!.message).toContain('/usr/bin:/bin');
  });

  it('可执行文件不存在时带出 errno=ENOENT 与 PATH', async () => {
    const failure = Object.assign(new Error('spawn /nonexistent/codex-abcdef ENOENT'), { code: 'ENOENT' });
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'codex',
      surface: 'app-server',
      descriptor: descriptor(),
      executable: '/nonexistent/codex-abcdef',
      executionContext: failingContext(failure),
      env,
    }).then(() => null, (error: unknown) => error as SessionRuntimeCompatibilityError);

    expect(thrown).toBeInstanceOf(SessionRuntimeCompatibilityError);
    expect(thrown!.probe?.errno).toBe('ENOENT');
    expect(thrown!.message).toContain('/usr/bin:/bin');
  });
});

/** pi 那一格的形状:tui 经 node 起(#6390)。 */
function nodeRuntimeDescriptor(): SessionBundleDescriptor {
  return {
    surfaces: ['tui'],
    sessionpage: { 'tui': { identity: 'addressable', messageTransport: 'local-session' } },
    runtimeCompatibility: {
      'tui': {
        kind: 'semver-supported-ranges',
        runtime: 'node',
        supportedRanges: ['>=22.15.0 <23.0.0', '>=23.8.0'],
        versionArgs: ['--version'],
      },
    },
  } as unknown as SessionBundleDescriptor;
}

describe('resolveSessionRuntimeCompatible — 经 node 起的家拿到的必须是 JS 入口 (#6390)', () => {
  it('Windows 上读不出壳里 JS 入口的 .cmd:响亮失败,❌ 把壳交给 node,也不去探版本', async () => {
    const { context, calls } = recordingContext('v24.14.0');
    const shim = 'C:\\nonexistent-gugu-6390\\agents\\mise-bin\\pi.cmd';
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'pi',
      surface: 'tui',
      descriptor: nodeRuntimeDescriptor(),
      executable: shim,
      executionContext: context,
      runtimeExecutable: 'C:\\node\\node.exe',
      platform: 'win32',
    }).then(() => null, (error: unknown) => error as SessionRuntimeCompatibilityError);

    expect(thrown).toBeInstanceOf(SessionRuntimeCompatibilityError);
    expect(thrown!.code).toBe('runtime-entry-unresolved');
    expect(thrown!.message).toContain(shim);
    expect(calls).toEqual([]);
  });

  it('Windows 上宿主递了读壳器:交给 node 的是壳里写的 JS 入口', async () => {
    const { context } = recordingContext('v24.14.0');
    const shim = 'C:\\gugu\\agents\\mise-bin\\pi.cmd';
    const entry = 'C:\\gugu\\agents\\pi\\dist\\cli.js';
    const resolved = await resolveSessionRuntimeCompatible({
      providerId: 'pi',
      surface: 'tui',
      descriptor: nodeRuntimeDescriptor(),
      executable: shim,
      executionContext: context,
      runtimeExecutable: 'C:\\node\\node.exe',
      platform: 'win32',
      windowsShimReader: {
        readShim: (p) => (p === shim ? '@echo off\r\nnode "%~dp0..\\pi\\dist\\cli.js" %*\r\n' : null),
        exists: (p) => p === entry,
      },
    });

    expect(resolved.executable).toBe(entry);
    expect(resolved.runtimeExecutable).toBe('C:\\node\\node.exe');
  });

  it('非 Windows、没递读壳器:harness 路径原样交出', async () => {
    const { context } = recordingContext('v24.14.0');
    const resolved = await resolveSessionRuntimeCompatible({
      providerId: 'pi',
      surface: 'tui',
      descriptor: nodeRuntimeDescriptor(),
      executable: '/opt/gugu/agents/mise-bin/pi',
      executionContext: context,
      runtimeExecutable: '/usr/local/bin/node',
      platform: 'darwin',
    });

    expect(resolved.executable).toBe('/opt/gugu/agents/mise-bin/pi');
    expect(resolved.runtimeExecutable).toBe('/usr/local/bin/node');
  });
});

describe('resolveSessionRuntimeCompatible — 版本号读法', () => {
  // mac1 上 Hermes 0.21.0 的 `--version` 原样(10-07):第一行是它自己的版本,后面还列 Python 与 OpenAI SDK。
  const HERMES_VERSION_OUTPUT = [
    'Hermes Agent v0.21.0 (2026.8.31) · upstream 88704223 · local ab9866bc (+1 carried commit)',
    'Install directory: /Users/u/.hermes/hermes-agent',
    'Install method: git',
    'Python: 3.11.16',
    'OpenAI SDK: 2.24.0',
  ].join('\n');
  const hermesDescriptor = {
    surfaces: ['acp'],
    sessionpage: { 'acp': { identity: 'addressable', messageTransport: 'router' } },
    runtimeCompatibility: { 'acp': { kind: 'semver-supported-floor', supportedFloor: '0.21.5', versionArgs: ['--version'] } },
    extension: { kind: 'none' },
  } as unknown as SessionBundleDescriptor;

  it('整段不止一个版本号:认第一行那个 —— 0.21.0 低于 0.21.5,带着两个数拒绝', async () => {
    const { context } = recordingContext(HERMES_VERSION_OUTPUT);
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'hermes', surface: 'acp', descriptor: hermesDescriptor, executable: '/u/.local/bin/hermes',
      executionContext: context,
    }).then(() => null, (error: unknown) => error as SessionRuntimeCompatibilityError);

    expect(thrown).toBeInstanceOf(SessionRuntimeCompatibilityError);
    expect(thrown!.code).toBe('runtime-version-unsupported');
    expect(thrown!.installedVersion).toBe('0.21.0');
    expect(thrown!.supportedFloor).toBe('0.21.5');
  });

  it('第一行也不止一个版本号:不猜,unparseable', async () => {
    const { context } = recordingContext('tool 1.2.3 (bundled 4.5.6)\nother 7.8.9');
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'hermes', surface: 'acp', descriptor: hermesDescriptor, executable: '/x',
      executionContext: context,
    }).then(() => null, (error: unknown) => error as SessionRuntimeCompatibilityError);

    expect(thrown!.code).toBe('runtime-version-unparseable');
  });
});

describe('resolveSessionRuntimeCompatible — POSIX 上咕咕自己的 sh 启动器 (10-07 mac1)', () => {
  // mac1 上托管 pi 1.0.4 的那条链原样:咕咕的启动器(mise-installer.ts 的 managedLauncher)→ aube 的 `.bin/pi` 壳 → cli.js。
  const launcher = '/u/gugu-home/agents/mise-bin/pi';
  const nodeDir = '/u/gugu-home/agents/mise/data/installs/node/24.21.0/bin';
  const pkg = '/u/gugu-home/agents/mise/data/installs/npm-earendil-works-pi-coding-agent/1.0.4/node_modules';
  const aubeShim = `${pkg}/.bin/pi`;
  const target = '.mise/@earendil-works+pi-coding-agent@1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const entry = `${pkg}/${target}`;
  const launcherText = `#!/bin/sh\n# gugu-release: 1.0.4\nPATH='${nodeDir}':"$PATH"\nexport PATH\nexec '${aubeShim}' "$@"\n`;
  const aubeShimText = [
    '#!/bin/sh',
    `# aube-bin-shim v2 target=../${target}`,
    'basedir=$(dirname "$link")',
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node" "$basedir/../${target}" "$@"`,
    'else',
    `  exec node "$basedir/../${target}" "$@"`,
    'fi',
    '',
  ].join('\n');
  const files: Record<string, string> = {
    [launcher]: launcherText, [aubeShim]: aubeShimText, [entry]: '#!/usr/bin/env node\n', [`${nodeDir}/node`]: '',
  };
  const reader = { readShim: (p: string) => files[p] ?? null, exists: (p: string) => p in files };

  it('交给 node 的是启动器 exec 的入口,解释器是启动器钉的那份 node(探的也是它)', async () => {
    const { context, calls } = recordingContext('v24.21.0');
    const resolved = await resolveSessionRuntimeCompatible({
      providerId: 'pi', surface: 'tui', descriptor: nodeRuntimeDescriptor(), executable: launcher,
      executionContext: context, platform: 'darwin', windowsShimReader: reader,
    });

    expect(resolved.executable).toBe(entry);
    expect(resolved.runtimeExecutable).toBe(`${nodeDir}/node`);
    expect(calls).toEqual([{ command: `${nodeDir}/node`, args: ['--version'] }]);
  });

  it('宿主指定了解释器(GUGU_NODE_BIN):解释器照它,入口照样换成 JS', async () => {
    const { context } = recordingContext('v24.14.0');
    const resolved = await resolveSessionRuntimeCompatible({
      providerId: 'pi', surface: 'tui', descriptor: nodeRuntimeDescriptor(), executable: launcher,
      executionContext: context, platform: 'darwin', windowsShimReader: reader, runtimeExecutable: '/opt/node/bin/node',
    });

    expect(resolved.executable).toBe(entry);
    expect(resolved.runtimeExecutable).toBe('/opt/node/bin/node');
  });

  it('用户自己装的 JS 入口(不是 sh 脚本):原样交出', async () => {
    const { context } = recordingContext('v24.14.0');
    const own = '/opt/homebrew/bin/pi';
    const resolved = await resolveSessionRuntimeCompatible({
      providerId: 'pi', surface: 'tui', descriptor: nodeRuntimeDescriptor(), executable: own,
      executionContext: context, platform: 'darwin', runtimeExecutable: '/opt/homebrew/bin/node',
      windowsShimReader: { readShim: (p) => (p === own ? '#!/usr/bin/env node\n' : null), exists: () => true },
    });

    expect(resolved.executable).toBe(own);
  });

  it('是 sh 脚本却读不出 exec 的入口:响亮失败,❌ 把脚本交给 node', async () => {
    const { context } = recordingContext('v24.14.0');
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'pi', surface: 'tui', descriptor: nodeRuntimeDescriptor(), executable: launcher,
      executionContext: context, platform: 'darwin', runtimeExecutable: '/opt/homebrew/bin/node',
      windowsShimReader: { readShim: () => '#!/bin/sh\necho hi\n', exists: () => true },
    }).then(() => null, (error: unknown) => error as SessionRuntimeCompatibilityError);

    expect(thrown).toBeInstanceOf(SessionRuntimeCompatibilityError);
    expect(thrown!.code).toBe('runtime-entry-unresolved');
  });

  it('aube 壳自报的目标不在盘上:同样响亮失败', async () => {
    const { context } = recordingContext('v24.14.0');
    const withoutEntry = Object.fromEntries(Object.entries(files).filter(([p]) => p !== entry));
    const thrown = await resolveSessionRuntimeCompatible({
      providerId: 'pi', surface: 'tui', descriptor: nodeRuntimeDescriptor(), executable: launcher,
      executionContext: context, platform: 'darwin',
      windowsShimReader: { readShim: (p) => withoutEntry[p] ?? null, exists: (p) => p in withoutEntry },
    }).then(() => null, (error: unknown) => error as SessionRuntimeCompatibilityError);

    expect(thrown!.code).toBe('runtime-entry-unresolved');
  });
});
