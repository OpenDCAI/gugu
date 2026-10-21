// @vitest-environment jsdom
/**
 * #6574 排队提示的「立即发送」按这家能不能插话分两路:能插 ⇒ 交给运行时插进在飞的那一轮
 * (一次原子调用,❌ 取消、❌ 渲染层自己拼「删 + 发」);插不了 ⇒ 挪到队首,在跑就取消。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));
const toasts: Array<{ title: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (arg: { title: string }) => {
    toasts.push(arg);
  },
}));

// 桥必须在模块图加载之前就位 —— 理由见 acp-chat-store.session-absent.test.ts 抬头。
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

const ok = { success: true as const, data: undefined };

let seq = 0;
function makeStore(
  steerResult: { success: boolean; error?: unknown } = ok,
  lifecycle: 'ready' | 'working' = 'working',
) {
  seq += 1;
  const store = new AcpChatStore(`conv-6574-${seq}`, 'proj-1');
  const session = {
    sessionState: {
      current: () => ({
        lifecycle,
        pendingPermissions: [],
        activeTurnId: lifecycle === 'working' ? 'turn-1' : null,
        queuedPrompts: [
          { id: 'q-1', text: 'first queued', origin: 'manual', createdAt: 1, updatedAt: 1 },
          { id: 'q-2', text: 'second queued', origin: 'manual', createdAt: 2, updatedAt: 2 },
        ],
      }),
    },
    steerQueuedPrompt: vi.fn(async () => steerResult),
    changeQueuePromptOrder: vi.fn(async () => ok),
    cancelTurn: vi.fn(async () => ok),
  };
  store.session = session as never;
  return { store, session };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  toasts.length = 0;
});

describe('#6574 立即发送按插话能力分两路', () => {
  it('能插话:一次交给运行时插进当前回合,❌ 重排、❌ 取消', async () => {
    const { store, session } = makeStore();
    expect(store.affordances.isWorking).toBe(true);
    store.sendQueuedPromptNow('q-2', { steers: true });
    await settle();
    expect(session.steerQueuedPrompt).toHaveBeenCalledWith('q-2');
    expect(session.changeQueuePromptOrder).not.toHaveBeenCalled();
    expect(session.cancelTurn).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('插不了:照旧挪到队首并取消在跑的回合,❌ 走插话', async () => {
    const { store, session } = makeStore();
    expect(store.affordances.isWorking).toBe(true);
    store.sendQueuedPromptNow('q-2', { steers: false });
    await settle();
    expect(session.changeQueuePromptOrder).toHaveBeenCalledWith(['q-2', 'q-1']);
    expect(session.cancelTurn).toHaveBeenCalledOnce();
    expect(session.steerQueuedPrompt).not.toHaveBeenCalled();
  });

  it('插不了且没在跑:只挪到队首', async () => {
    const { store, session } = makeStore(ok, 'ready');
    store.sendQueuedPromptNow('q-2', { steers: false });
    await settle();
    expect(session.changeQueuePromptOrder).toHaveBeenCalledWith(['q-2', 'q-1']);
    expect(session.cancelTurn).not.toHaveBeenCalled();
  });

  it('插话失败要说出来', async () => {
    const { store } = makeStore({ success: false, error: new Error('adapter refused') });
    store.sendQueuedPromptNow('q-2', { steers: true });
    await settle();
    expect(toasts.map((entry) => entry.title)).toEqual([translateSessionMessage('acpFailure.sendMessage')]);
  });

  it('已经不在队里的条目什么都不做', async () => {
    const { store, session } = makeStore();
    store.sendQueuedPromptNow('gone', { steers: true });
    await settle();
    expect(session.steerQueuedPrompt).not.toHaveBeenCalled();
  });
});
