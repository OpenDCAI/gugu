import type { HostDependencySelection } from '@gugu/session-core/deps/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IHostDependencyStore } from '@main/core/dependencies/host-dependency-store';

const resolveCommandPathMock = vi.hoisted(() =>
  vi.fn<(command: string, ctx?: unknown) => Promise<string | null>>().mockResolvedValue(null)
);

vi.mock('@gugu/session-core/deps/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/session-core/deps/runtime')>()),
  resolveCommandPath: resolveCommandPathMock,
}));

const existsSyncMock = vi.hoisted(() => vi.fn<(target: string) => boolean>().mockReturnValue(false));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = { ...actual, existsSync: existsSyncMock };
  return { ...patched, default: patched };
});

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const {
  resolveAgentExecutable,
  clearResolvedPathCache,
  HarnessNotInstalledError,
  HarnessUpdatingError,
} = await import('./resolve-agent-executable');

const ctx = {} as never;

function makeStore(selection: HostDependencySelection | null = null): IHostDependencyStore {
  return {
    getSelection: vi.fn().mockResolvedValue(selection),
    setSelection: vi.fn().mockResolvedValue(undefined),
  };
}

type ResolveExecutableArgs = Parameters<typeof resolveAgentExecutable>[0];

function resolveExecutable(
  overrides: Partial<ResolveExecutableArgs> = {}
): ReturnType<typeof resolveAgentExecutable> {
  return resolveAgentExecutable({
    providerId: 'claude',
    binaryName: 'claude',
    ctx,
    hostDependencyStore: makeStore(),
    ...overrides,
  } as ResolveExecutableArgs);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveCommandPathMock.mockResolvedValue(null);
  clearResolvedPathCache('claude');
  clearResolvedPathCache('codex');
  clearResolvedPathCache('unknown');
});

