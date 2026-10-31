// @vitest-environment jsdom
/**
 * #3500 / #3507 —— 会话不在时，有副作用的动作不许静默无操作。
 *
 * 落在 `session-main`（`apps/desktop/src/session/**\/*.test.ts`，**进 CI 闸**），
 * 用 jsdom pragma 换到 DOM（先例：`lib/theme/host-theme.test.ts`）。
 *
 * 发送不在此列:不论挂没挂上,发送与排队都只走 custody(发送方 outbox → 宿主 session_pending),
 * 没收下时还字、报错的是 `sendThroughCustody` 自己。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { reaction, runInAction } from 'mobx';
import { WireError } from '@gugu/session-wire';
import { log } from '@renderer/utils/logger';

const custody = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./queue-native-input', () => ({ sendThroughCustody: custody, canQueueNativeInput: () => false }));

const toasts: Array<{ title: string; description?: string; variant?: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (arg: { title: string; description?: string; variant?: string }) => {
    toasts.push(arg);
  },
}));

/**
 * ⚠️ `lib/ipc.ts` 在**模块求值期**读 `window.electronAPI`，取不到就装一个 fail-loud 桩，
 * 于是 `new AcpChatStore` → `getSharedChatContext()` → `preloadIssueMentionIcons` 会抛
 * `electronAPI.invoke is unavailable for integrations.list`。(历史:#6888 起 preloadIssueMentionIcons 把调用放进 then,
 * 没有桥时不再同步抛;下面的顺序前提照旧保留。)
 *
 * 所以桥必须在**模块图加载之前**就位 ⇒ 用动态 import，而不是顶层静态 import。
 * 第一版就是静态 import 写的：阳性对照当场红，而其余 7 条"绿" ——
 * 因为 context 在抛错前已被缓存，后续用例复用了它。**那 7 条绿依赖测试 1 抛过异常**，
 * 是顺序依赖的假绿，vitest 自己也报了 "might cause false positive tests"。
 */
type StoreModule = typeof import('./acp-chat-store');
type StoreCtor = StoreModule['AcpChatStore'];
// 桥必须在**模块图加载之前**就位(见上),这两条 defineProperty 与那次动态 import 的先后
// 关系是本文件的正确性前提。顶层语句按序执行,该前提原样保持 —— 上面那条阳性对照守着它:
// 实测把 import 提到 defineProperty 之前,它立刻红成 `electronAPI.invoke is unavailable`。
//
// 但它们不再放在 beforeAll 里。那个钩子有 **30s 固定预算**,而这次 import 要 transform 出
// 整张 renderer 模块图(d15 idle 就要 transform ~12s)。mac1 满载时它单独超过 30s,
// 钩子一超时,20 条用例是**跳过**而不是变红 —— CI 报表上写的是 `20 tests | 20 skipped`,
// 整组守卫静默消失,没人看得出来。实测三条互不相关的分支被它打红过(2026-08-24)。
// 搬到顶层后这段耗时落在文件的 import/transform 阶段,不再撞那道悬崖:
// 慢就是慢,但不会变成「假装跑过了」。
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
const { AcpChatStore, isVisibleQueuedPrompt }: StoreModule = await import('./acp-chat-store');

let seq = 0;
function makeStore(): InstanceType<StoreCtor> {
  seq += 1;
  const store = new AcpChatStore(`conv-3500-${seq}`, 'proj-1');
  // 这就是被测场景本身：会话对象不在。
  store.session = null;
  return store;
}

beforeEach(() => {
  toasts.length = 0;
  custody.mockClear();
});

