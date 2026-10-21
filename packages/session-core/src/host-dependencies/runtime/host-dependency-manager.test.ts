import { err, ok } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { HostDependencyManager } from './host-dependency-manager';
import type { InstallMethodDetector } from './method-detection';
import { nextHostDependency, probeAndSettle } from './test-support';
import { normalizeSelection } from './types';
import type { DependencyDescriptor, InstallRecord, Provenance } from './types';

const TEST_DEPENDENCIES: DependencyDescriptor[] = [
  {
    id: 'git',
    name: 'Git',
    category: 'core',
    commands: ['git'],
    versionArgs: ['--version'],
    docUrl: 'https://git-scm.com',
  },
  {
    id: 'codex',
    name: 'Codex',
    category: 'agent',
    commands: ['codex'],
    versionArgs: ['--version'],
    docUrl: 'https://openai.com',
    installCommands: {
      macos: [
        { method: 'npm', command: 'npm install -g @openai/codex', recommended: true },
        { method: 'curl', command: 'install codex via curl' },
        {
          method: 'npm',
          registry: 'npmmirror',
          command: 'npm install -g --registry=https://registry.npmmirror.com @openai/codex',
        },
      ],
      linux: [
        { method: 'npm', command: 'npm install -g @openai/codex', recommended: true },
        { method: 'curl', command: 'install codex via curl' },
        {
          method: 'npm',
          registry: 'npmmirror',
          command: 'npm install -g --registry=https://registry.npmmirror.com @openai/codex',
        },
      ],
      windows: [
        { method: 'npm', command: 'npm install -g @openai/codex', recommended: true },
        { method: 'curl', command: 'install codex via curl' },
        {
          method: 'npm',
          registry: 'npmmirror',
          command: 'npm install -g --registry=https://registry.npmmirror.com @openai/codex',
        },
      ],
    },
    updates: {
      kind: 'supported',
      releaseSource: { kind: 'npm', package: '@openai/codex' },
      update: { kind: 'package-manager' },
    },
  },
  {
    // 只测 `skipVersionProbe` 这一格的**合成** dependency —— ❌ 别换成某个真家的 id:
    // 这条用例要的是「声明了跳过版本探测的依赖不会被执行」,与哪家在册无关。
    // (2026-09-21 #6097:上一版借的是 letta,那一家的插件被删掉后这里就成了指向不存在的家。)
    id: 'path-only-agent',
    name: 'Path Only Agent',
    category: 'agent',
    commands: ['path-only-agent'],
    skipVersionProbe: true,
    versionArgs: ['--version'],
    docUrl: 'https://example.invalid/path-only-agent',
  },
];

/** 提到模块作用域:卸载相关的用例分散在两个 describe 里,都要用它。 */
const UNINSTALL_DEPENDENCIES: typeof TEST_DEPENDENCIES = [
  ...TEST_DEPENDENCIES,
  {
    id: 'codex-pm',
    name: 'Codex (package-manager uninstall)',
    category: 'agent',
    commands: ['codex'],
    versionArgs: ['--version'],
    docUrl: 'https://openai.com',
    installCommands: {
      macos: [
        {
          method: 'npm',
          command: 'npm install -g @openai/codex',
          recommended: true,
          uninstallCommand: 'npm uninstall -g @openai/codex',
        },
      ],
      linux: [
        {
          method: 'npm',
          command: 'npm install -g @openai/codex',
          recommended: true,
          uninstallCommand: 'npm uninstall -g @openai/codex',
        },
      ],
      windows: [
        {
          method: 'npm',
          command: 'npm install -g @openai/codex',
          recommended: true,
          uninstallCommand: 'npm uninstall -g @openai/codex',
        },
      ],
    },
    updates: {
      kind: 'supported',
      releaseSource: { kind: 'npm', package: '@openai/codex' },
      update: { kind: 'package-manager' },
    },
    uninstall: { kind: 'package-manager' },
  },
  {
    id: 'codex-pm-no-cmd',
    name: 'Codex (package-manager, no uninstallCommand)',
    category: 'agent',
    commands: ['codex'],
    versionArgs: ['--version'],
    installCommands: {
      macos: [{ method: 'npm', command: 'npm install -g @openai/codex', recommended: true }],
    },
    updates: { kind: 'none' },
    uninstall: { kind: 'package-manager' },
  },
];

function makeCtx(
  handler: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
  options: {
    refreshShellEnv?: () => Promise<void>;
  } = {},
): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn().mockImplementation(handler),
    refreshShellEnv: options.refreshShellEnv
      ? vi.fn().mockImplementation(options.refreshShellEnv)
      : undefined,
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
}

const missingCtx = makeCtx(async () => {
  throw new Error('missing');
});

/**
 * A detector stub that always returns unknown/inferred provenance.
 * Used in tests to avoid live brew/npm queries and keep assertions deterministic.
 */
const unknownDetector: InstallMethodDetector = {
  detect: async (): Promise<Provenance> => ({ kind: 'unknown', confidence: 'inferred' }),
  invalidate: () => {},
};

/**
 * A detector stub that returns npm confirmed provenance.
 * Used for tests verifying npm-confirmed manageable installs.
 */
const npmDetector: InstallMethodDetector = {
  detect: async (): Promise<Provenance> => ({
    kind: 'npm',
    confidence: 'confirmed',
    managerRef: '@openai/codex',
  }),
  invalidate: () => {},
};

/**
 * 咕咕自己装的那一份 —— 落在咕咕自己的安装根里,所以带 `ours`。
 * 这是「归咕咕管」的**唯一**判据;上面那个 npmDetector 是 confirmed 但不是咕咕装的。
 */
const oursDetector: InstallMethodDetector = {
  detect: async (): Promise<Provenance> => ({
    kind: 'npm',
    confidence: 'confirmed',
    ours: true,
  }),
  invalidate: () => {},
};

/**
 * Path heuristics can infer npm from a `node_modules` segment without a package manager proving
 * ownership. The manager must still allow an npm update, while refusing to record that guessed
 * copy as an owned install.
 */
const npmInferredDetector: InstallMethodDetector = {
  detect: async (): Promise<Provenance> => ({ kind: 'npm', confidence: 'inferred' }),
  invalidate: () => {},
};

const availableCtx = makeCtx(async (command, args = []) => {
  if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
    return { stdout: '/bin/codex\n', stderr: '' };
  }
  if (command === 'which' && args[0] === 'codex') {
    return { stdout: '/bin/codex\n', stderr: '' };
  }
  if (command === 'realpath') {
    return { stdout: `${args[0]}\n`, stderr: '' };
  }
  if (command === '/bin/codex' && args[0] === '--version') {
    return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
  }
  throw new Error('missing');
});

describe('HostDependencyManager cached path invalidation', () => {
  it('detects an available binary removed from PATH and one restored later', async () => {
    let present = true;
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === 'codex') {
        if (!present) throw new Error('missing');
        return { stdout: '/bin/codex\n', stderr: '' };
      }
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        if (!present) throw new Error('missing');
        return { stdout: '/bin/codex\n', stderr: '' };
      }
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === '/bin/codex' && args[0] === '--version') {
        return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      }
      throw new Error('missing');
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });

    await manager.probe('codex');
    expect(await manager.isPathResolutionConsistent('codex')).toBe(true);

    present = false;
    expect(await manager.isPathResolutionConsistent('codex')).toBe(false);

    present = true;
    expect(await manager.isPathResolutionConsistent('codex')).toBe(true);
  });
});

describe('HostDependencyManager probe env (#6186)', () => {
  const copilotLike = [{ ...TEST_DEPENDENCIES.find((d) => d.id === 'codex')!, probeEnv: { COPILOT_AUTO_UPDATE: 'false' } }];
  const versionCtx = (supportsLocalSpawn: boolean) => {
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which') return { stdout: '/bin/codex\n', stderr: '' };
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === '/bin/codex' && args[0] === '--version') return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      throw new Error('missing');
    });
    (ctx as { supportsLocalSpawn: boolean }).supportsLocalSpawn = supportsLocalSpawn;
    return ctx;
  };
  const probeEnvs = (ctx: IExecutionContext) =>
    (ctx.exec as ReturnType<typeof vi.fn>).mock.calls
      .filter(([command, args]) => command === '/bin/codex' && args[0] === '--version')
      .map(([, , opts]) => (opts as { env?: Record<string, string> }).env);

  it('lays the descriptor switch over the caller env on every local version probe', async () => {
    const ctx = versionCtx(true);
    const manager = new HostDependencyManager(ctx, {
      dependencies: copilotLike,
      installMethodDetector: unknownDetector,
      resolveProbeEnv: async () => ({ PATH: '/caller/bin', COPILOT_AUTO_UPDATE: 'true' }),
    });
    await manager.probe('codex');
    const envs = probeEnvs(ctx);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) expect(env).toMatchObject({ PATH: '/caller/bin', COPILOT_AUTO_UPDATE: 'false' });
  });

  it('starts from the inherited env when the caller gives none (worker probes)', async () => {
    const ctx = versionCtx(true);
    const manager = new HostDependencyManager(ctx, { dependencies: copilotLike, installMethodDetector: unknownDetector });
    await manager.probe('codex');
    for (const env of probeEnvs(ctx)) {
      expect(env?.COPILOT_AUTO_UPDATE).toBe('false');
      expect(env?.PATH).toBe(process.env.PATH);
    }
  });

  it('passes no per-call env where the context cannot carry one (SSH)', async () => {
    const ctx = versionCtx(false);
    const manager = new HostDependencyManager(ctx, { dependencies: copilotLike, installMethodDetector: unknownDetector });
    await manager.probe('codex');
    expect(probeEnvs(ctx).every((env) => env === undefined)).toBe(true);
  });
});