describe('resolveAgentExecutable', () => {
  /**
   * #6335:终端腿跑伴随程序(`antigravity-cli` / `agy`)时,「用哪一份」按**那一行**的选择读,
   * 缓存也按那一行记 —— 主程序(聊天面板腿)的选择与缓存不能串过来。报错仍记在插件名下。
   */
  describe('伴随程序(dependencyId)', () => {
    it('按伴随程序那一行读选择,PATH 上找它自己的二进制名', async () => {
      const store = makeStore({ kind: 'path', path: '/opt/agy' });
      resolveCommandPathMock.mockImplementation(async (command) => (command === '/opt/agy' ? '/opt/agy' : null));
      await expect(resolveExecutable({
        providerId: 'antigravity', dependencyId: 'antigravity-cli', binaryName: 'agy', hostDependencyStore: store,
      })).resolves.toBe('/opt/agy');
      expect(store.getSelection).toHaveBeenCalledWith('local', 'antigravity-cli');
    });

    it('两个程序的解析缓存互不串:主程序缓存的路径不会被终端腿拿去跑', async () => {
      resolveCommandPathMock.mockImplementation(async (command) => (command === 'agy_acp_server' ? '/bin/agy_acp_server' : null));
      await expect(resolveExecutable({ providerId: 'antigravity', binaryName: 'agy_acp_server' })).resolves.toBe('/bin/agy_acp_server');
      const failure = resolveExecutable({ providerId: 'antigravity', dependencyId: 'antigravity-cli', binaryName: 'agy' });
      await expect(failure).rejects.toBeInstanceOf(HarnessNotInstalledError);
      await expect(failure).rejects.toMatchObject({ providerId: 'antigravity', harnessName: 'agy' });
      clearResolvedPathCache('antigravity');
    });
  });

  describe('auto resolution', () => {
    it('replaces an extensionless cached Windows npm shim during live resolution', async () => {
      const cachedShim = String.raw`C:\Users\tester\AppData\Roaming\npm\codex`;
      const cmdLauncher = String.raw`C:\Users\tester\AppData\Roaming\npm\codex.cmd`;
      resolveCommandPathMock.mockResolvedValueOnce(null).mockResolvedValueOnce(cmdLauncher);

      const result = await resolveExecutable({
        providerId: 'codex',
        binaryName: 'codex',
        ctx,
        hostDependencyStore: makeStore(null),
        cachedStatePath: cachedShim,
      });

      expect(result).toBe(cmdLauncher);
      expect(resolveCommandPathMock).toHaveBeenCalledWith(cachedShim, ctx);
      expect(resolveCommandPathMock).toHaveBeenCalledWith('codex', ctx);
    });

    it('accepts an absolute cli selection on Windows without running `test`, which Windows lacks', async () => {
      const selected = String.raw`C:\Users\tester\.local\bin\claude.exe`;
      const exec = vi.fn().mockRejectedValue(new Error('spawn test ENOENT'));
      resolveCommandPathMock.mockResolvedValue(selected);
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const result = await resolveExecutable({
          ctx: { exec } as never,
          hostDependencyStore: makeStore({ kind: 'cli', command: selected } as HostDependencySelection),
        });
        expect(result).toBe(selected);
        expect(exec).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    it('手动指定的 wrapper(命令名)就是启动用的那一份', async () => {
      // #6098 的验收面:`reclaude` 这类 wrapper 是一个**命令名**,不是路径 —— 它必须能被
      // 选中、存下来,并且启动时真的跑它。
      const wrapper = '/Users/tester/.local/bin/reclaude';
      resolveCommandPathMock.mockImplementation(async (command: string) =>
        command === 'reclaude' ? wrapper : '/usr/local/bin/claude',
      );

      const result = await resolveExecutable({
        hostDependencyStore: makeStore({ kind: 'cli', command: 'reclaude' } as HostDependencySelection),
      });

      expect(result).toBe(wrapper);
      expect(resolveCommandPathMock).toHaveBeenCalledWith('reclaude', ctx);
      // ❌ 不许再去解析 harness 本名:那就是「面板上选的是 reclaude,跑的是 claude」。
      expect(resolveCommandPathMock).not.toHaveBeenCalledWith('claude', ctx);
    });

    it('wrapper 不在 PATH 上时响亮失败,❌ 不静默回落到 PATH 里的那一份', async () => {
      // 阳控:`claude` 这条是解析得到的(下一行的 mock 就返回它),所以「没回落」不是因为
      // 根本没有可回落的东西。
      resolveCommandPathMock.mockImplementation(async (command: string) =>
        command === 'reclaude' ? null : '/usr/local/bin/claude',
      );

      await expect(
        resolveExecutable({
          hostDependencyStore: makeStore({ kind: 'cli', command: 'reclaude' } as HostDependencySelection),
        }),
      ).rejects.toThrow(/selected command "reclaude" was not found/);
    });

    it('fails loudly when automatic resolution finds no harness', async () => {
      resolveCommandPathMock.mockResolvedValue(null);
      await expect(resolveExecutable()).rejects.toThrow(
        'claude not installed: Could not resolve harness "claude" before spawn.\n'
        + 'Checked:\n'
        + '  - PATH lookup: claude\n'
        + 'Fix: install the claude CLI, add it to the Desktop App PATH, or choose a valid executable path in agent settings, then retry.'
      );
    });

  });

});

describe('classifying a resolution failure', () => {
  const localCtx = { supportsLocalSpawn: true } as never;
  const remoteCtx = { supportsLocalSpawn: false } as never;

  async function resolveWith(execCtx: never) {
    return resolveAgentExecutable({
      providerId: 'claude',
      binaryName: 'claude',
      ctx: execCtx,
      hostDependencyStore: makeStore(),
      cachedStatePath: '/usr/local/bin/claude',
    });
  }

  it('reports a harness that is still on disk as updating, not missing', async () => {
    resolveCommandPathMock.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(true);

    await expect(resolveWith(localCtx)).rejects.toBeInstanceOf(HarnessUpdatingError);
    expect(existsSyncMock).toHaveBeenCalledWith('/usr/local/bin/claude');
  });

  it('reports a harness with nothing left at any remembered location as missing', async () => {
    resolveCommandPathMock.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(false);

    await expect(resolveWith(localCtx)).rejects.toBeInstanceOf(HarnessNotInstalledError);
  });

  it('does not guess about a remote host even when a local path of the same name exists', async () => {
    resolveCommandPathMock.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(true);

    await expect(resolveWith(remoteCtx)).rejects.toBeInstanceOf(HarnessNotInstalledError);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});