describe('#3500 发送只走 custody', () => {
  it('发送不论挂没挂上都交给 custody(在跑时由宿主排在后面),❌ 直接发给运行时', () => {
    const store = makeStore();
    store.submitPrompt('现在发送');
    store.submitPrompt('稍后发送');
    // 挂上了也一样:句柄上没有发送的口子,一旦被调到就会抛。
    store.session = {
      sessionState: { current: () => ({ isGenerating: false, pendingPermissions: [] }) },
      // oxlint-disable-next-line typescript/no-explicit-any -- 测试替身边界
    } as any;
    store.submitPrompt('挂上之后');
    expect(custody.mock.calls.map(([, text]) => text)).toEqual(['现在发送', '稍后发送', '挂上之后']);
    expect(toasts).toEqual([]);
  });

  it('exposes the submit capability after a recoverable startup failure, not after a terminal one', () => {
    const store = makeStore();
    const seen: boolean[] = [];
    const dispose = reaction(() => store.affordances.canSubmit, value => seen.push(value), { fireImmediately: true });
    try {
      runInAction(() => {
        store.historyLoading = false;
        store.loadError = { kind: 'auth_required', message: 'sign in' };
      });
      expect(store.affordances.canSubmit).toBe(true);
      store.submitPrompt('wait for sign-in');
      expect(custody).toHaveBeenCalledWith(store, 'wait for sign-in', []);
      runInAction(() => { store.loadError = { kind: 'harness_not_installed', message: 'install first' }; });
      expect(store.affordances.canSubmit).toBe(false);
      expect(seen).toEqual([true, false]);
    } finally { dispose(); }
  });
});

