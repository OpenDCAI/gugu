import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';
import { sessionDeliveryFailedChannel } from '@shared/core/sessions/sessionEvents';

const runtimeHydrate = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', async () => {
  const { createEventEmitter } = await import('@shared/lib/ipc/events');
  const listeners = new Map<string, (data: unknown) => void>();
  return {
    events: createEventEmitter({
      emit: (name, data) => listeners.get(name)?.(data),
      on: (name, callback) => { listeners.set(name, callback); return () => { listeners.delete(name); }; },
    }),
    rpc: { sessions: {
      getRuntimeUpgradeRequirement: async () => null,
      hydrateSession: runtimeHydrate,
    } },
  };
});
import { events } from '@renderer/lib/ipc';

// 这几条用例判的是**界面侧的接线**:hydrate 失败之后,用户手里到底还有没有一个看得见、
// 按得动的东西。reconciler 用真实实现,只把 toast 与 registry 换成探针 —— 换掉被测对象本身
// 就等于自证。toast 探针留着当阴控:#7103 起 hydrate 失败 ❌ 再弹 toast,有人加回来这里会红。
const toastError = vi.fn();
const toastDismiss = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    dismiss: (...args: unknown[]) => toastDismiss(...args),
  },
}));

const registryGet = vi.fn();
vi.mock('./session-registry', () => ({
  sessionRegistry: { get: (sessionId: string) => registryGet(sessionId) },
}));

// 会话页那一份的挂载态:默认挂好(provisioned);闲置回收那条用例把它挂起再挂回。
const pageState = observable.box<'provisioned' | 'unprovisioned'>('provisioned');
vi.mock('./session-selectors', () => ({
  getSessionPageStore: () => ({ state: pageState.get() }),
}));