describe('HostDependencyManager install', () => {
  it('uses a per-call install runner when provided', async () => {
    const defaultRunner = vi.fn(async () =>
      err({
        type: 'command-failed' as const,
        message: 'default runner should not be called',
        output: '',
        exitCode: 1,
      }),
    );
    const perCallRunner = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand: defaultRunner,
    });

    const result = await manager.install('codex', undefined, { run: perCallRunner });

    expect(perCallRunner).toHaveBeenCalledWith('npm install -g @openai/codex');
    expect(defaultRunner).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: { type: 'not-detected-after-install', id: 'codex' },
    });
  });

  /**
   * 下载那一段失败 ⇒ 换下一个源重试一次(#6157)。
   *
   * 源的先后由应用层测速排出来(`install-source-race.ts`),这一层只按给定顺序试 ——
   * 所以这里喂的是一个写死的顺序,判的是「它会不会换、换几次、换到哪一条」。
   */
  describe('下载失败换源重试一次', () => {
    const twoSources: DependencyDescriptor[] = [
      {
        id: 'codex',
        name: 'Codex',
        category: 'agent',
        commands: ['codex'],
        versionArgs: ['--version'],
        installCommands: {
          macos: [
            { method: 'npm', registry: 'alpha', command: 'install --registry=alpha', recommended: true },
            { method: 'npm', registry: 'beta', command: 'install --registry=beta' },
          ],
        },
      },
    ];

    function manager(run: ReturnType<typeof vi.fn>) {
      return new HostDependencyManager(missingCtx, {
        dependencies: twoSources,
        platform: 'macos',
        runInstallCommand: run as never,
      });
    }

    it('第一个源在下载那一段挂了 ⇒ 用第二个源再来一次', async () => {
      const run = vi.fn(async (command: string) =>
        command.includes('alpha')
          ? err({ type: 'command-failed' as const, message: 'boom', output: 'sha512 mismatch', stage: 'download' })
          : ok<void>(),
      );
      await manager(run).install('codex', undefined, { registries: ['alpha', 'beta'] });

      expect(run.mock.calls.map((call) => call[0])).toEqual([
        'install --registry=alpha',
        'install --registry=beta',
      ]);
    });

    it('阴控:装完之后才挂的失败不换源 —— 换了也一样', async () => {
      // 没有这一条,上面那条绿也可能只是因为「失败就无脑重试」。启动器写不进去、版本对不上
      // 这类失败与源无关,再下一遍只是把同一件事做两遍。
      const run = vi.fn(async () =>
        err({ type: 'command-failed' as const, message: 'boom', output: 'launcher publish failed' }),
      );
      const result = await manager(run).install('codex', undefined, { registries: ['alpha', 'beta'] });

      expect(run).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it('取消不重试 —— 用户按的是取消', async () => {
      const run = vi.fn(async () =>
        err({ type: 'cancelled' as const, message: 'Installation cancelled.', output: '', stage: 'download' }),
      );
      await manager(run).install('codex', undefined, { registries: ['alpha', 'beta'] });

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('只重试一次 —— 三个候选也只试前两个', async () => {
      const run = vi.fn(async () =>
        err({ type: 'stalled' as const, message: 'no progress', output: '', idleMs: 60_000, stage: 'download' }),
      );
      await manager(run).install('codex', undefined, { registries: ['alpha', 'beta', 'alpha'] });

      expect(run).toHaveBeenCalledTimes(2);
    });

    it('用户在高级里指名了源就只试那一个 —— ❌ 不许悄悄换成别的', async () => {
      const run = vi.fn(async (command: string) =>
        err({ type: 'command-failed' as const, message: 'boom', output: command, stage: 'download' }),
      );
      await manager(run).install('codex', undefined, {
        registry: 'beta',
        registries: ['alpha', 'beta'],
      });

      expect(run.mock.calls.map((call) => call[0])).toEqual(['install --registry=beta']);
    });
  });

  it('returns an error result for unknown dependency ids', async () => {
    const manager = new HostDependencyManager(missingCtx, { dependencies: TEST_DEPENDENCIES });

    const result = await manager.install('missing-agent');

    expect(result).toEqual({
      success: false,
      error: { type: 'unknown-dependency', id: 'missing-agent' },
    });
  });

  it('returns an error result when no install command is configured', async () => {
    const manager = new HostDependencyManager(missingCtx, { dependencies: TEST_DEPENDENCIES });

    const result = await manager.install('git');

    expect(result).toEqual({
      success: false,
      error: { type: 'no-install-command', id: 'git' },
    });
  });

  it('returns runner errors without probing again', async () => {
    const runInstallCommand = vi.fn(async () =>
      err({
        type: 'permission-denied' as const,
        message: 'User does not have sufficient permissions.',
        output: 'permission denied',
        exitCode: 243,
      }),
    );
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: unknownDetector,
    });

    const result = await manager.install('codex');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('permission-denied');
  });

  it('returns the available dependency state on successful install and probe', async () => {
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand: async () => ok<void>(),
      installMethodDetector: unknownDetector,
    });

    const result = await manager.install('codex');

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('available');
  });

  it('skips version probes for dependencies configured as path-only', async () => {
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === 'path-only-agent') {
        return { stdout: '/bin/path-only-agent\n', stderr: '' };
      }
      if (command === 'which' && args[0] === '-a' && args[1] === 'path-only-agent') {
        return { stdout: '/bin/path-only-agent\n', stderr: '' };
      }
      if (command === '/bin/path-only-agent') {
        throw new Error('path-only-agent should not be executed during dependency probing');
      }
      // Allow realpath and brew/npm queries that arise from async enumeration;
      // they are handled gracefully (caught) and are not the focus of this test.
      return { stdout: '', stderr: '' };
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });

    const result = await manager.probe('path-only-agent');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'path-only-agent',
        status: 'available',
        path: '/bin/path-only-agent',
        version: null,
      }),
    );
    // Primary path-resolution which must happen synchronously.
    expect(ctx.exec).toHaveBeenCalledWith('which', ['path-only-agent'], { timeout: 5000 });
    // The binary itself must never be executed during dependency probing.
    expect(ctx.exec).not.toHaveBeenCalledWith('/bin/path-only-agent', expect.anything(), expect.anything());
  });

  it('不执行的家,版本读宿主给的发行标记 —— 状态与每一份副本都带上它(#6335)', async () => {
    // ACP 注册表那一形态:执行一次就是起一个服务,所以版本不能跑出来;咕咕写进启动器的那一行才是读数。
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && (args[0] === 'path-only-agent' || args[1] === 'path-only-agent')) {
        return { stdout: '/bin/path-only-agent\n', stderr: '' };
      }
      if (command === '/bin/path-only-agent') throw new Error('must not execute');
      return { stdout: '', stderr: '' };
    });
    const readManagedVersion = vi.fn(async (path: string) => (path === '/bin/path-only-agent' ? '1.1.1' : null));
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
      readManagedVersion,
    });

    const built = nextHostDependency(manager, 'path-only-agent');
    const result = await manager.probe('path-only-agent');

    expect(result).toEqual(expect.objectContaining({ status: 'available', version: '1.1.1' }));
    await built;
    expect(manager.getHostDependency('path-only-agent')?.installations[0]?.version).toBe('1.1.1');
    expect(ctx.exec).not.toHaveBeenCalledWith('/bin/path-only-agent', expect.anything(), expect.anything());
  });

  it('发行标记读挂了就是「不知道」,❌ 不拖垮探测', async () => {
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && (args[0] === 'path-only-agent' || args[1] === 'path-only-agent')) {
        return { stdout: '/bin/path-only-agent\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
      readManagedVersion: async () => { throw new Error('EACCES'); },
    });

    await expect(manager.probe('path-only-agent')).resolves.toEqual(
      expect.objectContaining({ status: 'available', version: null }),
    );
  });

  it('fires onStatusUpdated with the SSH connection id', async () => {
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      connectionId: 'ssh-1',
      installMethodDetector: unknownDetector,
    });
    const listener = vi.fn();
    manager.onStatusUpdated.subscribe(listener);

    await manager.probe('codex');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'codex',
        connectionId: 'ssh-1',
        state: expect.objectContaining({ id: 'codex', status: 'available' }),
      }),
    );
  });

  it('builds host dependency installation state for core dependencies', async () => {
    const gitCtx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'git') {
        return { stdout: '/opt/homebrew/bin/git\n', stderr: '' };
      }
      if (command === 'which' && args[0] === 'git') {
        return { stdout: '/opt/homebrew/bin/git\n', stderr: '' };
      }
      if (command === 'realpath') {
        return { stdout: `${args[0]}\n`, stderr: '' };
      }
      if (command === '/opt/homebrew/bin/git' && args[0] === '--version') {
        return { stdout: 'git version 2.45.0\n', stderr: '' };
      }
      throw new Error('missing');
    });
    const manager = new HostDependencyManager(gitCtx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });
    const events: unknown[] = [];
    manager.onStatusUpdated.subscribe((event) => events.push(event));

    await probeAndSettle(manager, 'git');

    const hostDependency = manager.getHostDependency('git');
    expect(hostDependency).toEqual(
      expect.objectContaining({
        dependencyId: 'git',
        installations: [
          expect.objectContaining({
            pathEntry: '/opt/homebrew/bin/git',
            status: 'available',
            version: '2.45.0',
          }),
        ],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        id: 'git',
        hostDependency: expect.objectContaining({ dependencyId: 'git' }),
      }),
    );
  });
});

