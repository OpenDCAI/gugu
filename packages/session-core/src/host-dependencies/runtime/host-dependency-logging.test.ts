import { ok } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { HostDependencyManager } from './host-dependency-manager';
import type { InstallMethodDetector } from './method-detection';
import { probeAndSettle } from './test-support';
import type { DependencyDescriptor, Provenance } from './types';

/**
 * 「装没装」这件事必须在日志里留下痕迹(#6101 第四条)。
 *
 * 真机读数(mac1,0.2.48):整场跑完 —— 2 次成功安装(共 208MB)、3 次失败、几十次探测 ——
 * 日志里关于安装 / 探测一行都没有。成因不是没打,而是**打在了默认看不见的级别上**:
 * 会话页这半边的 logger 默认级别是 `warn`(`resolveLogLevel` 的兜底),而那几行是 `info`。
 *
 * ⇒ 这组用例钉的是**级别**,不是「有没有调用 logger」:
 *   · 罕见且事后要回答的(装 / 更新 / 卸载的起成败、读数变了)→ `warn`,默认必落盘;
 *   · 每轮几十行的逐次探测 → `info`,默认不落盘(提到 warn 就把这条通道变成噪音)。
 * 红控:把断言换成 `info` 就红 —— 而那正是改之前的写法。
 */
const CODEX: DependencyDescriptor = {
  id: 'codex',
  name: 'Codex',
  category: 'agent',
  commands: ['codex'],
  versionArgs: ['--version'],
  installCommands: {
    macos: [{ method: 'npm', command: 'npm install -g @openai/codex', recommended: true }],
    linux: [{ method: 'npm', command: 'npm install -g @openai/codex', recommended: true }],
    windows: [{ method: 'npm', command: 'npm install -g @openai/codex', recommended: true }],
  },
  updates: {
    kind: 'supported',
    releaseSource: { kind: 'npm', package: '@openai/codex' },
    update: { kind: 'package-manager' },
  },
};

const BIN = '/usr/local/bin/codex';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A host whose copy can be taken away between probes, as a real one can. */
function hostCtx(state: { present: boolean; runs: boolean }): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn().mockImplementation(async (command: string, args: string[] = []) => {
      const looksUp =
        command === 'which' && (args[0] === 'codex' || (args[0] === '-a' && args[1] === 'codex'));
      if (looksUp) {
        if (!state.present) throw new Error('missing');
        return { stdout: `${BIN}\n`, stderr: '' };
      }
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === BIN && args[0] === '--version') {
        if (!state.runs) throw Object.assign(new Error('boom'), { code: 1, stderr: 'dyld: missing' });
        return { stdout: 'codex-cli 1.2.3\n', stderr: '' };
      }
      throw new Error(`missing ${command}`);
    }),
    refreshShellEnv: undefined,
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
}

const npmDetector: InstallMethodDetector = {
  detect: async (): Promise<Provenance> => ({ kind: 'npm', confidence: 'confirmed', ours: true }),
  invalidate: () => {},
};

function messages(calls: unknown[][]): string[] {
  return calls.map((call) => String(call[0]));
}

describe('host-dependency logging', () => {
  it('每一轮探测都报读数,级别是 info(逐次探测不许刷 warn)', async () => {
    const logger = makeLogger();
    const manager = new HostDependencyManager(hostCtx({ present: true, runs: true }), {
      dependencies: [CODEX],
      platform: 'linux',
      installMethodDetector: npmDetector,
      logger,
    });

    await probeAndSettle(manager, 'codex');

    expect(messages(logger.info.mock.calls)).toContain('[HostDependencyManager] reading');
    expect(logger.info).toHaveBeenCalledWith(
      '[HostDependencyManager] reading',
      expect.objectContaining({ id: 'codex', reading: 'installed', host: 'local', version: '1.2.3' }),
    );
    // 稳态不刷 warn —— 否则这条通道会被正常启动的几十行淹掉。
    expect(messages(logger.warn.mock.calls)).not.toContain('[HostDependencyManager] reading changed');
  });

  it('读数变了报一行 warn —— 默认级别下也一定落盘', async () => {
    const logger = makeLogger();
    const state = { present: true, runs: true };
    const manager = new HostDependencyManager(hostCtx(state), {
      dependencies: [CODEX],
      platform: 'linux',
      installMethodDetector: npmDetector,
      logger,
    });

    await probeAndSettle(manager, 'codex');
    state.runs = false; // 文件还在,但跑不起来了
    await probeAndSettle(manager, 'codex');

    expect(logger.warn).toHaveBeenCalledWith(
      '[HostDependencyManager] reading changed',
      expect.objectContaining({
        id: 'codex',
        previous: 'installed',
        reading: 'detected-but-broken',
      }),
    );
  });

  it('安装的起与成各一行 warn,带上跑了哪条命令与落在哪儿', async () => {
    const logger = makeLogger();
    const manager = new HostDependencyManager(hostCtx({ present: true, runs: true }), {
      dependencies: [CODEX],
      platform: 'linux',
      installMethodDetector: npmDetector,
      logger,
      runInstallCommand: vi.fn(async () => ok<void>()),
    });

    const result = await manager.install('codex', 'npm');
    expect(result.success).toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      '[HostDependencyManager] install started',
      expect.objectContaining({ id: 'codex', command: 'npm install -g @openai/codex' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[HostDependencyManager] install finished',
      expect.objectContaining({ id: 'codex', version: '1.2.3', path: BIN }),
    );
  });

  it('装失败也留一行 —— 那条 toast 6 秒后就没了,日志是唯一的证据', async () => {
    const logger = makeLogger();
    const manager = new HostDependencyManager(hostCtx({ present: false, runs: false }), {
      dependencies: [CODEX],
      platform: 'linux',
      installMethodDetector: npmDetector,
      logger,
      runInstallCommand: vi.fn(async () => ({
        success: false as const,
        error: {
          type: 'command-failed' as const,
          message: 'Bundled installation engine is missing.',
          output: '',
          exitCode: 1,
        },
      })),
    });

    const result = await manager.install('codex', 'npm');
    expect(result.success).toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      '[HostDependencyManager] install failed',
      expect.objectContaining({ id: 'codex', error: 'command-failed' }),
    );
  });
});
