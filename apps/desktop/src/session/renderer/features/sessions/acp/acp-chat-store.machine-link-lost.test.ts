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
 * ## 宽限(owner 同日:「每次打开都闪一下」)
 *
 * 换线是计划内的(新窗口当场开),几秒的抖动也常见:线断了先等 MACHINE_LINK_GRACE_MS,这期间回来了就悄悄再开一次,
 * ❌ 出「连接断了」那一行;等满了才说,之后线回来时照旧自己再开,那一行随之消失。
 *
 * ## 判据能判假吗
 *
 * 能:把 `_watchMachineLink` 里那句 `this.retry()` 删掉,「等满了才说」那条的最后一步红;把 catch 里等宽限那段删掉
 * (当场出那一行),换线、短断两条红;宽限里不看「在换线」(machineLinkHandingOff),换线那条红(说成原话);
 * `toLoadError` 不带机器,kind 断言红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

/** 到那台机器的线:此刻通不通,以及「从断变通」时要叫的那几位(由用例自己叫)。 */
const link = vi.hoisted(() => ({
  /** switching = 计划内换线(对外照 open 说,machineLinkHandingOff 为真)。 */
  state: 'open' as 'open' | 'closed' | 'switching',
  reconnected: new Set<() => void>(),
}));
vi.mock('@renderer/lib/machine-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/machine-clients')>()),
  machineLinkState: () => (link.state === 'switching' ? 'open' : link.state),
  machineLinkHandingOff: () => link.state === 'switching',
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
const { AcpChatStore, MACHINE_LINK_GRACE_MS } = await import('./acp-chat-store');
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

/** 对面没了 / 网断了:窗口关掉(客户端记成 closed),在途的问被拒成 wire 断开。 */
function linkDrops(): WireErrorInstance {
  link.state = 'closed';
  return disconnected();
}

/** 换线(开机时咕咕云 → 隧道):旧窗口以交接关掉、新窗口在开,在途的问被拒成 wire 断开。 */
function linkSwitches(): WireErrorInstance {
  link.state = 'switching';
  return disconnected();
}

/** 让开场跑到「等线回来」那一步(失败已落定,宽限计时开始):只推到期的计时器,宽限那只不动。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

function linkComesBack(): void {
  link.state = 'open';
  for (const cb of [...link.reconnected]) cb();
}

beforeEach(() => {
  link.state = 'open';
  link.reconnected.clear();
  create.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('起会话途中到那台机器的线断了', () => {
  it('开机换线(咕咕云 → 隧道)打断了起会话:❌ 出那一行;新窗口开好就悄悄再开', async () => {
    create.mockImplementation(() => Promise.reject(linkSwitches()));
    const store = storeOn(MACHINE);
    const first = bootstrap(store);
    await settle();
    expect(store.loadError, '换线不是断线').toBeNull();

    const restarts = countRestarts(store);
    linkComesBack();
    await first;
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(store.loadError).toBeNull();
  });

  it('断得比宽限短:什么都不出,回来就悄悄再开', async () => {
    create.mockImplementation(() => Promise.reject(linkDrops()));
    const store = storeOn(MACHINE);
    const first = bootstrap(store);
    await settle();
    await vi.advanceTimersByTimeAsync(MACHINE_LINK_GRACE_MS - 1_000);
    expect(store.loadError).toBeNull();

    const restarts = countRestarts(store);
    linkComesBack();
    await first;
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(store.loadError).toBeNull();
  });

  it('断得比宽限长:等满了才说「线断了」(带上是哪台机器);线回来就自己再开,那一行随之消失', async () => {
    create.mockImplementation(() => Promise.reject(linkDrops()));
    const store = storeOn(MACHINE);
    const first = bootstrap(store);
    await settle();
    await vi.advanceTimersByTimeAsync(MACHINE_LINK_GRACE_MS - 1);
    expect(store.loadError, '宽限还没满').toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(store.loadError).toMatchObject({ kind: 'connection_lost', deviceId: MACHINE });

    const restarts = countRestarts(store);
    expect(restarts, '线还没变通就不该再开').not.toHaveBeenCalled();
    linkComesBack();
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(store.loadError, '再开时清掉了那一行').toBeNull();
  });

  it('线在这次开场途中已经断过又通了:当场再开,❌ 等下一次变通', async () => {
    let fail!: (error: unknown) => void;
    create.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const store = storeOn(MACHINE);
    const first = bootstrap(store);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    // 断了又通 —— 比被拒的那次起会话先落定。
    const dropped = linkDrops();
    linkComesBack();
    const restarts = countRestarts(store);
    fail(dropped);
    await settle();
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

  it('关掉的会话页摘掉等线的监听;宽限里关掉的,不再开也不出那一行', async () => {
    create.mockImplementation(() => Promise.reject(linkDrops()));
    const store = storeOn(MACHINE);
    const first = bootstrap(store);
    await settle();
    expect(link.reconnected.size).toBe(1);
    const restarts = countRestarts(store);
    store.dispose();
    await first;
    expect(link.reconnected.size).toBe(0);
    expect(restarts).not.toHaveBeenCalled();
    expect(store.loadError).toBeNull();
  });
});