describe('HostDependencyManager update', () => {
  it('returns no-update-strategy for a core dependency without updates', async () => {
    const manager = new HostDependencyManager(missingCtx, { dependencies: TEST_DEPENDENCIES });
    const result = await manager.update('git');
    expect(result).toEqual({ success: false, error: { type: 'no-update-strategy', id: 'git' } });
  });

  it('runs the install command for a package-manager update strategy', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: npmDetector,
    });

    const result = await manager.update('codex');

    // codex uses package-manager strategy; npm provenance → npm install command
    expect(runInstallCommand).toHaveBeenCalledWith('npm install -g @openai/codex');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('available');
  });

});

describe('HostDependencyManager uninstall', () => {
  it('returns no-uninstall-strategy when strategy is none', async () => {
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: UNINSTALL_DEPENDENCIES,
    });
    // 'git' has no uninstall field (undefined → treated as none)
    const result = await manager.uninstall('git');
    expect(result).toEqual({
      success: false,
      error: { type: 'no-uninstall-strategy', id: 'git' },
    });
  });

  it('returns no-uninstall-command when strategy is package-manager but the option has no uninstallCommand', async () => {
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: UNINSTALL_DEPENDENCIES,
    });
    const result = await manager.uninstall('codex-pm-no-cmd');
    expect(result).toEqual({
      success: false,
      error: { type: 'no-uninstall-command', id: 'codex-pm-no-cmd' },
    });
  });

  it('runs the uninstallCommand for package-manager strategy and re-probes', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: UNINSTALL_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: npmDetector,
    });

    const result = await manager.uninstall('codex-pm');

    expect(runInstallCommand).toHaveBeenCalledWith('npm uninstall -g @openai/codex');
    // After uninstall the binary is gone → status is 'missing', which is success
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('missing');
  });

  it.each([true, false])('verifies removal of the selected copy while another copy remains (removed=%s)', async (remove) => {
    let removed = false;
    const owned = '/managed/codex';
    const other = '/user/codex';
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === 'which') {
        const name = args.at(-1);
        if (name === owned) {
          if (removed) throw new Error('missing');
          return { stdout: owned, stderr: '' };
        }
        if (name === 'codex') return { stdout: args[0] === '-a'
          ? `${removed ? '' : owned + '\n'}${other}` : removed ? other : owned, stderr: '' };
      }
      if (command === other || (command === owned && !removed)) return { stdout: 'codex-cli 1.0.0', stderr: '' };
      throw new Error('missing');
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: UNINSTALL_DEPENDENCIES,
      runInstallCommand: async () => { removed = remove; return ok(); },
      getSelection: async () => ({ kind: 'pinned', realpath: owned }),
      installMethodDetector: {
        detect: async (realpath) => ({ kind: 'npm', confidence: 'confirmed', ours: realpath === owned }),
        invalidate: () => {},
      },
    });
    await probeAndSettle(manager, 'codex-pm');
    expect(manager.getHostDependency('codex-pm')?.installations).toHaveLength(2);
    const result = await manager.uninstall('codex-pm');
    expect(result.success).toBe(remove);
    if (!result.success) expect(result.error.type).toBe('still-present');
  });

});

describe('HostDependencyManager — 更新 / 卸载动的永远是咕咕那份', () => {
  it('在用的是用户自己那份时,卸载咕咕那份照样成功,且只动咕咕那份(owner 2026-09-23:「codex 咕咕装的卸载不掉」)', async () => {
    let removed = false;
    const owned = '/managed/codex';
    const user = '/opt/homebrew/bin/codex';
    const ran: string[] = [];
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === 'which') {
        const name = args.at(-1);
        if (name === owned) {
          if (removed) throw new Error('missing');
          return { stdout: owned, stderr: '' };
        }
        // 用户那份排在 PATH 前面 = 「自动」选中它。
        if (name === 'codex') return { stdout: args[0] === '-a' ? `${user}\n${removed ? '' : owned}` : user, stderr: '' };
      }
      if (command === user || (command === owned && !removed)) return { stdout: 'codex-cli 1.0.0', stderr: '' };
      throw new Error('missing');
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: UNINSTALL_DEPENDENCIES,
      runInstallCommand: async (cmd: string) => { ran.push(cmd); removed = true; return ok(); },
      getSelection: async () => null, // 在用:本机找到的(用户那份)
      installMethodDetector: {
        detect: async (realpath) => ({ kind: 'npm', confidence: 'confirmed', ours: realpath === owned }),
        invalidate: () => {},
      },
    });
    await probeAndSettle(manager, 'codex-pm');
    expect(manager.getHostDependency('codex-pm')?.installations).toHaveLength(2);

    const result = await manager.uninstall('codex-pm');

    expect(result.success).toBe(true);
    expect(ran).toEqual(['npm uninstall -g @openai/codex']);
  });
});

