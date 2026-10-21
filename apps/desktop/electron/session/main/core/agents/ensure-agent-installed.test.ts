import { describe, expect, it, vi } from 'vitest';
import {
  AgentInstallFailedError,
  createEnsureAgentInstalled,
  describeAgentInstallFailure,
  describeHarnessRuntimeMissing,
  describeStuckAt,
  isHarnessRuntimeMissing,
  type EnsureAgentInstalledDeps,
} from './ensure-agent-installed';

function deps(overrides: Partial<EnsureAgentInstalledDeps> = {}): EnsureAgentInstalledDeps {
  return {
    probe: vi.fn(async () => {}),
    status: vi.fn(async () => 'missing'),
    install: vi.fn(async () => ({ success: true as const })),
    ...overrides,
  };
}

describe('ensureAgentInstalled(#6264 第 6 条:没装的当场装上)', () => {
  it('已装好:先探一遍,不装', async () => {
    const d = deps({ status: vi.fn(async () => 'available') });
    await createEnsureAgentInstalled(d)('codex');
    expect(d.probe).toHaveBeenCalledOnce();
    expect(d.install).not.toHaveBeenCalled();
  });

  it('没装:走装法装上', async () => {
    const d = deps();
    await createEnsureAgentInstalled(d)('codex');
    expect(d.install).toHaveBeenCalledWith('codex', expect.any(AbortSignal));
  });

  it('同一家同时来两次:只装一趟,后到的等同一趟(❌ 不报「已有安装在跑」)', async () => {
    let release!: () => void;
    const installing = Promise.withResolvers<void>();
    const d = deps({
      install: vi.fn(() => new Promise<{ success: true }>((resolve) => {
        release = () => resolve({ success: true });
        installing.resolve();
      })),
    });
    const ensure = createEnsureAgentInstalled(d);
    const a = ensure('codex');
    const b = ensure('codex');
    await installing.promise;
    expect(d.install).toHaveBeenCalledOnce();
    release();
    await Promise.all([a, b]);
    expect(d.install).toHaveBeenCalledOnce();
  });

  it('装失败:抛 AgentInstallFailedError,话里有是哪家、为什么、输出里那行原因', async () => {
    const d = deps({
      install: vi.fn(async () => ({
        success: false as const,
        error: {
          type: 'command-failed' as const,
          message: 'exit 1',
          output: '\u001b[31m⣿⣿⣿\u001b[0m\nnpm error code ENOTFOUND\nnpm error network request failed',
        },
      })),
    });
    const failure = await createEnsureAgentInstalled(d)('codex').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentInstallFailedError);
    const message = (failure as Error).message;
    expect(message).toContain('在这台机器上安装 codex 失败');
    expect(message).toContain('Failed to install codex');
    expect(message).toContain('npm error code ENOTFOUND');
    expect(message).not.toMatch(/[⠀-⣿]|\u001b/);
    // 失败之后再来一次会重新装(失败的那趟不留在 in-flight 里)。
    await createEnsureAgentInstalled(d)('codex').catch(() => {});
    expect(d.install).toHaveBeenCalledTimes(2);
  });

  it('装法本身抛异常(比如设置页那边正在装):同样包成那一句人话', async () => {
    const d = deps({ install: vi.fn(async () => { throw new Error('An installation operation is already running.'); }) });
    await expect(createEnsureAgentInstalled(d)('claude')).rejects.toThrow(
      /在这台机器上安装 claude 失败.*already running/,
    );
  });

  it('从 mise 的输出里挑出真正的原因行(咕咕 server 上实测的那段输出),而不是「依赖失败被跳过」', () => {
    const output = [
      'mise by @jdx – installing 2 tools',
      'mise ✗ node@24.14.0 · failed: failed create_dir_all: ~/agents/mise/data/installs/node/24.14.0',
      'mise ✗ npm:@earendil-works/pi-coding-agent@0.87.1 · failed: Skipped due to failed dependency',
      'mise ERROR Failed to install node@24.14.0: failed create_dir_all: ~/agents/mise/data/installs/node/24.14.0: Permission denied (os error 13)',
      'mise ERROR Version: 2026.9.12 linux-arm64 (2026-09-20)',
      'mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information',
    ].join('\n');
    const message = describeAgentInstallFailure('pi', { type: 'command-failed', message: 'exit 1', output });
    expect(message).toContain('Permission denied (os error 13)');
    expect(message).not.toContain('Skipped due to failed dependency');
  });

  it('每一种安装错误都有人话,不是 JSON', () => {
    expect(describeAgentInstallFailure('codex', { type: 'unsupported-host', message: 'x' })).toContain('手动安装');
    expect(describeAgentInstallFailure('codex', { type: 'no-install-command', id: 'codex' })).not.toContain('{');
    expect(
      describeAgentInstallFailure('codex', { type: 'stalled', message: 'x', output: '', idleMs: 60_000 }),
    ).toContain('60 秒');
  });
});