vi.mock('@renderer/utils/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// #7103 人点的重试先让宿主清掉签咕咕额度的退避;探针记下它在 hydrate 之前被叫到。
const askPlatformAgain = vi.fn((_sessionId: string) => Promise.resolve());
vi.mock('../platform-retry', () => ({
  askPlatformAgain: (sessionId: string) => askPlatformAgain(sessionId),
}));

import { i18n } from '@/i18n';
import { SessionPtyManager } from './session-pty-manager';
import { sessionStartupFailureBridge, sessionStartupFailures } from './session-startup-failures';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStore(hydrate: ReturnType<typeof vi.fn>) {
  return {
    projectId: 'project-1',
    hydrateSession: hydrate,
    dehydrateSession: vi.fn().mockResolvedValue(undefined),
    sessions: new Map(),
  };
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
}

function ledgerRow(sessionId: string) {
  return sessionStartupFailures.snapshot().find((r) => r.sessionId === sessionId);
}

describe('SessionPtyManager 的失败提示', () => {
  it('registry arrival wakes held tabs without another acquire, and disposed tabs stay stopped', async () => {
    vi.useFakeTimers();
    const registry = observable.box<ReturnType<typeof makeStore> | undefined>(undefined, { deep: false });
    registryGet.mockImplementation(() => registry.get());
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionPtyManager('late-registry');
    try {
      manager.acquire('kept');
      manager.acquire('closed');
      manager.release('closed');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(toastError).not.toHaveBeenCalled();
      runInAction(() => registry.set(makeStore(hydrate)));
      await flush();
      expect(hydrate.mock.calls).toEqual([['kept']]);
      manager.dispose();
      runInAction(() => registry.set(makeStore(hydrate)));
      await flush();
      expect(hydrate).toHaveBeenCalledOnce();
    } finally { manager.dispose(); vi.useRealTimers(); }
  });

  // spec idle-reclaim:回收停掉进程、把会话挂起成「没准备」,页签留着(#6950)。57.1 上这里不放手,
  // reconciler 停在 running,点回来不再 hydrate —— 终端连着一个已经没了的 pty(Chole 10-07 三条会话)。
  it('会话挂起时放手、再挂好时按原会话重新 hydrate —— 页签一直开着', async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const store = makeStore(hydrate);
    registryGet.mockReturnValue(store);
    const manager = new SessionPtyManager('reclaimed');
    try {
      manager.acquire('reclaimed');
      await flush();
      expect(hydrate.mock.calls).toEqual([['reclaimed']]);
      runInAction(() => pageState.set('unprovisioned'));
      await flush();
      expect(store.dehydrateSession.mock.calls).toEqual([['reclaimed']]);
      expect(hydrate).toHaveBeenCalledOnce();
      runInAction(() => pageState.set('provisioned'));
      await flush();
      expect(hydrate.mock.calls).toEqual([['reclaimed'], ['reclaimed']]);
    } finally {
      manager.dispose();
      runInAction(() => pageState.set('provisioned'));
    }
  });

  beforeEach(() => {
    globalThis.requestAnimationFrame = vi.fn() as unknown as typeof requestAnimationFrame;
    toastError.mockClear();
    toastDismiss.mockClear();
    registryGet.mockReset();
    askPlatformAgain.mockClear();
    runtimeHydrate.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
    await i18n.changeLanguage('zh-CN');
  });

  // #7103 同一次失败只说一次:任务页上说它的是内容区那一格,对话页上是私聊横幅,两者都读账本 ——
  // ❌ 再在角落弹一条 toast。账本给读者的那一句跟界面语言走(@@@4891:两语各跑一遍,写死的字符串只满足一边);
  // 咕咕这一侧的失败(宿主那一层按错误类型带了原因码)按原因表说;咕咕以外的(harness 起不来)递它的原话一行,去掉路径。
  it.each([
    ['en-US', "Something went wrong on Gugu's side."],
    ['zh-CN', '咕咕这边出错了。'],
  ])('hydrate 失败只进账本、不弹 toast,账本那一句随 %s 走', async (locale, text) => {
    await i18n.changeLanguage(locale);
    const hydrate = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'pty:start': Error: gugu-models:service-unavailable"));
    registryGet.mockReturnValue(makeStore(hydrate));

    const manager = new SessionPtyManager(`task-${locale}`);
    manager.acquire(`conversation-${locale}`);
    await flush();

    expect(toastError).not.toHaveBeenCalled();
    const row = ledgerRow(`conversation-${locale}`);
    expect(row?.message).toContain('gugu-models:service-unavailable');
    expect(sessionStartupFailureBridge.describe(row!.message)).toEqual({ text, retryable: true });
    manager.dispose();
  });

  it('咕咕以外的失败(#4657)递拒绝方的原话:一行、去掉路径;原话是空的才说「咕咕这边出错了」', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(sessionStartupFailureBridge.describe("Error invoking remote method 'pty:start': Error: spawn /Users/someone/.local/bin/claude ENOENT\n    at stack")).toEqual({
      text: 'spawn [path] ENOENT',
      retryable: true,
    });
    expect(sessionStartupFailureBridge.describe('')).toEqual({ text: '咕咕这边出错了。', retryable: true });
  });

  // 恢复失败按构造是咕咕这一侧的(恢复协调器):不带码的原文 ❌ 当原话递出去(#7103 评审 F1)。
  it('咕咕这一侧的失败(origin=gugu)不带码也说「咕咕这边出错了」;登录失效可以再起一次', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(sessionStartupFailureBridge.describe('gateway rejected replacement credential', 'gugu')).toEqual({
      text: '咕咕这边出错了。',
      retryable: true,
    });
    // 阳控:同一句不说是咕咕这一侧时,照原话递(上面那一条判的是 origin 起了作用)。
    expect(sessionStartupFailureBridge.describe('gateway rejected replacement credential').text).toBe('gateway rejected replacement credential');
    expect(sessionStartupFailureBridge.describe("Error invoking remote method 'pty:start': Error: gugu-models:signed-out")).toEqual({
      text: '咕咕的登录已失效，重新登录后再发一次。',
      retryable: true,
    });
  });

  it('带原因码的失败按原因表说;重试改变不了的(要会员)不给重试', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(sessionStartupFailureBridge.describe("Error invoking remote method 'pty:start': Error: gugu-models:membership-required")).toEqual({
      text: '这个咕咕模型要开会员才能用。换个模型，或开通会员后再发一次。',
      retryable: false,
    });
  });

  it('按下重试真的让这条会话重来一次,成功了账本收掉', async () => {
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(new Error('grant owner mismatch'))
      .mockResolvedValueOnce(undefined);
    registryGet.mockReturnValue(makeStore(hydrate));

    const manager = new SessionPtyManager('task-1');
    manager.acquire('conversation-1');
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);

    expect(sessionStartupFailures.retry('conversation-1')).toBe(true);
    await flush();

    // 真的重来了 —— ❌ 不是只把提示关掉了事。
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(ledgerRow('conversation-1')).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('a resumed process failure reaches the existing ledger and retries the same task once', async () => {
    registryGet.mockReturnValue(makeStore(vi.fn().mockResolvedValue(undefined)));
    const manager = new SessionPtyManager('resume-task');
    try {
      manager.acquire('resume-task');
      await flush();
      const message = 'Agent session failed to resume thread 01a15d37-1674-7061-b298-37b108e1e970 (exit code 1).'
        + ' Retry restoring this task; if the original thread was deleted, start a new task.';
      events.emit(sessionDeliveryFailedChannel, { sessionId: 'another-task', projectId: 'project-1', message });
      expect(ledgerRow('resume-task')).toBeUndefined();
      events.emit(sessionDeliveryFailedChannel, { sessionId: 'resume-task', projectId: 'project-1', message });
      expect(ledgerRow('resume-task')?.message).toBe(message);
      expect(sessionStartupFailures.retry('resume-task')).toBe(true);
      expect(sessionStartupFailures.retry('resume-task')).toBe(false);
      await flush();
      expect(runtimeHydrate.mock.calls).toEqual([['project-1', 'resume-task']]);
      expect(ledgerRow('resume-task')).toBeUndefined();
      expect(toastError).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });

  it('关掉最后一个标签页时把失败一并收走,不留孤儿', async () => {
    const hydrate = vi.fn().mockRejectedValue(new Error('boom'));
    registryGet.mockReturnValue(makeStore(hydrate));

    const manager = new SessionPtyManager('task-1');
    manager.acquire('conversation-1');
    await flush();
    expect(ledgerRow('conversation-1')).toBeDefined();

    manager.release('conversation-1');
    await flush();

    // 账本同步清掉:重开标签页就是一次干净的重试,对话页那边的提示也随之收敛。
    expect(ledgerRow('conversation-1')).toBeUndefined();
    manager.dispose();
  });

  // #4602 —— 对话页那棵树读的是账本本身。
  it('hydrate 失败写进会话启动失败账本(带根因原文),对话页据此显形', async () => {
    const hydrate = vi.fn().mockRejectedValue(new Error('request timed out: POST /session'));
    registryGet.mockReturnValue(makeStore(hydrate));

    const manager = new SessionPtyManager('task-ledger');
    manager.acquire('conversation-ledger');
    await flush();

    expect(ledgerRow('conversation-ledger')).toEqual({
      sessionId: 'conversation-ledger',
      message: 'request timed out: POST /session',
      retrying: false,
      // 这里没有宿主桥:版本判定取不回来 ⇒ 停在 null,失败本身照常显形(#6341)。
      runtimeUpgrade: null,
    });
    manager.dispose();
    expect(ledgerRow('conversation-ledger')).toBeUndefined();
  });

  it('#6341 版本判定只挂到当前这条失败上:重试飞行中或条目已清时丢掉', () => {
    const requirement = {
      providerId: 'codex',
      installedVersion: '0.147.0',
      supportedFloor: '0.153.0',
      executable: '/opt/homebrew/bin/codex',
    };
    sessionStartupFailures.report({ sessionId: 'c-upgrade', message: 'boom', retry: () => {} });
    sessionStartupFailures.setRuntimeUpgrade('c-upgrade', requirement);
    expect(ledgerRow('c-upgrade')?.runtimeUpgrade).toEqual(requirement);
    // 新一轮失败:判定清零,等主进程对这一次重新作答。
    sessionStartupFailures.report({ sessionId: 'c-upgrade', message: 'again', retry: () => {} });
    expect(ledgerRow('c-upgrade')?.runtimeUpgrade).toBeNull();
    sessionStartupFailures.markRetrying('c-upgrade');
    sessionStartupFailures.setRuntimeUpgrade('c-upgrade', requirement);
    expect(ledgerRow('c-upgrade')?.runtimeUpgrade).toBeNull();
    sessionStartupFailures.clear('c-upgrade');
    sessionStartupFailures.setRuntimeUpgrade('c-upgrade', requirement);
    expect(ledgerRow('c-upgrade')).toBeUndefined();
  });

  it('经账本重试:飞行中条目留着并标「重试中」;再失败换成新原文;成功后账本里不再有它', async () => {
    const second = deferred();
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(undefined);
    registryGet.mockReturnValue(makeStore(hydrate));

    const manager = new SessionPtyManager('task-retry');
    manager.acquire('conversation-retry');
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);

    expect(sessionStartupFailures.retry('conversation-retry')).toBe(true);
    await flush();
    expect(askPlatformAgain).toHaveBeenCalledWith('conversation-retry');
    expect(askPlatformAgain.mock.invocationCallOrder[0]).toBeLessThan(hydrate.mock.invocationCallOrder[1]!);
    expect(hydrate).toHaveBeenCalledTimes(2);
    // 重试在飞:❌ 不能把这一段显示成「没事了」—— 条目还在,只是标了重试中。
    expect(ledgerRow('conversation-retry')).toMatchObject({ message: 'first failure', retrying: true });
    // 飞行中再按一次是空操作,不会叠加第二次 hydrate。
    expect(sessionStartupFailures.retry('conversation-retry')).toBe(false);
    expect(hydrate).toHaveBeenCalledTimes(2);

    second.reject(new Error('second failure'));
    await flush();
    // 第二次也失败:账本里是新的那条原文,❌ 不是旧的;重试出口重新可用。
    expect(ledgerRow('conversation-retry')).toMatchObject({ message: 'second failure', retrying: false });

    expect(sessionStartupFailures.retry('conversation-retry')).toBe(true);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(ledgerRow('conversation-retry')).toBeUndefined();
    // 已经没有这条了:重试回 false(合法竞态),❌ 不 throw。
    expect(sessionStartupFailures.retry('conversation-retry')).toBe(false);
    manager.dispose();
  });

  it('标签页在 hydrate 飞行途中关掉,迟到的失败不挂到界面上(没有主人的失败无处收敛)', async () => {
    const pending = deferred();
    const hydrate = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    registryGet.mockReturnValue(makeStore(hydrate));

    const manager = new SessionPtyManager('task-stale');
    manager.acquire('conversation-stale');
    manager.release('conversation-stale');
    pending.reject(new Error('request timed out: POST /session'));
    await flush();

    expect(toastError).not.toHaveBeenCalled();
    expect(ledgerRow('conversation-stale')).toBeUndefined();

    // 重开标签页:干净地再 hydrate 一次,成功之后账本里也不会冒出旧失败。
    manager.acquire('conversation-stale');
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(ledgerRow('conversation-stale')).toBeUndefined();
    manager.dispose();
  });
});
