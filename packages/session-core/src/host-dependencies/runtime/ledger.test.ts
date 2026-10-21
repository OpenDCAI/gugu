import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { HostDependencyManager } from './host-dependency-manager';
import {
  createLedgerBackedDetector,
  createReplicaLedger,
  type HostDependencyLedgerSnapshot,
} from './ledger';
import { createInstallMethodDetector, type InstallMethodDetector } from './method-detection';
import { probeAndSettle } from './test-support';
import type { DependencyDescriptor, Provenance } from './types';

const MISE_BIN = '/Users/mac1/.gugu/agents/mise-bin';
const GUGU_COPY = `${MISE_BIN}/codex`;
const OWN_DIRS = {
  ownedNpmRoots: ['/Users/mac1/.gugu/agents/lib/node_modules'],
  ownedShimDirs: ['/Users/mac1/.gugu/agents/bin'],
  ownedMiseBinDirs: [MISE_BIN],
};

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
  uninstall: { kind: 'package-manager' },
};

function makeCtx(
  handler: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn().mockImplementation(handler),
    refreshShellEnv: undefined,
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
}

/** One copy of codex, living in the tree gugu installs into. */
function hostWithGuguCopy(): IExecutionContext {
  return makeCtx(async (command, args = []) => {
    const looksUpCodex =
      command === 'which' && (args[0] === 'codex' || (args[0] === '-a' && args[1] === 'codex'));
    if (looksUpCodex) return { stdout: `${GUGU_COPY}\n`, stderr: '' };
    if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
    if (command === GUGU_COPY && args[0] === '--version') {
      return { stdout: 'codex-cli 0.155.1\n', stderr: '' };
    }
    throw new Error(`missing ${command}`);
  });
}

const unknownDetector: InstallMethodDetector = {
  detect: async (): Promise<Provenance> => ({ kind: 'unknown', confidence: 'inferred' }),
  invalidate: () => {},
};

function snapshot(
  overrides: Partial<HostDependencyLedgerSnapshot> = {}
): HostDependencyLedgerSnapshot {
  return {
    ownedDirs: OWN_DIRS,
    entries: [{ id: 'codex', selection: null, installRecord: null }],
    ...overrides,
  };
}

describe('replica ledger', () => {
  it('answers nothing until the owner pushes, then answers from that push', async () => {
    const ledger = createReplicaLedger();

    // 阴控:还没收到账本。「没收到」与「账上没有」在读数上同形 —— 承重的是它**不编**一个
    // 自己探出来的答案。
    await expect(ledger.getSelection('codex')).resolves.toBeNull();
    await expect(ledger.getInstallRecord('codex')).resolves.toBeNull();
    expect(ledger.ownedDirs().ownedMiseBinDirs).toEqual([]);

    ledger.apply(
      snapshot({
        entries: [
          {
            id: 'codex',
            selection: { kind: 'pinned', realpath: GUGU_COPY },
            installRecord: { method: 'npm', realpath: GUGU_COPY, version: '0.155.1' },
            probeEnv: { CODEX_HOME: '/tmp/codex-home' },
          },
        ],
      })
    );

    await expect(ledger.getSelection('codex')).resolves.toEqual({
      kind: 'pinned',
      realpath: GUGU_COPY,
    });
    await expect(ledger.getInstallRecord('codex')).resolves.toEqual({
      method: 'npm',
      realpath: GUGU_COPY,
      version: '0.155.1',
    });
    expect(ledger.probeEnvFor('codex')).toEqual({ CODEX_HOME: '/tmp/codex-home' });
    expect(ledger.ownedDirs().ownedMiseBinDirs).toEqual([MISE_BIN]);
  });

  it('refuses to write a record instead of starting a second ledger', async () => {
    const ledger = createReplicaLedger();
    await expect(
      ledger.setInstallRecord('codex', { method: 'npm', realpath: GUGU_COPY, version: '1' })
    ).rejects.toThrow(/cannot own installs/);
  });
});