describe('HostDependencyManager unknown install source', () => {
  // A path that won't match any location hint so detector returns unknown provenance
  const UNKNOWN_PATH = '/opt/custom-shims/codex';

  /**
   * `getVersion` is read on every probe, so a test can let the update actually move the version
   * (a working update) or hold it still (the #4271 failure: the command wrote a copy that is not
   * the one answering on PATH).
   */
  const makeUnknownCtx = (getVersion: () => string) =>
    makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        return { stdout: `${UNKNOWN_PATH}\n`, stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: `${UNKNOWN_PATH}\n`, stderr: '' };
      }
      if (command === 'realpath') {
        return { stdout: `${UNKNOWN_PATH}\n`, stderr: '' };
      }
      if (command === UNKNOWN_PATH && args[0] === '--version') {
        return { stdout: `codex-cli ${getVersion()}\n`, stderr: '' };
      }
      throw new Error('missing');
    });

  const unknownCtx = makeUnknownCtx(() => '1.0.0');

  it('emits installation with unknown provenance when method inference fails', async () => {
    const manager = new HostDependencyManager(unknownCtx, {
      dependencies: TEST_DEPENDENCIES,
      connectionId: 'local',
      installMethodDetector: unknownDetector,
    });
    const events: unknown[] = [];
    manager.onStatusUpdated.subscribe((e) => events.push(e));

    await probeAndSettle(manager, 'codex');

    const hostDepEvent = (events as Array<{ hostDependency?: unknown }>).find(
      (e) => e.hostDependency !== undefined,
    );
    expect(hostDepEvent).toBeDefined();

    const hostDep = (
      hostDepEvent as {
        hostDependency: {
          installations: Array<{
            realpath: string;
            isActive: boolean;
            manageable: boolean;
            provenance: Provenance;
          }>;
        };
      }
    ).hostDependency;

    const activeInst = hostDep.installations.find((i) => i.isActive);
    expect(activeInst).toBeDefined();
    expect(activeInst?.realpath).toBe(UNKNOWN_PATH);
    expect(activeInst?.provenance.kind).toBe('unknown');
    expect(activeInst?.provenance.confidence).toBe('inferred');
    // unknown provenance + package-manager strategy → not manageable
    expect(activeInst?.manageable).toBe(false);
  });

  it('refuses package-manager update when provenance is unknown (not manageable)', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(unknownCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: unknownDetector,
    });

    await probeAndSettle(manager, 'codex');

    const result = await manager.update('codex');

    expect(result).toEqual({
      success: false,
      error: { type: 'no-update-strategy', id: 'codex' },
    });
    expect(runInstallCommand).not.toHaveBeenCalled();
  });

  /**
   * 咕咕只维护自己装的那一份(product spec)。
   * 「能确认是 npm 装的」不等于「是咕咕装的」—— 用户自己的 npm 全局根、brew 的 cellar
   * 同样是 confirmed。拿 confirmed 当判据,咕咕就会去动别人的副本。#4271
   */
  it('别人装的不归咕咕更新 —— 哪怕能确认它是 npm 装的', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeUnknownCtx(() => '1.0.0'), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: npmDetector,
    });

    await probeAndSettle(manager, 'codex');

    const result = await manager.update('codex');

    expect(result).toEqual({
      success: false,
      error: { type: 'no-update-strategy', id: 'codex' },
    });
    expect(runInstallCommand).not.toHaveBeenCalled();
  });

  it('咕咕自己装的那一份照常更新', async () => {
    let version = '1.0.0';
    const runInstallCommand = vi.fn(async () => {
      version = '1.1.0';
      return ok<void>();
    });
    const manager = new HostDependencyManager(makeUnknownCtx(() => version), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursDetector,
    });

    await probeAndSettle(manager, 'codex');

    const result = await manager.update('codex');

    expect(runInstallCommand).toHaveBeenCalledWith('npm install -g @openai/codex');
    expect(result.success).toBe(true);
  });

  /**
   * 曾经这条用例主张「猜出来的来源不构成拒绝 —— 认不出是谁装的是我们的无知,不是缺能力」。
   * 那个论证被 owner 推翻了:技术上确实无关,**责任上是一件事**。
   *
   * 真机后果(#4271,owner 机器):一份独立安装器铺在 `~/.local/share/codex/<版本>/node_modules/`
   * 的副本,因为 realpath 里有 `node_modules` 字样被猜成 npm 装的,于是拿到更新按钮;点下去
   * npm 去的是另一个 package root、撞上别人的文件、EEXIST,而报错还让用户「到更换来源里选
   * 那一份」—— 他选的就是那一份。
   */
  it('猜出来的来源更不构成「归咕咕管」', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeUnknownCtx(() => '1.0.0'), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: npmInferredDetector,
    });

    await probeAndSettle(manager, 'codex');

    const result = await manager.update('codex');

    expect(result).toEqual({
      success: false,
      error: { type: 'no-update-strategy', id: 'codex' },
    });
    expect(runInstallCommand).not.toHaveBeenCalled();
  });

  /**
   * The other half of #4271: opening the update path back up must not bring back "updated
   * successfully" while the version on PATH never moved. The command exits 0, the new bytes land
   * in some prefix, and the copy that answers is still the old one — that is a failure, and it is
   * decidable without knowing where anything was written.
   */
  it('fails loud when the update ran but the version in effect never moved (#4271)', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(unknownCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursDetector,
    });

    await probeAndSettle(manager, 'codex');

    const result = await manager.update('codex');

    expect(runInstallCommand).toHaveBeenCalledWith('npm install -g @openai/codex');
    expect(result).toEqual({
      success: false,
      error: { type: 'version-unchanged', id: 'codex', version: '1.0.0', path: UNKNOWN_PATH },
    });
  });

  it('has no baseline to compare against when the dependency was never probed, so it does not cry version-unchanged', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(unknownCtx, {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: npmDetector,
    });

    const result = await manager.update('codex', 'npm');

    expect(result.success).toBe(true);
  });

  it('updates from the registry persisted for the agent', async () => {
    let version = '1.0.0';
    const runInstallCommand = vi.fn(async () => {
      version = '1.1.0';
      return ok<void>();
    });
    const manager = new HostDependencyManager(makeUnknownCtx(() => version), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursDetector,
      getSelection: async () => ({ kind: 'method', method: 'npm', registry: 'npmmirror' }),
    });

    await probeAndSettle(manager, 'codex');
    const result = await manager.update('codex');

    expect(runInstallCommand).toHaveBeenCalledWith(
      'npm install -g --registry=https://registry.npmmirror.com @openai/codex',
    );
    expect(result.success).toBe(true);
  });
});

/**
 * #4271,owner 真机上的形状:一台机器上两份 codex。
 *
 *   PATH 上第一个答话的  = 他自己 `~/.local/bin` 里那份(不是咕咕装的)
 *   他在面板里钉住的      = 咕咕自己装的那份
 *
 * 「在用的是哪一份」由用户的选择决定,不由 PATH 的先后决定 —— 基线读它、事后回去问它。
 * 旧实现两处都走 PATH 赢家,于是同一屏出现两个答案:面板写着一个版本,报错写着另一个,
 * 而两句话说的是不同的文件。
 */
describe('HostDependencyManager update targets the copy the panel names (#4271)', () => {
  const MANAGED_ROOT = '/home/u/.gugu/agents';
  const MANAGED = `${MANAGED_ROOT}/bin/codex`;
  const MINE = '/home/u/.local/bin/codex';

  /** 只有落在咕咕自己安装根里的那份才是 ours —— 与真实探测器同一条判据。 */
  const oursOnlyForManaged: InstallMethodDetector = {
    detect: async (realPath: string): Promise<Provenance> =>
      realPath.startsWith(MANAGED_ROOT)
        ? { kind: 'npm', confidence: 'confirmed', ours: true }
        : { kind: 'npm', confidence: 'inferred' },
    invalidate: () => {},
  };

  const makeTwoCopyCtx = (getManagedVersion: () => string) =>
    makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        // 用户自己那份排在前面 —— 咕咕的 PATH 前置只在 app 进程内生效。
        return { stdout: `${MINE}\n${MANAGED}\n`, stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: `${MINE}\n`, stderr: '' };
      }
      if (command === 'realpath') {
        return { stdout: `${args[0]}\n`, stderr: '' };
      }
      if (command === MINE && args[0] === '--version') {
        return { stdout: 'codex-cli 0.145.0\n', stderr: '' };
      }
      if (command === MANAGED && args[0] === '--version') {
        return { stdout: `codex-cli ${getManagedVersion()}\n`, stderr: '' };
      }
      throw new Error('missing');
    });

  const pinnedToManaged = async () => ({ kind: 'pinned' as const, realpath: MANAGED });

  it('那一份真的更新了就算成功 —— 哪怕 PATH 赢家纹丝不动', async () => {
    let managed = '0.148.0';
    const runInstallCommand = vi.fn(async () => {
      managed = '0.149.1';
      return ok<void>();
    });
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => managed), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursOnlyForManaged,
      getSelection: pinnedToManaged,
    });

    await probeAndSettle(manager, 'codex');
    const result = await manager.update('codex');

    // PATH 赢家(用户自己那份)前后都是 0.145.0。拿它当基线,这次成功的更新会被报成「版本没变」。
    expect(result.success).toBe(true);
  });

  it('那一份没动就失败,而且报错指的是那一份', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => '0.148.0'), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursOnlyForManaged,
      getSelection: pinnedToManaged,
    });

    await probeAndSettle(manager, 'codex');
    const result = await manager.update('codex');

    // 报错里的版本和路径会原样进 toast。指着 PATH 赢家报,用户看到的就是一句和面板对不上的话。
    expect(result).toEqual({
      success: false,
      error: { type: 'version-unchanged', id: 'codex', version: '0.148.0', path: MANAGED },
    });
  });

  /**
   * 卸载比更新更该守这条闸:更新失败还能重来,删掉不能。
   *
   * 这道闸在 `uninstall()` 的文档注释里一直写着(`manageable === false` → no-uninstall-strategy),
   * 代码里却没有 —— 它从选中副本的 provenance 推出 method,于是选中用户自己那份再点卸载,
   * 跑的是真的卸载命令,把用户亲手装的东西删了。#4271
   *
   * 用 `codex-pm`(**真的**声明了 package-manager 卸载策略)而不是 `codex`:否则这条会因为
   * 「本来就没有卸载策略」而绿,拒绝的理由就跟归属无关了 —— 阴性对照为错误的理由变绿。
   */
  // 三行来源之后(owner 2026-09-22/23):「卸载」只挂在「咕咕管理」那一行,动的永远是咕咕那份。
  // 钉着用户自己那份时,卸载的目标照样是咕咕那份 —— 用户那份不是目标;咕咕那份不在时才轮到闸。
  it('钉住别人装的那份时,卸载的目标是咕咕那份,不是用户钉住的那份', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => '0.149.1'), {
      dependencies: UNINSTALL_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursOnlyForManaged,
      getSelection: async () => ({ kind: 'pinned' as const, realpath: MINE }),
    });
    const started: Array<Record<string, unknown>> = [];
    const internals = manager as unknown as { logOperation: (...a: unknown[]) => void };
    const original = internals.logOperation.bind(manager);
    internals.logOperation = (op, phase, id, extra) => {
      if (op === 'uninstall' && phase === 'started') started.push(extra as Record<string, unknown>);
      original(op, phase, id, extra);
    };

    await probeAndSettle(manager, 'codex-pm');
    await manager.uninstall('codex-pm');

    expect(runInstallCommand).toHaveBeenCalledTimes(1);
    expect(started[0]?.targetPath).toBe(MANAGED);
  });

  it('咕咕自己一份都没有、钉着的是用户那份:卸载直接拒绝 —— 一条命令都不跑(#4271 的闸还在)', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => '0.149.1'), {
      dependencies: UNINSTALL_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: { detect: async () => ({ kind: 'npm', confidence: 'confirmed', ours: false }), invalidate: () => {} },
      getSelection: async () => ({ kind: 'pinned' as const, realpath: MINE }),
    });

    await probeAndSettle(manager, 'codex-pm');
    for (const method of [undefined, 'npm' as const]) {
      const result = await manager.uninstall('codex-pm', method);
      expect(result).toEqual({
        success: false,
        error: { type: 'no-uninstall-strategy', id: 'codex-pm' },
      });
    }
    expect(runInstallCommand).not.toHaveBeenCalled();
  });

  /** 阳性对照:闸不是「永远拒绝」—— 咕咕自己那份照常卸得掉。 */
  it('咕咕自己装的那一份照常卸载', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => '0.149.1'), {
      dependencies: UNINSTALL_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursOnlyForManaged,
      getSelection: async () => ({ kind: 'pinned' as const, realpath: MANAGED }),
    });

    await probeAndSettle(manager, 'codex-pm');
    await manager.uninstall('codex-pm');

    expect(runInstallCommand).toHaveBeenCalledWith('npm uninstall -g @openai/codex');
  });

  it('钉住的是别人装的那份时,更新的目标是咕咕那份 —— 用户那份不是目标', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => '0.149.1'), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: oursOnlyForManaged,
      getSelection: async () => ({ kind: 'pinned' as const, realpath: MINE }),
    });

    await probeAndSettle(manager, 'codex');
    const result = await manager.update('codex');

    // 夹具里版本不会动,所以落在 version-unchanged;要看的是它量的是哪一份 —— 咕咕那份。
    expect(result).toMatchObject({ success: false, error: { type: 'version-unchanged', path: MANAGED } });
  });

  it('咕咕自己一份都没有、钉着的是用户那份:更新直接拒绝 —— 不跑任何命令', async () => {
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(makeTwoCopyCtx(() => '0.149.1'), {
      dependencies: TEST_DEPENDENCIES,
      runInstallCommand,
      installMethodDetector: { detect: async () => ({ kind: 'npm', confidence: 'confirmed', ours: false }), invalidate: () => {} },
      getSelection: async () => ({ kind: 'pinned' as const, realpath: MINE }),
    });

    await probeAndSettle(manager, 'codex');
    const result = await manager.update('codex');

    expect(result).toEqual({
      success: false,
      error: { type: 'no-update-strategy', id: 'codex' },
    });
    expect(runInstallCommand).not.toHaveBeenCalled();
  });
});

