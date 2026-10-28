// @vitest-environment jsdom
/**
 * #3500 —— 会话不在时，用户的输入不许被静默丢弃。
 *
 * 落在 `session-main`（`apps/desktop/src/session/**\/*.test.ts`，**进 CI 闸**），
 * 用 jsdom pragma 换到 DOM（先例：`lib/theme/host-theme.test.ts`）。
 *
 * ## 修复前是什么样
 *
 * `submitPrompt` 先把乐观消息塞进 `pendingPrompt`，再 `void this.session?.sendPrompt(...)`。
 * 会话对象不在时整条可选链短路 ⇒ **不发、不报错、连 `.then(… && toast)` 都一起消失**，
 * 而那条消息停在屏幕上。用户以为发出去了。
 *
 * ## 为什么必须三条一起验
 *
 * 1. **乐观行被回滚** —— 只验这条会被"什么都不做"的实现满足：消息本来就在，
 *    区分不出"回滚了"和"从没插入过"
 * 2. **用户看到了错误** —— 只验这条会被"消息留着、旁边弹个错"满足：用户仍以为发出去过
 * 3. **文字被还回输入框** —— ⚠️ 这一条是票面没写、但不加就会**修出比原来更糟的结果**的：
 *    `acp-chat-panel.tsx:304-307` 在调用 `submitPrompt` **之前**就 `editor.clear()` 了，
 *    所以只做 1+2 会让用户输入的内容在**屏幕和输入框里同时消失**——
 *    修之前它至少还以气泡形式留着。
 *
 * 三条合起来才描述**「用户知道自己需要重发，并且还能重发」**，那才是真正的验收对象。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { reaction, runInAction } from 'mobx';
import { WireError } from '@gugu/session-wire';
import { log } from '@renderer/utils/logger';

const startupQueue = vi.fn().mockResolvedValue({ success: true, data: { queued: true } });
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ queuePrompt: startupQueue }),
}));

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
});

// #7103 同一次失败只说一次:这一轮已经以失败结算时,转录里「回合失败」那一行就是它 —— ❌ 角落再弹一条
// 「Failed to send message」+ 未打码的原文。没结算成一轮的失败照旧弹,标题跟界面语言,正文按原因表说。
describe('#7103 发送失败只说一次', () => {
  function liveStore(error: unknown): { store: InstanceType<StoreCtor>; answered: Promise<void> } {
    const store = makeStore();
    const answered = Promise.withResolvers<void>();
    store.session = {
      sessionState: {
        current: () => ({ lifecycle: 'ready', pendingPermissions: [], activeTurnId: null, queuedPrompts: [] }),
      },
      sendPrompt: async () => {
        queueMicrotask(() => answered.resolve());
        return { success: false, error };
      },
    } as never;
    return { store, answered: answered.promise };
  }

  it('这一轮以失败结算(prompt_failed):不弹', async () => {
    const { store, answered } = liveStore({ type: 'prompt_failed', cause: { name: 'Error', message: 'boom at 127.0.0.1:4242' } });
    store.submitPrompt('hi');
    await answered;
    await Promise.resolve();
    expect(toasts).toEqual([]);
  });

  it('shows a sanitized reason for a runtime refusal that did not settle a turn', async () => {
    const { store, answered } = liveStore({ type: 'invalid_state', message: 'session is closing in /Users/someone/runtime\n    at close' });
    store.submitPrompt('hi');
    await answered;
    await Promise.resolve();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe(translateSessionMessage('acpFailure.sendMessage'));
    expect(toasts[0]?.description).toBe('session is closing in [path]');
  });

  // #4657 / #7103 D1:拒绝方是 agent 自己(ACP 那侧带病因)时递它的原话 —— 一行,去掉本机路径。
  it('agent 拒的(带病因)递它的原话一行,❌ 换成「咕咕这边出错了」', async () => {
    const { store, answered } = liveStore({
      type: 'provider_session_missing',
      cause: { name: 'Error', message: 'Session not found in /Users/someone/.codex/sessions\n    at resume' },
    });
    store.submitPrompt('hi');
    await answered;
    await Promise.resolve();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.description).toBe('Session not found in [path]');
  });
});

describe('#3500 会话不在时的 submitPrompt', () => {
  it('exposes and uses the same submit capability after recoverable startup failure', async () => {
    const store = makeStore();
    const internal = store as unknown as { _bootstrapped: boolean; _startInput: () => unknown };
    internal._startInput = () => ({ sessionId: store.sessionId });
    const seen: boolean[] = [];
    const dispose = reaction(() => store.affordances.canSubmit, value => seen.push(value), { fireImmediately: true });
    try {
      runInAction(() => {
        internal._bootstrapped = true;
        store.historyLoading = false;
        store.loadError = { kind: 'auth_required', message: 'sign in' };
      });
      expect(store.affordances.canSubmit).toBe(true);
      const queued = Promise.withResolvers<unknown>();
      startupQueue.mockImplementationOnce(async (request: unknown) => {
        queued.resolve(request);
        return { success: true, data: { queued: true } };
      });
      store.submitPrompt('wait for sign-in');
      expect(await queued.promise).toMatchObject({ prompt: { text: 'wait for sign-in' } });
      runInAction(() => { store.loadError = { kind: 'harness_not_installed', message: 'install first' }; });
      expect(store.affordances.canSubmit).toBe(false);
      expect(seen).toEqual([false, true, false]);
    } finally { dispose(); }
  });

  it('阳性对照：store 造得出来、且此时确实没有会话', () => {
    const store = makeStore();
    expect(store.session, '会话不为 null，被测场景就不成立，后面每条读数作废').toBeNull();
    expect(store.affordances.isWorking, '没有会话时应当不是 working —— 否则走不到乐观分支').toBe(
      false,
    );
  });

  it('① 乐观消息被回滚（不是从没插入）', () => {
    const store = makeStore();
    store.submitPrompt('把 README 的安装步骤更新一下');
    expect(
      store.chatState.session.state.pendingPrompt,
      '乐观消息还停在屏幕上 —— 用户会以为发出去了',
    ).toBeNull();
  });

  it('② 用户看到了错误', () => {
    const store = makeStore();
    store.submitPrompt('把 README 的安装步骤更新一下');
    expect(toasts.length, '一个字节没发，却什么都没告诉用户').toBeGreaterThan(0);
    expect(toasts[0]?.variant).toBe('destructive');
    expect(toasts[0]?.title).toBe(translateSessionMessage('acpFailure.sendMessage'));
  });

  it('③ 文字被还回输入框（只做①②会让内容彻底消失）', () => {
    const store = makeStore();
    const text = '把 README 的安装步骤更新一下';
    store.submitPrompt(text);
    expect(
      store.draftText,
      'composer 在 submitPrompt 之前就 clear() 过了 —— 不还回去，用户输入的内容两处都没了',
    ).toBe(text);
  });

  it('不覆盖用户在这期间新键入的内容', () => {
    const store = makeStore();
    store.setDraftText('我已经在打下一句了');
    store.submitPrompt('这一条没发出去');
    expect(store.draftText, '把用户正在打的字覆盖掉，比丢一条消息更糟').toBe('我已经在打下一句了');
  });

  it('queuePrompt 同样不静默丢弃（composer 也是先 clear 再调）', () => {
    const store = makeStore();
    store.queuePrompt('排队的这一条');
    expect(toasts.some((t) => t.title === translateSessionMessage('acpFailure.sendMessage'))).toBe(true);
    expect(store.draftText).toBe('排队的这一条');
  });

  it('stop 同样不静默无操作', () => {
    const store = makeStore();
    store.stop();
    expect(toasts.some((t) => t.title === translateSessionMessage('acpFailure.stop')), '按了停止却什么都没发生').toBe(
      true,
    );
  });

  it('判据能判假：有会话时不该走这条路（不误报）', () => {
    const store = makeStore();
    const sent: Array<{ text: string; origin?: string }> = [];
    // 只实现被测路径需要的那一个方法；其余保持缺失，一旦被调到就会抛，而不是静默通过。
    store.session = {
      sendPrompt: (arg: { text: string; origin?: string }) => {
        sent.push(arg);
        return Promise.resolve({ success: true as const, data: { queued: false } });
      },
      sessionState: { current: () => ({ isGenerating: false, pendingPermissions: [] }) },
      // oxlint-disable-next-line typescript/no-explicit-any -- 测试替身边界
    } as any;
    store.submitPrompt('这一条应该真的发出去');
    expect(sent, '有会话时反而没发出去 —— 那说明修复把正常路径也堵了').toEqual([
      { text: '这一条应该真的发出去', origin: 'manual' },
    ]);
    expect(toasts.length, '正常路径不该弹错误').toBe(0);
  });

  it('task composer submit 与 queue 都只写 manual 来源', () => {
    const store = makeStore();
    const sent: Array<{ text: string; origin?: string }> = [];
    const queued: Array<{ text: string; origin?: string }> = [];
    store.session = {
      sendPrompt: (arg: { text: string; origin?: string }) => {
        sent.push(arg);
        return Promise.resolve({ success: true as const, data: { queued: false } });
      },
      queuePrompt: (arg: { text: string; origin?: string }) => {
        queued.push(arg);
        return Promise.resolve({ success: true as const, data: { queued: true } });
      },
      sessionState: { current: () => ({ isGenerating: false, pendingPermissions: [] }) },
      // oxlint-disable-next-line typescript/no-explicit-any -- 测试替身边界
    } as any;

    store.submitPrompt('现在发送');
    store.queuePrompt('稍后发送');

    expect(sent).toEqual([{ text: '现在发送', origin: 'manual' }]);
    expect(queued).toEqual([{ text: '稍后发送', origin: 'manual' }]);
  });

  it('问题 13:扩展转来的选区是咕咕包好的信封,submit 与 queue 都按投递(communication)送', () => {
    const store = makeStore();
    const sent: Array<{ text: string; origin?: string }> = [];
    const queued: Array<{ text: string; origin?: string }> = [];
    store.session = {
      sendPrompt: (arg: { text: string; origin?: string }) => {
        sent.push(arg);
        return Promise.resolve({ success: true as const, data: { queued: false } });
      },
      queuePrompt: (arg: { text: string; origin?: string }) => {
        queued.push(arg);
        return Promise.resolve({ success: true as const, data: { queued: true } });
      },
      sessionState: { current: () => ({ isGenerating: false, pendingPermissions: [] }) },
      // oxlint-disable-next-line typescript/no-explicit-any -- 测试替身边界
    } as any;

    store.submitPrompt('<gugu_delivery route="extension">现在</gugu_delivery>', [], undefined, 'communication');
    store.queuePrompt('<gugu_delivery route="extension">稍后</gugu_delivery>', [], undefined, 'communication');

    expect(sent).toEqual([{ text: '<gugu_delivery route="extension">现在</gugu_delivery>', origin: 'communication' }]);
    expect(queued).toEqual([{ text: '<gugu_delivery route="extension">稍后</gugu_delivery>', origin: 'communication' }]);
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

  it('draft sync fails loudly when the session disappears before the timer fires', () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      store.setDraftText('draft after disconnect');
      vi.advanceTimersByTime(300);
      expect(toasts.some((entry) => entry.title === translateSessionMessage('acpFailure.syncDraft'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
