// @vitest-environment jsdom
/**
 * 会话中途改的权限档 / 模型 / 推理档,**provider 确认生效之后**要写回会话记录。
 *
 * 修之前:`setMode` / `setModel` 只打到活运行时,记录里仍是建会话时那一档;重开时两条启动路
 * 读记录、运行时在 `session/load` 上重新下发 ⇒ 会话悄悄回退(权限回退到更松的档)。
 *
 * 另一半同样要紧:**只在 `applied` 之后写**。`pending_next_turn` / `restart_required` / 失败
 * 都不是事实,写进记录就是「记录说 A、实际跑 B」。
 *
 * 落库本身(改哪几个键、重开读到什么)由主进程 `record-live-session-setting.db.test.ts` 判;
 * 这里判的是渲染层**什么时候**、**拿什么值**去写。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

// 桥必须在模块图加载之前就位 —— 理由见 acp-chat-store.session-absent.test.ts 抬头。
const invokes: Array<{ channel: string; args: unknown[] }> = [];
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args });
      return Promise.resolve([]);
    },
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');

type LiveResult =
  | { success: true; data: { status: 'applied'; effectiveValue: string; channel: 'acp-mode' } }
  | { success: true; data: { status: 'pending_next_turn' | 'restart_required'; requestedValue: string; channel: 'acp-mode' } }
  | { success: false; error: unknown };

function recorded(): unknown[][] {
  return invokes
    .filter((call) => call.channel.includes('recordLiveSessionSetting'))
    .map((call) => call.args);
}

let seq = 0;
function makeStore(result: LiveResult, runtimeView?: { id: string; forkFromProviderSessionId: string }) {
  seq += 1;
  const store = new AcpChatStore(`conv-live-${seq}`, 'proj-1', runtimeView);
  store.session = {
    sessionState: { current: () => ({ activeTurnId: null }) },
    setModeOption: vi.fn(async () => result),
    setModelOption: vi.fn(async () => result),
  } as never;
  return store;
}

beforeEach(() => {
  invokes.length = 0;
});

describe('活设置:provider 确认之后才写回会话记录', () => {
  it('权限档 applied ⇒ 用 provider 确认回来的 effectiveValue 写记录', async () => {
    const store = makeStore({
      success: true,
      data: { status: 'applied', effectiveValue: 'default', channel: 'acp-mode' },
    });
    await store.setMode('default');
    expect(recorded()).toEqual([
      [store.sessionId, { dimension: 'permission', modeId: 'default' }],
    ]);
  });

  it.each(['pending_next_turn', 'restart_required'] as const)(
    '权限档 %s ⇒ 不写(还没生效)',
    async (status) => {
      const store = makeStore({
        success: true,
        data: { status, requestedValue: 'default', channel: 'acp-mode' },
      });
      await store.setMode('default');
      expect(recorded()).toEqual([]);
    },
  );

  it('权限档失败 ⇒ 不写', async () => {
    const store = makeStore({ success: false, error: new Error('nope') });
    await store.setMode('default');
    expect(recorded()).toEqual([]);
  });

  it('推理档 applied ⇒ 写', async () => {
    const store = makeStore({
      success: true,
      data: { status: 'applied', effectiveValue: 'low', channel: 'acp-mode' },
    });
    await store.setEffort('low');
    expect(recorded()).toEqual([[store.sessionId, { dimension: 'effort', value: 'low' }]]);
  });

  it('侧边聊天(运行时分叉)不写 —— 它借的是来源会话的 id', async () => {
    const store = makeStore(
      { success: true, data: { status: 'applied', effectiveValue: 'default', channel: 'acp-mode' } },
      { id: 'side-1', forkFromProviderSessionId: 'provider-1' },
    );
    await store.setMode('default');
    expect(recorded()).toEqual([]);
  });
});