describe('HostDependencyManager probeOverride', () => {
  // which /custom/codex returns the path itself for an absolute path override
  const pathCtx = makeCtx(async (command, args = []) => {
    if (command === 'which' && args[0] === '/custom/codex') {
      return { stdout: '/custom/codex\n', stderr: '' };
    }
    if (command === 'realpath') {
      return { stdout: `${args[0]}\n`, stderr: '' };
    }
    if (command === '/custom/codex' && args[0] === '--version') {
      return { stdout: 'codex-cli 2.0.0\n', stderr: '' };
    }
    throw new Error('missing');
  });

  it('returns an available Installation for a valid path override without mutating hostState', async () => {
    const manager = new HostDependencyManager(pathCtx, {
      dependencies: TEST_DEPENDENCIES,
    });
    const emitted: unknown[] = [];
    manager.onStatusUpdated.subscribe((e) => emitted.push(e));

    const result = await manager.probeOverride('codex', { path: '/custom/codex' });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('path');
    expect(result?.status).toBe('available');
    expect(result?.version).toBe('2.0.0');
    // pathEntry is the override path value
    expect(result?.pathEntry).toBe('/custom/codex');
    // Must not emit any status updated events
    expect(emitted).toHaveLength(0);
    // Must not populate hostState
    expect(manager.getHostDependency('codex')).toBeUndefined();
  });

  it('returns a missing Installation when the path does not exist', async () => {
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: TEST_DEPENDENCIES,
    });

    const result = await manager.probeOverride('codex', { path: '/nonexistent/codex' });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('path');
    expect(result?.status).toBe('missing');
    // For a missing path override, pathEntry retains the specified value so the UI can show it.
    expect(result?.pathEntry).toBe('/nonexistent/codex');
  });

  it('returns an available Installation for a valid cli override', async () => {
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });
    const emitted: unknown[] = [];
    manager.onStatusUpdated.subscribe((e) => emitted.push(e));

    const result = await manager.probeOverride('codex', { cli: 'codex' });

    expect(result).not.toBeNull();
    expect(result?.id).toBe('cli');
    expect(result?.status).toBe('available');
    // pathEntry is the CLI command name
    expect(result?.pathEntry).toBe('codex');
    expect(emitted).toHaveLength(0);
  });

  it('returns null when the selection is empty', async () => {
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: TEST_DEPENDENCIES,
    });

    const result = await manager.probeOverride('codex', {});
    expect(result).toBeNull();
  });

  it('throws for an unknown dependency id', async () => {
    const manager = new HostDependencyManager(missingCtx, {
      dependencies: TEST_DEPENDENCIES,
    });

    await expect(manager.probeOverride('nonexistent', { cli: 'foo' })).rejects.toThrow(
      'Unknown dependency id: nonexistent',
    );
  });
});

describe('HostDependencyManager enumeration', () => {
  it('includes a pinned installation even when it is not on PATH', async () => {
    const pinnedPath = '/custom/git';
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === 'git') {
        return { stdout: '/usr/bin/git\n', stderr: '' };
      }
      if (command === 'which' && args[0] === '-a' && args[1] === 'git') {
        return { stdout: '/usr/bin/git\n', stderr: '' };
      }
      if (command === 'which' && args[0] === pinnedPath) {
        return { stdout: `${pinnedPath}\n`, stderr: '' };
      }
      if (command === 'realpath') {
        return { stdout: `${args[0]}\n`, stderr: '' };
      }
      if (command === '/usr/bin/git' && args[0] === '--version') {
        return { stdout: 'git version 2.40.0\n', stderr: '' };
      }
      if (command === pinnedPath && args[0] === '--version') {
        return { stdout: 'git version 2.45.0\n', stderr: '' };
      }
      throw new Error(`Unexpected: ${command} ${args.join(' ')}`);
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      getSelection: async (id) =>
        id === 'git' ? { kind: 'pinned' as const, realpath: pinnedPath } : null,
      installMethodDetector: unknownDetector,
    });

    await manager.probe('git');

    const hostDependency = manager.getHostDependency('git');
    expect(hostDependency?.used).toEqual({ kind: 'pinned', realpath: pinnedPath });
    expect(hostDependency?.installations).toContainEqual(
      expect.objectContaining({
        realpath: pinnedPath,
        pathEntry: null,
        status: 'available',
        version: '2.45.0',
      }),
    );
  });

  it('reports a missing pinned installation as missing', async () => {
    const pinnedPath = '/missing/git';
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === 'git') {
        return { stdout: '/usr/bin/git\n', stderr: '' };
      }
      if (command === 'which' && args[0] === '-a' && args[1] === 'git') {
        return { stdout: '/usr/bin/git\n', stderr: '' };
      }
      if (command === 'realpath') {
        return { stdout: `${args[0]}\n`, stderr: '' };
      }
      if (command === '/usr/bin/git' && args[0] === '--version') {
        return { stdout: 'git version 2.40.0\n', stderr: '' };
      }
      throw new Error(`Unexpected: ${command} ${args.join(' ')}`);
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      getSelection: async (id) =>
        id === 'git' ? { kind: 'pinned' as const, realpath: pinnedPath } : null,
      installMethodDetector: unknownDetector,
    });

    await manager.probe('git');

    expect(manager.getHostDependency('git')?.installations).toContainEqual(
      expect.objectContaining({
        realpath: pinnedPath,
        pathEntry: null,
        status: 'missing',
        version: null,
      }),
    );
  });

  it('enumerates multiple installations from which -a and dedupes by realpath', async () => {
    const BREW_PATH = '/opt/homebrew/bin/codex';
    const BREW_REAL = '/opt/homebrew/Cellar/codex/1.0.0/bin/codex';
    const NPM_PATH = '/usr/local/bin/codex';
    const NPM_REAL = '/usr/local/lib/node_modules/.bin/codex';

    const multiCtx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        return { stdout: `${BREW_PATH}\n${NPM_PATH}\n`, stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: `${BREW_PATH}\n`, stderr: '' };
      }
      if (command === 'realpath' && args[0] === BREW_PATH) {
        return { stdout: `${BREW_REAL}\n`, stderr: '' };
      }
      if (command === 'realpath' && args[0] === NPM_PATH) {
        return { stdout: `${NPM_REAL}\n`, stderr: '' };
      }
      if (command === 'codex' && args[0] === '--version') {
        return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      }
      if (command === BREW_PATH && args[0] === '--version') {
        return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      }
      if (command === NPM_PATH && args[0] === '--version') {
        return { stdout: 'codex-cli 1.1.0\n', stderr: '' };
      }
      throw new Error(`Unexpected: ${command} ${args.join(' ')}`);
    });

    let _brewCallCount = 0;
    const multiDetector: InstallMethodDetector = {
      detect: async (realPath): Promise<Provenance> => {
        if (realPath === BREW_REAL) {
          _brewCallCount++;
          return { kind: 'homebrew', confidence: 'confirmed', managerRef: 'codex' };
        }
        return { kind: 'npm', confidence: 'confirmed' };
      },
      invalidate: () => {},
    };

    const manager = new HostDependencyManager(multiCtx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: multiDetector,
    });
    const events: unknown[] = [];
    manager.onStatusUpdated.subscribe((e) => events.push(e));

    await probeAndSettle(manager, 'codex');

    const hostDepEvent = (events as Array<{ hostDependency?: { installations: unknown[] } }>).find(
      (e) => e.hostDependency !== undefined,
    );
    expect(hostDepEvent).toBeDefined();
    const installations = hostDepEvent?.hostDependency?.installations ?? [];

    // Should find 2 distinct installations (deduped by realpath)
    expect(installations).toHaveLength(2);

    const brewInst = (installations as Array<{ realpath: string; isActive: boolean }>).find(
      (i) => i.realpath === BREW_REAL,
    );
    const npmInst = (installations as Array<{ realpath: string; isActive: boolean }>).find(
      (i) => i.realpath === NPM_REAL,
    );

    expect(brewInst).toBeDefined();
    expect(brewInst?.isActive).toBe(true);
    expect(npmInst).toBeDefined();
    expect(npmInst?.isActive).toBe(false);
  });
});