describe('取消传到安装器(#7199:云端 agent.create 取消时,装 harness 那一段以前停不下来)', () => {
  /** 一个只在被取消时才结束的安装:看它拿到的 signal 有没有被取消。 */
  function hangingInstall() {
    const seen: AbortSignal[] = [];
    const install = vi.fn((_provider: string, signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<{ success: false; error: { type: 'cancelled'; message: string; output: string } }>((resolve) => {
        signal.addEventListener('abort', () => resolve({ success: false, error: { type: 'cancelled', message: 'x', output: '' } }), { once: true });
      });
    });
    return { install, seen };
  }

  it('唯一的等待方取消了:安装器拿到的 signal 跟着取消,等待方当场返回', async () => {
    const { install, seen } = hangingInstall();
    const ensure = createEnsureAgentInstalled(deps({ install }));
    const cancel = new AbortController();
    const waiting = ensure('claude', cancel.signal);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(seen[0]!.aborted).toBe(false);
    cancel.abort(new Error('agent.create cancelled'));
    await expect(waiting).rejects.toThrow('agent.create cancelled');
    expect(seen[0]!.aborted).toBe(true);
  });

  it('两个人在等同一趟,一个取消:❌ 连累另一个,安装照常进行', async () => {
    let finish!: () => void;
    const seen: AbortSignal[] = [];
    const install = vi.fn((_provider: string, signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<{ success: true }>((resolve) => { finish = () => resolve({ success: true }); });
    });
    const ensure = createEnsureAgentInstalled(deps({ install }));
    const a = new AbortController();
    const first = ensure('claude', a.signal);
    const second = ensure('claude');
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    a.abort(new Error('first gave up'));
    await expect(first).rejects.toThrow('first gave up');
    expect(seen[0]!.aborted).toBe(false);
    finish();
    await expect(second).resolves.toBeUndefined();
    expect(install).toHaveBeenCalledOnce();
  });

  it('取消之后马上重来:❌ 挂到那趟正在收尾的安装上跟着报取消,等它收完再起一趟新的', async () => {
    let finishCancelled!: () => void;
    const install = vi
      .fn()
      .mockImplementationOnce((_provider: string, signal: AbortSignal) => new Promise((resolve) => {
        // 被取消后不立刻结束:安装器还在收尾(停 mise、放锁)。
        signal.addEventListener('abort', () => { finishCancelled = () => resolve({ success: false, error: { type: 'cancelled', message: 'x', output: '' } }); }, { once: true });
      }))
      .mockImplementationOnce(async () => ({ success: true }));
    const ensure = createEnsureAgentInstalled(deps({ install }));
    const cancel = new AbortController();
    const first = ensure('claude', cancel.signal);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    cancel.abort(new Error('cancelled'));
    await expect(first).rejects.toThrow('cancelled');
    const retry = ensure('claude');
    await vi.waitFor(() => expect(finishCancelled).toBeTypeOf('function'));
    finishCancelled();
    await expect(retry).resolves.toBeUndefined();
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('两个带取消的都取消了:安装才停', async () => {
    const { install, seen } = hangingInstall();
    const ensure = createEnsureAgentInstalled(deps({ install }));
    const a = new AbortController();
    const b = new AbortController();
    const first = ensure('claude', a.signal);
    const second = ensure('claude', b.signal);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    a.abort(new Error('a'));
    await expect(first).rejects.toThrow('a');
    expect(seen[0]!.aborted).toBe(false);
    b.abort(new Error('b'));
    await expect(second).rejects.toThrow('b');
    expect(seen[0]!.aborted).toBe(true);
  });
});

describe('装不上时说清停在哪一步(#7199)', () => {
  it('下载那一步:已下多少 / 共多少、多快、过了多久', () => {
    const message = describeAgentInstallFailure('claude', {
      type: 'command-failed',
      message: 'x',
      output: 'mise ERROR connection reset by peer',
      stage: 'download',
      lastProgress: { phase: 'downloading', bytesDone: 45_000_000, bytesTotal: 119_473_462, bytesPerSecond: 1_100_000, elapsedMs: 41_000 },
    });
    expect(message).toContain('停在:下载');
    expect(message).toContain('45.0/119.5 MB');
    expect(message).toContain('1.1 MB/s');
    expect(message).toContain('41s');
    expect(message).toContain('connection reset by peer');
  });

  it('分母不知道就只说已下多少,❌ 不编总量', () => {
    expect(describeStuckAt({ phase: 'downloading', bytesDone: 3_000_000, elapsedMs: 9_000 })).toContain('3.0 MB');
    expect(describeStuckAt({ phase: 'downloading', bytesDone: 3_000_000, elapsedMs: 9_000 })).not.toMatch(/\d\/\d/);
  });

  it('取清单 / 解压安装 / 校验各有说法', () => {
    expect(describeStuckAt({ phase: 'resolving', elapsedMs: 20_000 })).toContain('取清单');
    expect(describeStuckAt({ phase: 'installing', elapsedMs: 1_000 })).toContain('解压安装');
    expect(describeStuckAt({ phase: 'verifying', elapsedMs: 1_000 })).toContain('校验');
  });

  it('没有进度读数就不加这一段', () => {
    const message = describeAgentInstallFailure('claude', { type: 'cancelled', message: 'x', output: '' });
    expect(message).not.toContain('停在');
  });
});

describe('isHarnessRuntimeMissing / describeHarnessRuntimeMissing(#6264 server 包缺适配器)', () => {
  it('认得 CJS 与 ESM 两种「模块解析不到」', () => {
    expect(isHarnessRuntimeMissing("Cannot find module '@agentclientprotocol/claude-agent-acp/dist/index.js'\nRequire stack:\n- /x")).toBe(true);
    expect(isHarnessRuntimeMissing('{"type":"spawn_failed","cause":{"code":"MODULE_NOT_FOUND"}}')).toBe(true);
    expect(isHarnessRuntimeMissing("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /x")).toBe(true);
  });

  it('别的失败不算', () => {
    expect(isHarnessRuntimeMissing('spawn EACCES')).toBe(false);
    expect(isHarnessRuntimeMissing('auth_required')).toBe(false);
  });

  it('人话:中英两句、说下一步,不带原文', () => {
    const text = describeHarnessRuntimeMissing('claude');
    expect(text).toContain('更新到最新版本');
    expect(text).toContain('update Gugu on that machine');
    expect(text).not.toMatch(/module|stack/i);
  });
});