describe('#3507 会话不在时的其余副作用', () => {
  const absentSessionActions: Array<[
    label: string,
    title: string,
    invoke: (store: InstanceType<StoreCtor>) => void | Promise<void>,
  ]> = [
    ['delete attachment', translateSessionMessage('acpFailure.attachment'), (store) => store.deleteAttachment('blob-1')],
    ['change mode', translateSessionMessage('acpFailure.changeSetting'), (store) => store.setMode('mode-1')],
    ['change effort', translateSessionMessage('acpFailure.changeSetting'), (store) => store.setEffort('high')],
    [
      'resolve permission',
      translateSessionMessage('acpFailure.resolvePermission'),
      (store) => store.resolvePermission('request-3507', 'allow-once'),
    ],
    ['edit queued prompt', translateSessionMessage('acpFailure.editQueued'), (store) => store.editQueuedPrompt('q-1', 'edit')],
    ['delete queued prompt', translateSessionMessage('acpFailure.editQueued'), (store) => store.deleteQueuedPrompt('q-1')],
    [
      'reorder queued prompts',
      translateSessionMessage('acpFailure.editQueued'),
      (store) => store.reorderQueuedPrompts(['q-1']),
    ],
    ['send queued prompt now', translateSessionMessage('acpFailure.sendMessage'), (store) => store.sendQueuedPromptNow('q-1', { steers: false })],
    ['steer queued prompt now', translateSessionMessage('acpFailure.sendMessage'), (store) => store.sendQueuedPromptNow('q-1', { steers: true })],
  ];

  it.each(absentSessionActions)('%s fails loudly', async (_label, title, invoke) => {
    const store = makeStore();
    await invoke(store);
    expect(toasts.some((entry) => entry.title === title), `${title} was silently skipped`).toBe(true);
    expect(toasts.at(-1)?.description).toBe('ACP session is not connected');
    expect(toasts.at(-1)?.variant).toBe('destructive');
  });

  // 2026-10-02 生产:记着的模型下架 ⇒ 引擎起不来 ⇒ 换模型被「not connected」拦下,会话永远换不走。
  // 换模型不需要活会话:交回 restart-required,由面板走「宿主先写记录、再起」的重开路。
  it('change model without a live session asks for a restart on that model instead of "not connected"', async () => {
    const store = makeStore();
    await expect(store.setModel('model-1')).resolves.toEqual({ kind: 'restart-required', requestedValue: 'model-1' });
    expect(toasts.some((entry) => entry.title === translateSessionMessage('acpFailure.changeSetting'))).toBe(false);
  });

  it('history refresh fails loudly while still releasing its retained frame', async () => {
    const store = makeStore();
    await (
      store as unknown as {
        _refreshHistory: () => Promise<void>;
      }
    )._refreshHistory();
    expect(toasts.some((entry) => entry.title === translateSessionMessage('acpFailure.refreshHistory'))).toBe(true);
  });

  it('explains a disconnected history refresh and persists its cause at error level', async () => {
    const store = makeStore();
    store.session = { getHistory: async () => { throw new WireError('DISCONNECTED', 'Wire transport disconnected'); } } as never;
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await (store as unknown as { _refreshHistory: () => Promise<void> })._refreshHistory();
      expect(toasts.at(-1)).toMatchObject({
        title: translateSessionMessage('acpFailure.refreshHistory'),
        description: translateSessionMessage('taskError.connectionLost'),
      });
      expect(logged).toHaveBeenCalledWith('ACP chat action failed', {
        sessionId: store.sessionId,
        title: 'acpFailure.refreshHistory',
        error: 'Wire transport disconnected\ncode=DISCONNECTED',
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('history reconciliation does not erase a newer active turn', async () => {
    const store = makeStore();
    const oldTurn = {
      id: 'old-turn',
      seq: 0,
      initiator: 'user' as const,
      items: [{ kind: 'message' as const, id: 'old-user', seq: 0, role: 'user' as const, text: 'old' }],
      outcome: { kind: 'done' as const, reason: 'end_turn' as const },
    };
    const newTurn = {
      id: 'new-turn',
      seq: 1,
      initiator: 'user' as const,
      items: [{ kind: 'message' as const, id: 'new-user', seq: 0, role: 'user' as const, text: 'new' }],
    };
    let resolveHistory!: (result: {
      success: true;
      data: { turns: typeof oldTurn[]; nextCursor: null };
    }) => void;
    store.session = {
      getHistory: () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
      // oxlint-disable-next-line typescript/no-explicit-any -- test double for the one raced method
    } as any;
    store.chatState.transcript.activeTurn.set(oldTurn);

    const refresh = (
      store as unknown as { _refreshHistory: () => Promise<void> }
    )._refreshHistory();
    store.chatState.transcript.activeTurn.set(newTurn);
    expect(store.chatState.transcript.state.activeTurnSnapshot).toMatchObject({ id: 'new-turn' });
    resolveHistory({ success: true, data: { turns: [oldTurn], nextCursor: null } });
    await refresh;

    expect(store.chatState.transcript.state.activeTurnSnapshot).toMatchObject({ id: 'new-turn' });
    expect(store.chatState.transcript.state.committedTurns).toHaveLength(1);
  });

  it('permission decision reaches the displayed request when the session is present', () => {
    const store = makeStore();
    const delivered: Array<{ requestId: string; optionId: string }> = [];
    store.session = {
      resolvePermission: (requestId: string, optionId: string) => {
        delivered.push({ requestId, optionId });
        return Promise.resolve({ success: true as const, data: undefined });
      },
      // oxlint-disable-next-line typescript/no-explicit-any -- 测试替身边界
    } as any;
    store.resolvePermission('request-3507', 'allow-once');
    expect(delivered).toEqual([{ requestId: 'request-3507', optionId: 'allow-once' }]);
    expect(toasts).toEqual([]);
  });
});

describe('#5636 mid-turn permission mode feedback', () => {
  function makeWorkingStore(setModeOption: (modeId: string) => Promise<unknown>) {
    const store = makeStore();
    let selected = 'full-access';
    const state: {
      isGenerating: boolean;
      activeTurnId: string | null;
      pendingPermissions: never[];
    } = {
      isGenerating: true,
      activeTurnId: 'turn-1',
      pendingPermissions: [],
    };
    store.session = {
      config: { current: () => ({ modeOptions: { selected } }) },
      sessionState: { current: () => state },
      setModeOption: async (modeId: string) => {
        const result = await setModeOption(modeId);
        if ((result as { success?: boolean }).success !== false) selected = modeId;
        return result;
      },
      // oxlint-disable-next-line typescript/no-explicit-any -- focused renderer session boundary
    } as any;
    return { store, state };
  }

  it('shows the selected mode immediately and labels it for the next turn', async () => {
    const { store, state } = makeWorkingStore(async () => ({
      success: true,
      data: { status: 'applied' },
    }));

    store.setMode('read-only');

    expect(store.permissionMode).toBe('read-only');
    expect(store.permissionModeChangeNotice).toMatchObject({
      variant: 'info',
      title: 'Permission mode queued',
    });
    await Promise.resolve();
    expect(store.permissionMode).toBe('read-only');

    state.isGenerating = false;
    state.activeTurnId = null;
    expect(store.permissionMode).toBe('read-only');
    expect(store.permissionModeChangeNotice).toBeNull();
  });

  it('rolls the optimistic mode back and reports a failed update', async () => {
    const { store } = makeWorkingStore(async () => ({
      success: false,
      error: { type: 'set_mode_failed', message: 'provider unavailable' },
    }));

    store.setMode('read-only');
    expect(store.permissionMode).toBe('read-only');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.permissionMode).toBe('full-access');
    expect(store.permissionModeChangeNotice).toBeNull();
    expect(toasts.some((entry) => entry.title === translateSessionMessage('acpFailure.changeSetting'))).toBe(true);
  });
});

describe('queued prompt visibility and reorder', () => {
  it('keeps typed prompts visible while preserving communication slots', () => {
    const store = makeStore();
    const current = [
      { id: 'manual-1', text: 'manual 1', origin: 'manual' as const, createdAt: 1, updatedAt: 1 },
      { id: 'typed-1', text: 'typed 1', origin: 'typed' as const, createdAt: 2, updatedAt: 2 },
      {
        id: 'communication-1',
        text: 'communication 1',
        origin: 'communication' as const,
        createdAt: 3,
        updatedAt: 3,
      },
      { id: 'manual-2', text: 'manual 2', origin: 'manual' as const, createdAt: 4, updatedAt: 4 },
    ];
    const submitted: string[][] = [];
    store.session = {
      sessionState: { current: () => ({ queuedPrompts: current }) },
      changeQueuePromptOrder: (ids: string[]) => {
        submitted.push(ids);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      // oxlint-disable-next-line typescript/no-explicit-any -- 测试替身边界
    } as any;

    expect(current.filter(isVisibleQueuedPrompt).map((prompt) => prompt.id)).toEqual([
      'manual-1',
      'typed-1',
      'manual-2',
    ]);

    store.reorderQueuedPrompts(['manual-2', 'typed-1', 'manual-1']);

    expect(submitted).toEqual([
      ['manual-2', 'typed-1', 'communication-1', 'manual-1'],
    ]);
  });
});

describe('#6448 park: only background agents running', () => {
  function storeWithState(state: Record<string, unknown>) {
    const store = makeStore();
    store.session = {
      sessionState: { current: () => ({ pendingPermissions: [], canSubmit: true, canCancel: true, ...state }) },
      // oxlint-disable-next-line typescript/no-explicit-any -- focused renderer session boundary
    } as any;
    return store;
  }

  it('the composer sends instead of queueing: park is not the agent working', () => {
    const store = storeWithState({ lifecycle: 'ready', isGenerating: true, backgroundAgentCount: 1 });
    expect(store.affordances.isWorking).toBe(false);
    expect(store.affordances.isBusy, 'something is still running in the session').toBe(true);
  });

  it('control: the agent is working (whoever started it) or cancelling', () => {
    expect(storeWithState({ lifecycle: 'working', isGenerating: true }).affordances.isWorking).toBe(true);
    expect(storeWithState({ lifecycle: 'cancelling', isGenerating: true }).affordances.isWorking).toBe(true);
  });
});