/**
 * npm records nothing on disk about where a global package came from — no `_resolved` in the
 * installed package.json, no hidden lockfile at the global root, and `npm ls -g --json` returns
 * the version alone (checked on npm 10.9). The source is therefore remembered, not detected, and
 * these tests pin both halves of that: writing down what a command pinned, and refusing to replay
 * it once the binary underneath stops being the one we left there.
 */
describe('HostDependencyManager install-source record', () => {
  const NPM_PATH = '/usr/lib/node_modules/@openai/codex/bin/codex';
  const MIRROR_COMMAND = 'npm install -g --registry=https://registry.npmmirror.com @openai/codex';

  const RECORD_DEPENDENCIES: typeof TEST_DEPENDENCIES = [
    ...TEST_DEPENDENCIES,
    {
      id: 'codex-removable',
      name: 'Codex (uninstallable)',
      category: 'agent',
      commands: ['codex'],
      versionArgs: ['--version'],
      installCommands: {
        macos: [],
        linux: [
          {
            method: 'npm',
            registry: 'npmmirror',
            command: MIRROR_COMMAND,
            uninstallCommand: 'npm uninstall -g @openai/codex',
            recommended: true,
          },
        ],
        windows: [],
      },
      updates: {
        kind: 'supported',
        releaseSource: { kind: 'npm', package: '@openai/codex' },
        update: { kind: 'package-manager' },
      },
      uninstall: { kind: 'package-manager' },
    },
  ];

  /** ctx whose reported version and presence can change between probes, as a real host's would. */
  function hostCtx(state: { version: string; present: boolean }) {
    return makeCtx(async (command, args = []) => {
      const looksUpCodex =
        command === 'which' && (args[0] === 'codex' || (args[0] === '-a' && args[1] === 'codex'));
      if (looksUpCodex) {
        if (!state.present) throw new Error('missing');
        return { stdout: `${NPM_PATH}\n`, stderr: '' };
      }
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === NPM_PATH && args[0] === '--version') {
        return { stdout: `codex-cli ${state.version}\n`, stderr: '' };
      }
      throw new Error('missing');
    });
  }

  function makeStore(seed: InstallRecord | null = null) {
    let record = seed;
    return {
      options: {
        getInstallRecord: async () => record,
        setInstallRecord: async (_id: string, next: InstallRecord | null) => {
          record = next;
        },
      },
      read: () => record,
    };
  }

  function activeOf(manager: HostDependencyManager) {
    return manager.getHostDependency('codex')?.installations.find((i) => i.isActive);
  }

  it('writes down the registry an install pinned, and replays it on later probes', async () => {
    const store = makeStore();
    const state = { version: '1.2.3', present: true };
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      runInstallCommand: vi.fn(async () => ok<void>()),
      installMethodDetector: npmDetector,
      ...store.options,
    });

    const result = await manager.install('codex', 'npm', { registry: 'npmmirror' });
    expect(result.success).toBe(true);

    expect(store.read()).toEqual({
      method: 'npm',
      registry: 'npmmirror',
      realpath: NPM_PATH,
      version: '1.2.3',
    });

    // A plain probe later — nothing in flight — must reach the same conclusion from the record.
    await probeAndSettle(manager, 'codex');
    expect(activeOf(manager)?.provenance.registry).toBe('npmmirror');
  });

  it('does not promote an inferred vendor path when an install has no exact target', async () => {
    const store = makeStore();
    const state = { version: '1.2.3', present: true };
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      runInstallCommand,
      installMethodDetector: unknownDetector,
      ...store.options,
    });

    const result = await manager.install('codex', 'curl');
    expect(result.success).toBe(true);
    expect(runInstallCommand).toHaveBeenCalledWith('install codex via curl');

    expect(store.read()).toBeNull();
    expect(activeOf(manager)?.provenance).toMatchObject({
      kind: 'unknown',
      confidence: 'inferred',
    });
    expect(activeOf(manager)?.manageable).toBe(false);

    // A later probe must replay the app-issued provenance even though the detector still sees the
    // canonical vendor path as unknown.
    await probeAndSettle(manager, 'codex');
    expect(activeOf(manager)?.provenance).toMatchObject({
      kind: 'unknown',
      confidence: 'inferred',
    });
  });

  /**
   * Sibling of the case above, and the one #4271 actually came from: here the inferred copy's
   * *method matches* the command we ran, so only the `confidence === 'confirmed'` clause keeps it
   * out. `inferMethod` reads npm off a bare `node_modules` segment, which is what a vendor's own
   * `~/.local/share/<tool>/<ver>/node_modules/…` looks like. Claiming that copy writes down
   * ownership of a binary we never placed — after which updates reinstall into the real npm prefix
   * while the UI keeps reporting the untouched vendor copy. Absent beats wrong.
   */
  it('does not claim a copy the path heuristics merely guessed was npm (#4271)', async () => {
    const store = makeStore();
    const state = { version: '1.2.3', present: true };
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      runInstallCommand: vi.fn(async () => ok<void>()),
      installMethodDetector: npmInferredDetector,
      ...store.options,
    });

    const result = await manager.install('codex', 'npm');
    expect(result.success).toBe(true);

    expect(store.read()).toBeNull();
    expect(activeOf(manager)?.provenance).toMatchObject({ kind: 'npm', confidence: 'inferred' });
  });

  it('records the package-manager target instead of an unknown PATH winner', async () => {
    const pathWinner = '/vendor/codex';
    const npmTarget = '/usr/lib/node_modules/@openai/codex/bin/codex.js';
    const store = makeStore();
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        return { stdout: `${pathWinner}\n`, stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: `${pathWinner}\n`, stderr: '' };
      }
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === pathWinner && args[0] === '--version') {
        return { stdout: 'codex-cli 0.145.0\n', stderr: '' };
      }
      if (command === npmTarget && args[0] === '--version') {
        return { stdout: 'codex-cli 0.149.1\n', stderr: '' };
      }
      throw new Error(`missing ${command}`);
    });
    const targetDependencies = RECORD_DEPENDENCIES.map((dependency) => ({
      ...dependency,
      installCommands: Object.fromEntries(
        Object.entries(dependency.installCommands ?? {}).map(([platform, options]) => [
          platform,
          options?.map((option) => option.method === 'npm'
            ? { ...option, target: { kind: 'npm-package' as const, package: '@openai/codex' } }
            : option),
        ]),
      ),
    }));
    const detector: InstallMethodDetector = {
      ...unknownDetector,
      locateTarget: async () => [npmTarget],
    };
    const manager = new HostDependencyManager(ctx, {
      dependencies: targetDependencies,
      platform: 'linux',
      runInstallCommand: vi.fn(async () => ok<void>()),
      installMethodDetector: detector,
      ...store.options,
    });

    const result = await manager.install('codex', 'npm');
    expect(result.success).toBe(true);

    expect(store.read()).toEqual({ method: 'npm', realpath: npmTarget, version: '0.149.1' });
    expect(activeOf(manager)?.realpath).toBe(pathWinner);
    expect(activeOf(manager)?.provenance.kind).toBe('unknown');
    expect(manager.getHostDependency('codex')?.installations.find((i) => i.realpath === npmTarget)).toMatchObject({
      isActive: false,
      provenance: { kind: 'npm', confidence: 'confirmed' },
      version: '0.149.1',
    });

    const missingStore = makeStore();
    const missingManager = new HostDependencyManager(ctx, {
      dependencies: targetDependencies,
      platform: 'linux',
      runInstallCommand: vi.fn(async () => ok<void>()),
      installMethodDetector: { ...unknownDetector, locateTarget: async () => [] },
      ...missingStore.options,
    });
    await expect(missingManager.install('codex', 'npm')).resolves.toEqual({
      success: false,
      error: { type: 'not-detected-after-install', id: 'codex' },
    });
    expect(missingStore.read()).toBeNull();
  });

  it('remembers the method but drops an earlier registry claim for an unpinned command', async () => {
    const store = makeStore({ registry: 'npmmirror', realpath: NPM_PATH, version: '1.2.3' });
    const state = { version: '1.2.3', present: true };
    const runInstallCommand = vi.fn(async () => ok<void>());
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      runInstallCommand,
      installMethodDetector: npmDetector,
      ...store.options,
    });

    // The default-registry option runs a bare `npm install -g`, which resolves through the user's
    // own npm config. The registry remains unknown, but the app still knows it ran npm.
    const result = await manager.install('codex', 'npm');
    expect(result.success).toBe(true);
    expect(runInstallCommand).toHaveBeenCalledWith('npm install -g @openai/codex');

    expect(store.read()).toEqual({ method: 'npm', realpath: NPM_PATH, version: '1.2.3' });
    expect(activeOf(manager)?.provenance.registry).toBeUndefined();
    expect(activeOf(manager)?.provenance.kind).toBe('npm');
  });

  /**
   * #6101 —— 这条用例从前断言的是**相反的**行为(「版本一动就忘掉来源」)。
   *
   * 那条判据把最常见的一件事判成了「不是咕咕装的」:claude 自带的 auto-updater 就地把自己升
   * 上去,路径一个字没变。于是咕咕装的那一份掉回 `ours=false`,更新入口当场消失 —— 而它确实
   * 是咕咕装的,也只有咕咕会去动它。落点才是凭据,版本只是读数。
   */
  it('keeps the record when the binary升级 in place, and refreshes the version from the probe', async () => {
    const store = makeStore({ registry: 'npmmirror', realpath: NPM_PATH, version: '1.2.3' });
    const state = { version: '9.9.9', present: true };
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      installMethodDetector: npmDetector,
      ...store.options,
    });

    await probeAndSettle(manager, 'codex');

    const active = activeOf(manager);
    expect(active?.version).toBe('9.9.9');
    // 旧行为在这三行上会红:registry 被丢掉、ours 掉回 false、更新入口跟着消失。
    expect(active?.provenance.registry).toBe('npmmirror');
    expect(active?.provenance.ours).toBe(true);
    expect(active?.manageable).toBe(true);
    // 记录跟着这一轮探测走,❌ 不留装完那天的旧数字。
    expect(store.read()).toEqual({ registry: 'npmmirror', realpath: NPM_PATH, version: '9.9.9' });
  });

  /** 路径变了才是另一份东西 —— 那时记录本来就落不到它头上。 */
  it('does not claim a copy at another path', async () => {
    const store = makeStore({ registry: 'npmmirror', realpath: '/somewhere/else/codex', version: '1.2.3' });
    const manager = new HostDependencyManager(hostCtx({ version: '1.2.3', present: true }), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      installMethodDetector: npmDetector,
      ...store.options,
    });

    await probeAndSettle(manager, 'codex');

    expect(activeOf(manager)?.provenance.ours).toBeUndefined();
    expect(activeOf(manager)?.provenance.registry).toBeUndefined();
  });

  /**
   * 读不到 KV 的上下文(worker / 远端拿到的是账本副本)写不动这本账。
   * 承重的是:回填写不进去**不影响** `ours` —— 它照样报对,只是多一行日志说谁写不动。
   */
  it('still reports ours when the ledger it reads cannot be written', async () => {
    const warn = vi.fn();
    const manager = new HostDependencyManager(hostCtx({ version: '9.9.9', present: true }), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      installMethodDetector: npmDetector,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      getInstallRecord: async () => ({ registry: 'npmmirror', realpath: NPM_PATH, version: '1.2.3' }),
      setInstallRecord: async () => {
        throw new Error('this host cannot own installs');
      },
    });

    await probeAndSettle(manager, 'codex');

    expect(activeOf(manager)?.provenance.ours).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not refresh the install record version'),
      expect.objectContaining({ from: '1.2.3', to: '9.9.9' })
    );
  });

  it('replays the record onto a pinned copy that is not on PATH', async () => {
    // The case the record exists for: a mirror install the user then pinned. It is appended to
    // the installation list separately from `which -a` enumeration, so it only carries a source
    // if the record is applied after that append.
    const OFF_PATH = '/opt/mirror-install/codex';
    const store = makeStore({ registry: 'npmmirror', realpath: OFF_PATH, version: '1.2.3' });
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        return { stdout: '/usr/bin/codex\n', stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: '/usr/bin/codex\n', stderr: '' };
      }
      if (command === 'which' && args[0] === OFF_PATH) {
        return { stdout: `${OFF_PATH}\n`, stderr: '' };
      }
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === '/usr/bin/codex' && args[0] === '--version') {
        return { stdout: 'codex-cli 2.0.0\n', stderr: '' };
      }
      if (command === OFF_PATH && args[0] === '--version') {
        return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      }
      throw new Error('missing');
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      installMethodDetector: npmDetector,
      getSelection: async () => ({ kind: 'pinned', realpath: OFF_PATH }),
      ...store.options,
    });

    await probeAndSettle(manager, 'codex');

    const installations = manager.getHostDependency('codex')?.installations ?? [];
    const pinned = installations.find((i) => i.realpath === OFF_PATH);
    expect(pinned).toBeDefined();
    expect(pinned?.provenance.registry).toBe('npmmirror');
    // The PATH winner is a different copy and must not inherit the claim.
    expect(installations.find((i) => i.realpath === '/usr/bin/codex')?.provenance.registry).toBe(
      undefined,
    );
  });

  it('drops the claim on uninstall, so a reinstall cannot inherit it', async () => {
    const store = makeStore({ registry: 'npmmirror', realpath: NPM_PATH, version: '1.2.3' });
    const state = { version: '1.2.3', present: true };
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: RECORD_DEPENDENCIES,
      platform: 'linux',
      runInstallCommand: vi.fn(async () => {
        state.present = false;
        return ok<void>();
      }),
      installMethodDetector: npmDetector,
      ...store.options,
    });

    const result = await manager.uninstall('codex-removable');
    expect(result.success).toBe(true);

    expect(store.read()).toBeNull();
  });
});