describe('ledger-backed detector', () => {
  it('only calls a copy ours once the owner has said which dirs are ours', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('no package manager here');
    });
    const ledger = createReplicaLedger();
    const detector = createLedgerBackedDetector(ctx, 'macos', ledger);

    // 红控 = 今天 worker 侧的处境:没人告诉它咕咕的目录在哪 ⇒ 咕咕自己装的那一份被判成别人的。
    expect(await detector.detect(GUGU_COPY)).toEqual({ kind: 'unknown', confidence: 'inferred' });

    ledger.apply(snapshot());

    expect(await detector.detect(GUGU_COPY)).toEqual({
      kind: 'mise',
      confidence: 'confirmed',
      ours: true,
    });
  });

  it('答案与主进程那只探测器逐字一致 —— 同样的目录、同样的读数', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('no package manager here');
    });
    const ledger = createReplicaLedger();
    ledger.apply(snapshot());

    expect(await createLedgerBackedDetector(ctx, 'macos', ledger).detect(GUGU_COPY)).toEqual(
      await createInstallMethodDetector(ctx, 'macos', OWN_DIRS).detect(GUGU_COPY)
    );
  });
});

describe('HostDependencyManager reading one ledger', () => {
  it('takes the selection and the install record from the ledger it was handed', async () => {
    const ledger = createReplicaLedger();
    ledger.apply(
      snapshot({
        entries: [
          {
            id: 'codex',
            selection: { kind: 'pinned', realpath: GUGU_COPY },
            installRecord: { method: 'npm', realpath: GUGU_COPY, version: '0.155.1' },
          },
        ],
      })
    );
    const manager = new HostDependencyManager(hostWithGuguCopy(), {
      dependencies: [CODEX],
      platform: 'macos',
      ledger,
      installMethodDetector: unknownDetector,
    });

    await probeAndSettle(manager, 'codex');

    expect(manager.getHostDependency('codex')?.used).toEqual({
      kind: 'pinned',
      realpath: GUGU_COPY,
    });
  });

  /**
   * 远端(以及任何装不了东西的上下文)的 `ours` 只能来自安装记录:那台盘上不存在「咕咕自己的
   * 目录」,探测器永远答不出 `ours`。❌ 不许因此默认 false —— 那正是远端更新/卸载永久变灰的来路。
   */
  it('reports ours from the record even where the detector can never confirm it', async () => {
    const ledger = createReplicaLedger();
    ledger.apply(
      snapshot({
        // 远端没有咕咕的目录 —— 一个都没有,这是承重的前提。
        ownedDirs: { ownedNpmRoots: [], ownedShimDirs: [], ownedMiseBinDirs: [] },
        entries: [
          {
            id: 'codex',
            selection: null,
            installRecord: { method: 'npm', realpath: GUGU_COPY, version: '0.155.1' },
          },
        ],
      })
    );
    const manager = new HostDependencyManager(hostWithGuguCopy(), {
      dependencies: [CODEX],
      platform: 'linux',
      ledger,
      installMethodDetector: unknownDetector,
    });

    await probeAndSettle(manager, 'codex');

    const installation = manager
      .getHostDependency('codex')
      ?.installations.find((i) => i.realpath === GUGU_COPY);
    expect(installation?.provenance).toMatchObject({ kind: 'npm', ours: true });
    expect(installation?.manageable).toBe(true);
  });

  /** 红控:同一台机器、同一份副本,只是没把账递进来 —— 读数就翻成了「不是咕咕装的」。 */
  it('without the ledger the same host reads as not-ours', async () => {
    const manager = new HostDependencyManager(hostWithGuguCopy(), {
      dependencies: [CODEX],
      platform: 'linux',
      installMethodDetector: unknownDetector,
    });

    await probeAndSettle(manager, 'codex');

    const installation = manager
      .getHostDependency('codex')
      ?.installations.find((i) => i.realpath === GUGU_COPY);
    expect(installation?.provenance.ours).toBeUndefined();
    expect(installation?.manageable).toBe(false);
  });
});

