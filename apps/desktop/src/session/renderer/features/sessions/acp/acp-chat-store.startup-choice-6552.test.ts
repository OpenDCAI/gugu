// @vitest-environment jsdom
/**
 * #6552 —— 会话还在起(引擎会话没挂上)时,模型 / 强度照样能选。
 *
 * 选择交给运行时,由启动在 `session/new` 之后设模型/强度的那一步采用(运行时那一侧见
 * session-startup-choice-6552.test.ts)。这一侧的合同:界面立刻显示选的值;没设成就撤回并报错;
 * 不在起的时候(没会话、也没有开场在飞)照旧响亮失败,❌ 不把选择悄悄丢给一个不存在的启动。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { runInAction } from 'mobx';

const setModelOption = vi.fn();
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ setModelOption }),
}));

const toasts: Array<{ title: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (arg: { title: string }) => {
    toasts.push(arg);
  },
}));

type StoreModule = typeof import('./acp-chat-store');

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例与理由)。
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
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

let seq = 0;
function makeStore(opts: { starting: boolean }) {
  seq += 1;
  const store = new AcpChatStore(`conv-6552-${seq}`, 'proj-1');
  runInAction(() => {
    (store as unknown as { _bootstrapped: boolean; _bootstrapsInFlight: number })._bootstrapped = true;
    (store as unknown as { _bootstrapsInFlight: number })._bootstrapsInFlight = opts.starting ? 1 : 0;
  });
  return store;
}

beforeEach(() => {
  toasts.length = 0;
  setModelOption.mockReset();
});

describe('#6552 choosing while the session starts', () => {
  it('阳性对照:开场在飞、会话没挂上 = 在起', () => {
    const store = makeStore({ starting: true });
    expect(store.session).toBeNull();
    expect(store.starting).toBe(true);
  });

  it('模型交给运行时,界面立刻显示所选,应答与活会话热切同形', async () => {
    let settle!: (value: unknown) => void;
    const handedOver = Promise.withResolvers<void>();
    setModelOption.mockImplementation(() => new Promise((resolve) => {
      settle = resolve;
      handedOver.resolve();
    }));
    const store = makeStore({ starting: true });

    const outcome = store.setModel('model-b');
    await handedOver.promise;
    expect(setModelOption).toHaveBeenCalledWith({
      sessionId: store.sessionId,
      dimension: 'model',
      value: 'model-b',
    });
    expect(store.model).toBe('model-b');

    settle({ success: true, data: { status: 'applied', effectiveValue: 'model-b', channel: 'acp-config-option' } });
    expect(await outcome).toEqual({ kind: 'applied', effectiveValue: 'model-b' });
    expect(toasts).toEqual([]);
  });

  it('强度同理', async () => {
    setModelOption.mockResolvedValue({
      success: true,
      data: { status: 'applied', effectiveValue: 'low', channel: 'acp-config-option' },
    });
    const store = makeStore({ starting: true });
    expect(await store.setEffort('low')).toEqual({ kind: 'applied', effectiveValue: 'low' });
    expect(setModelOption).toHaveBeenCalledWith(expect.objectContaining({ dimension: 'effort', value: 'low' }));
  });

  it('没设成:撤回所选,并报错', async () => {
    setModelOption.mockResolvedValue({ success: false, error: new Error('session did not start') });
    const store = makeStore({ starting: true });
    expect(await store.setModel('model-b')).toBeNull();
    expect(store.model).toBeNull();
    expect(toasts.some((t) => t.title === translateSessionMessage('acpFailure.changeSetting'))).toBe(true);
  });

  it('不在起(没有开场在飞):❌ 不交给运行时,交回「按这个模型重开」(不拿 not connected 拦)', async () => {
    const store = makeStore({ starting: false });
    expect(await store.setModel('model-b')).toEqual({ kind: 'restart-required', requestedValue: 'model-b' });
    expect(setModelOption).not.toHaveBeenCalled();
    expect(toasts.some((t) => t.title === translateSessionMessage('acpFailure.changeSetting'))).toBe(false);
  });
});