/**
 * 在盘上、但跑不起来。
 *
 * 真实成因:升级 Node 之后 npm 装的 shim 指着一个已经不存在的运行时、二进制架构不对、
 * 依赖库缺失 —— 文件都在,`--version` 一跑就挂。
 *
 * 这里判两件事,都是「产品不许说假话」:
 *   1. 不许说成 available —— 说了它就跟一份好用的副本长得一模一样,而它跑不了任何任务。
 *   2. 不许拿报错文字冒充版本号 —— `extractVersion` 取的是 stdout/stderr 的第一行,
 *      正常时那是 "codex-cli 1.2.3",挂掉时那是 "dyld: Library not loaded: …"。
 */
describe('HostDependencyManager 探测失败的副本', () => {
  const brokenCtx = () =>
    makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        return { stdout: '/bin/codex\n', stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') {
        return { stdout: '/bin/codex\n', stderr: '' };
      }
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === '/bin/codex' && args[0] === '--version') {
        // 真实形态:exec 抛出,带着退出码与 stderr。
        throw Object.assign(new Error('Command failed'), {
          code: 1,
          stdout: '',
          stderr: 'dyld: Library not loaded: /opt/homebrew/opt/node/lib/libnode.115.dylib',
        });
      }
      throw new Error('missing');
    });

  it('❌ 不把跑不起来的副本报成 available', async () => {
    const manager = new HostDependencyManager(brokenCtx(), {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });
    const built = nextHostDependency(manager, 'codex');
    await manager.probeCategory('agent');
    await built;

    const install = manager.getHostDependency('codex')?.installations[0];
    expect(install?.status).not.toBe('available');
  });

  it('❌ 不拿报错文字冒充版本号', async () => {
    const manager = new HostDependencyManager(brokenCtx(), {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });
    const built = nextHostDependency(manager, 'codex');
    await manager.probeCategory('agent');
    await built;

    const install = manager.getHostDependency('codex')?.installations[0];
    // 版本现在应该是 null。写成 `?? ''` 而不是 toBeNull:万一那条「取第一行当版本」的
    // fallback 被恢复,这条照样能红。
    expect(install?.version ?? '').not.toContain('dyld');
  });

  /** 阳性对照:同一条路径、`--version` 正常时,读数必须是 available + 真版本号。 */
  it('阳性对照:跑得起来时照常 available 并读出版本', async () => {
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'which' && args[0] === '-a' && args[1] === 'codex') {
        return { stdout: '/bin/codex\n', stderr: '' };
      }
      if (command === 'which' && args[0] === 'codex') return { stdout: '/bin/codex\n', stderr: '' };
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === '/bin/codex' && args[0] === '--version') {
        return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      }
      throw new Error('missing');
    });
    const manager = new HostDependencyManager(ctx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
    });
    const built = nextHostDependency(manager, 'codex');
    await manager.probeCategory('agent');
    await built;

    const install = manager.getHostDependency('codex')?.installations[0];
    expect(install?.status).toBe('available');
    expect(install?.version).toBe('1.2.3');
  });
});