/**
 * #6101 —— 手动指定**同一个文件**之后,来源标签从 `npm` 退成 `Unknown`。
 *
 * mac1 实测:下拉里写着 `npm v2.1.267 /opt/homebrew/bin/claude`,手动填同一路径,卡头变成
 * `Already on this machine v2.1.267 · Unknown`。同一个文件两套来源标签 —— 用户以为自己填错了,
 * 或以为咕咕把这份副本降级了。
 */
describe('manual override keeps the enumerated copy provenance', () => {
  const BREW_COPY = '/opt/homebrew/bin/codex';

  function hostWithBrewCopy(): IExecutionContext {
    return makeCtx(async (command, args = []) => {
      const looksUp =
        command === 'which' && (args[0] === 'codex' || (args[0] === '-a' && args[1] === 'codex'));
      if (looksUp) return { stdout: `${BREW_COPY}\n`, stderr: '' };
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === BREW_COPY && args[0] === '--version') {
        return { stdout: 'codex-cli 0.147.0\n', stderr: '' };
      }
      throw new Error(`missing ${command}`);
    });
  }

  const npmDetector: InstallMethodDetector = {
    detect: async (): Promise<Provenance> => ({ kind: 'npm', confidence: 'confirmed' }),
    invalidate: () => {},
  };

  it('points at a file already enumerated as npm and keeps that label', async () => {
    const ledger = createReplicaLedger();
    ledger.apply(
      snapshot({
        entries: [
          { id: 'codex', selection: { kind: 'path', path: BREW_COPY }, installRecord: null },
        ],
      })
    );
    const manager = new HostDependencyManager(hostWithBrewCopy(), {
      dependencies: [CODEX],
      platform: 'macos',
      ledger,
      installMethodDetector: npmDetector,
    });

    await probeAndSettle(manager, 'codex');

    const installations = manager.getHostDependency('codex')?.installations ?? [];
    const manual = installations.find((i) => i.id === 'path');
    const enumerated = installations.find((i) => i.id !== 'path');
    // 阳控:枚举那一行确实答得出 npm —— 否则下面那条「两行一致」只是「两个 unknown 相等」。
    expect(enumerated?.provenance.kind).toBe('npm');
    expect(manual?.realpath).toBe(BREW_COPY);
    expect(manual?.provenance).toEqual(enumerated?.provenance);
  });

  it('指着一个 PATH 上没有的文件时照旧说不知道 —— ❌ 不从别人那儿借一个来源', async () => {
    const ledger = createReplicaLedger();
    ledger.apply(
      snapshot({
        entries: [
          { id: 'codex', selection: { kind: 'path', path: '/elsewhere/codex' }, installRecord: null },
        ],
      })
    );
    const manager = new HostDependencyManager(
      makeCtx(async (command, args = []) => {
        const looksUp =
          command === 'which' && (args[0] === 'codex' || (args[0] === '-a' && args[1] === 'codex'));
        if (looksUp) return { stdout: `${BREW_COPY}\n`, stderr: '' };
        if (command === 'which' && args[0] === '/elsewhere/codex') {
          return { stdout: '/elsewhere/codex\n', stderr: '' };
        }
        if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
        if (command === BREW_COPY && args[0] === '--version') {
          return { stdout: 'codex-cli 0.147.0\n', stderr: '' };
        }
        if (command === '/elsewhere/codex' && args[0] === '--version') {
          return { stdout: 'codex-cli 0.100.0\n', stderr: '' };
        }
        throw new Error(`missing ${command}`);
      }),
      {
        dependencies: [CODEX],
        platform: 'macos',
        ledger,
        installMethodDetector: npmDetector,
      }
    );

    await probeAndSettle(manager, 'codex');

    const manual = manager
      .getHostDependency('codex')
      ?.installations.find((i) => i.id === 'path');
    expect(manual?.realpath).toBe('/elsewhere/codex');
    expect(manual?.provenance.kind).toBe('unknown');
  });
});
