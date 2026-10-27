// @vitest-environment jsdom
/**
 * 别的机器上的会话,起会话途中到那台机器的线断了:线一通就自己再开,❌ 停在「引擎没能启动」等人点「再试一次」。
 *
 * ## 2026-10-27 owner 重启咕咕撞上的
 *
 * 开机时到 d22 的线先走咕咕云,会话照常开起来;隧道通了之后设备 RPC 换通道,开着的宿主窗口随之关掉重开
 * (remoteSessionHost `channel resubscribed`),在途的那次起会话被拒成 `Wire transport disconnected`。
 * 一秒后线就重新通了,可转录末尾停在「引擎没能启动:与机器的连接已断开」,带图的那句也发不出去。
 *
 * ## 判据能判假吗
 *
 * 能:把 `_watchMachineLink` 里那句 `this.retry()` 删掉,第一条红;把 catch 里「已经通了就当场再开」那段删掉,
 * 第二条红;`toLoadError` 不带机器,第一条的 kind 断言红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

/** 到那台机器的线:此刻通不通,以及「从断变通」时要叫的那几位(由用例自己叫)。 */
const link = vi.hoisted(() => ({
  state: 'open' as 'open' | 'closed',
  reconnected: new Set<() => void>(),
}));
vi.mock('@renderer/lib/machine-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/machine-clients')>()),
  machineLinkState: () => link.state,
  onMachineReconnected: (_deviceId: string, cb: () => void) => {
    link.reconnected.add(cb);
    return () => link.reconnected.delete(cb);
  },
}));

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例)。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: () => Promise.resolve([]),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');
const { AcpLiveSession } = await import('@renderer/lib/acp/acp-live-session');
const { machineRegistry } = await import('@renderer/lib/machine-routing');
const { WireError } = await import('@gugu/session-wire');

type Store = InstanceType<typeof AcpChatStore>;
type Bootstrapping = { _runBootstrap(options?: { attachOnly?: boolean }): Promise<void> };

const MACHINE = 'device-d22';
const create = vi.spyOn(AcpLiveSession, 'create');
const disconnected = () => new WireError('DISCONNECTED', 'Wire transport disconnected');
type WireErrorInstance = ReturnType<typeof disconnected>;

function storeOn(machine: string | null): Store {
  const id = crypto.randomUUID();
  if (machine) machineRegistry.register(machine, [id]);
  return new AcpChatStore(id, 'proj-1');
}

/** 开场一次(纯附着:不需要库里有这条会话的起始输入),起引擎那一步按 `create` 给的结果走。 */
function bootstrap(store: Store): Promise<void> {
  return (store as unknown as Bootstrapping)._runBootstrap({ attachOnly: true });
}

/** 之后的每一次开场只数次数,❌ 真跑(真跑要整条会话登记)。 */
function countRestarts(store: Store) {
  return vi.spyOn(store as unknown as Bootstrapping, '_runBootstrap').mockResolvedValue(undefined);
}

/** 换通道 / 对面重启:窗口关掉(客户端记成 closed),在途的问被拒成 wire 断开。 */
function linkDrops(): WireErrorInstance {
  link.state = 'closed';
  return disconnected();
}

function linkComesBack(): void {
  link.state = 'open';
  for (const cb of [...link.reconnected]) cb();
}

beforeEach(() => {
  link.state = 'open';
  link.reconnected.clear();
  create.mockReset();
});

describe('起会话途中到那台机器的线断了', () => {
  it('说成「线断了」(带上是哪台机器),线一通就自己再开一次', async () => {
    create.mockImplementation(() => Promise.reject(linkDrops()));
    const store = storeOn(MACHINE);
    await bootstrap(store);
    expect(store.loadError).toMatchObject({ kind: 'connection_lost', deviceId: MACHINE });

    const restarts = countRestarts(store);
    expect(restarts, '线还没变通就不该再开').not.toHaveBeenCalled();
    linkComesBack();
    expect(restarts).toHaveBeenCalledTimes(1);
  });

  it('线在这次开场途中已经断过又通了:当场再开,❌ 等下一次变通', async () => {
    let fail!: (error: unknown) => void;
    create.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const store = storeOn(MACHINE);
    const first = bootstrap(store);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    // 换通道:窗口关掉、一秒后重开 —— 比被拒的那次起会话先落定。
    const dropped = linkDrops();
    linkComesBack();
    const restarts = countRestarts(store);
    fail(dropped);
    await first;

    expect(restarts).toHaveBeenCalledTimes(1);
    expect(store.loadError, '再开时清掉了那一条').toBeNull();
  });

  it('线一直通着、断的只是这一条 wire:没有「连上」可等,照旧按原话说、不自己再开', async () => {
    create.mockRejectedValue(disconnected());
    const store = storeOn(MACHINE);
    await bootstrap(store);
    expect(store.loadError?.kind).toBe('generic');
  });

  it('线变通时这条会话不是「线断了」的失败:不动它', async () => {
    create.mockRejectedValue(new Error('provider refused'));
    const store = storeOn(MACHINE);
    await bootstrap(store);
    expect(store.loadError?.kind).toBe('generic');

    const restarts = countRestarts(store);
    linkComesBack();
    expect(restarts).not.toHaveBeenCalled();
  });

  it('本机会话没有那条线:照旧按原话说,不挂等线的监听', async () => {
    create.mockRejectedValue(disconnected());
    const store = storeOn(null);
    await bootstrap(store);
    expect(store.loadError?.kind).toBe('generic');
    expect(link.reconnected.size).toBe(0);
  });

  it('关掉的会话页摘掉等线的监听', async () => {
    create.mockImplementation(() => Promise.reject(linkDrops()));
    const store = storeOn(MACHINE);
    await bootstrap(store);
    expect(link.reconnected.size).toBe(1);
    store.dispose();
    expect(link.reconnected.size).toBe(0);
  });
});