describe('mise migration of an application-owned legacy copy', () => {
  it('forwards cancellation and verifies the new stable entry instead of the unchanged legacy path', async () => {
    const legacy = '/managed/npm/codex';
    const stable = '/managed/mise-bin/codex';
    let installed = false;
    const ctx = makeCtx(async (command, args = []) => {
      if (command === 'realpath') return { stdout: args[0]!, stderr: '' };
      if (command === 'which') {
        if (args.at(-1) === 'codex') return { stdout: installed ? stable : legacy, stderr: '' };
        if (args.at(-1) === legacy) return { stdout: legacy, stderr: '' };
      }
      if (command === legacy) return { stdout: 'codex-cli 1.0.0', stderr: '' };
      if (command === stable && installed) return { stdout: 'codex-cli 2.0.0', stderr: '' };
      throw new Error('missing');
    });
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const run = vi.fn(async () => { installed = true; return ok<void>(); });
    const manager = new HostDependencyManager(ctx, {
      platform: 'linux',
      dependencies: [{
        id: 'codex', name: 'Codex', category: 'agent', commands: ['codex'],
        installCommands: { linux: [{ method: 'mise', replaces: ['npm'], registry: 'npmmirror', command: 'mise install http:gugu-codex', target: { kind: 'mise', package: '@openai/codex', binary: 'codex', backend: { kind: 'platform-archive', executables: {} } } }] },
        updates: { kind: 'supported', releaseSource: { kind: 'npm', package: '@openai/codex' }, update: { kind: 'package-manager' } },
      }],
      getSelection: async () => ({ kind: 'pinned', realpath: legacy, registry: 'npmmirror' }),
      runInstallCommand: run,
      installMethodDetector: {
        detect: async (file) => ({ kind: file === stable ? 'mise' : 'npm', confidence: 'confirmed', ours: true }),
        locateTarget: async () => installed ? [stable] : [],
        invalidate: () => {},
      },
    });
    await probeAndSettle(manager, 'codex');
    expect(manager.getHostDependency('codex')?.installations.length).toBeGreaterThan(0);
    const result = await manager.update('codex', undefined, { signal, onProgress });
    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledWith('mise install http:gugu-codex', {
      signal, onProgress,
      mise: { operation: 'update', registry: 'npmmirror', selectedPath: legacy, target: expect.objectContaining({ kind: 'mise' }) },
    });
  });
});

// ---------------------------------------------------------------------------
// 手动指定存下来的是什么 —— wrapper(命令名)必须原样活过一次读写
// ---------------------------------------------------------------------------

describe('normalizeSelection', () => {
  it('命令名原样回来 —— wrapper 不许在读写之间被改写成路径', () => {
    // #6098 的验收面之一:`reclaude` 存的是 `{kind:'cli'}`,读回来还得是它。
    expect(normalizeSelection({ kind: 'cli', command: 'reclaude' })).toEqual({
      kind: 'cli',
      command: 'reclaude',
    });
    expect(normalizeSelection({ kind: 'cli', command: 'reclaude', registry: 'npmmirror' })).toEqual({
      kind: 'cli',
      command: 'reclaude',
      registry: 'npmmirror',
    });
  });

  it('绝对路径与命令名是两种,互不改写', () => {
    expect(normalizeSelection({ kind: 'path', path: '/usr/local/bin/claude' })).toEqual({
      kind: 'path',
      path: '/usr/local/bin/claude',
    });
  });

  it('老格式里的 cli 迁过来还是 cli', () => {
    // v1 存的是 `{usedId, path?, cli?}`。迁移丢了这一支就等于「升级之后 wrapper 没了」。
    expect(normalizeSelection({ usedId: 'cli', cli: 'reclaude' })).toEqual({
      kind: 'cli',
      command: 'reclaude',
    });
    expect(normalizeSelection({ usedId: 'path', path: '/opt/bin/claude' })).toEqual({
      kind: 'path',
      path: '/opt/bin/claude',
    });
  });

  it('空值不当选择 —— 一个空命令名存下去就是「我选了但没选什么」', () => {
    expect(normalizeSelection({ kind: 'cli', command: '' })).toBeNull();
    expect(normalizeSelection({ usedId: 'cli' })).toBeNull();
    expect(normalizeSelection(null)).toBeNull();
  });
});

describe('HostDependencyManager — 连续切换来源时,后发的那次探测说了算', () => {
  it('安装收尾等待副本状态，返回时已读到新选择 (#7582)', async () => {
    let current: { kind: 'method'; method: 'mise' } | null = null;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const enumerating = new Promise<void>((resolve) => { entered = resolve; });
    let blocked = false;
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      getSelection: async () => current,
      installMethodDetector: {
        invalidate: () => {},
        detect: async () => {
          if (blocked) { entered(); await gate; }
          return { kind: 'unknown', confidence: 'inferred' };
        },
      },
    });
    await probeAndSettle(manager, 'codex');
    expect(manager.getHostDependency('codex')?.used.kind).toBe('auto');
    current = { kind: 'method', method: 'mise' };
    blocked = true;
    let finished = false;
    const probe = manager.probe('codex', { waitForInstallations: true }).then(() => { finished = true; });
    await enumerating;
    expect(finished).toBe(false);
    release();
    await probe;
    expect(manager.getHostDependency('codex')?.used).toEqual(current);
  });

  it('先发的探测晚回来,不许把「在用」写回旧选择(owner 2026-09-22 真机:切回咕咕管理后面板停在本机那份)', async () => {
    let current: { kind: 'method'; method: 'mise' } | null = null;
    const emitted: string[] = [];
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
      getSelection: async () => current,
    });
    let methodEmitted!: () => void;
    const methodSeen = new Promise<void>((resolve) => (methodEmitted = resolve));
    manager.onStatusUpdated.subscribe((e) => {
      if (!e.hostDependency) return;
      emitted.push(e.hostDependency.used.kind);
      if (e.hostDependency.used.kind === 'method') methodEmitted();
    });

    // 第一次探测在「列副本」那一步卡住,直到我们放行。
    const internals = manager as unknown as {
      enumerateInstallations: (...args: unknown[]) => Promise<unknown>;
      buildAndStoreHostDependency: (...args: unknown[]) => Promise<void>;
    };
    const original = internals.enumerateInstallations.bind(manager);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let firstEntered!: () => void;
    const firstEnumerating = new Promise<void>((resolve) => (firstEntered = resolve));
    let calls = 0;
    internals.enumerateInstallations = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        firstEntered();
        await gate;
      }
      return await original(...args);
    };
    // agent 的「列副本 → 存 → 发事件」在后台跑(probe 先返回):记下每一趟,最后等两趟都真走完。
    const originalBuild = internals.buildAndStoreHostDependency.bind(manager);
    const builds: Promise<void>[] = [];
    internals.buildAndStoreHostDependency = (...args: unknown[]) => {
      const build = originalBuild(...args);
      builds.push(build);
      return build;
    };

    current = null; // 用户点了「本机找到的」= 自动
    await manager.probe('codex');
    await firstEnumerating;
    current = { kind: 'method', method: 'mise' }; // 紧接着又点了「咕咕管理」
    await manager.probe('codex');
    await methodSeen;
    release(); // 先发的那一趟这时才回来
    await Promise.all(builds);
    expect(builds).toHaveLength(2);

    expect(manager.getHostDependency('codex')?.used.kind).toBe('method');
    expect(emitted.at(-1)).toBe('method');
  });
});

describe('HostDependencyManager — 上一次指定的自定义路径', () => {
  it('没选中它时也照样探一遍,面板那一行才显示得出版本、点得回去(owner 2026-09-22)', async () => {
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
      ledger: {
        getSelection: async () => null, // 现在用的是「本机找到的」
        getInstallRecord: async () => null,
        setInstallRecord: async () => {},
        getLastCustom: async () => ({ kind: 'cli', command: 'codex' }),
      },
    });
    await probeAndSettle(manager, 'codex');
    expect(manager.getHostDependency('codex')).toBeDefined();

    const dep = manager.getHostDependency('codex')!;
    const custom = dep.installations.find((i) => i.id === 'cli');
    expect(custom?.pathEntry).toBe('codex');
    // 它不在 PATH 上排队:「自动」仍然指向本机找到的那一份。
    expect(custom?.isActive).toBe(false);
    expect(dep.used.kind).toBe('auto');
  });

  it('从没指定过就不多出这一行', async () => {
    const manager = new HostDependencyManager(availableCtx, {
      dependencies: TEST_DEPENDENCIES,
      installMethodDetector: unknownDetector,
      ledger: {
        getSelection: async () => null,
        getInstallRecord: async () => null,
        setInstallRecord: async () => {},
        getLastCustom: async () => null,
      },
    });
    await probeAndSettle(manager, 'codex');
    expect(manager.getHostDependency('codex')).toBeDefined();
    expect(manager.getHostDependency('codex')!.installations.some((i) => i.id === 'cli' || i.id === 'path')).toBe(false);
  });
});
