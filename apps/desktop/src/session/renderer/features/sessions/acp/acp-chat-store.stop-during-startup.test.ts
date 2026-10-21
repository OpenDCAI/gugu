// @vitest-environment jsdom
/**
 * 会话还在建立时也能停(behavior session-page「打开速度」:这段算运行中;启动没有超时,引擎卡住时这是唯一的出口)。
 *
 * 合同:
 *   有一句在「处理中」⇒ 输入框是停止键(`isWorking`);
 *   按停止 ⇒ 放弃这次启动,与平时停掉一轮同一个收场:第一条留在对话里,下面「你停止了这一轮」;
 *     第一条之外还没发出去的那几句(运行时没替你存着)撤下、字还回输入框;❌ 说成起不来、❌ 弹错误;
 *   停下之后再发一句 ⇒ 接着跑:先发第一条(在「处理中」),新那句进排队条。
 * 顺带钉住:自己起不来(不是停的)时,那一句若运行时已经收下就留在屏上、不显示在跑,接着跑时回到「处理中」;
 *   运行时没收下就撤下、字还回输入框。
 *
 * 判据能判假吗:把 `affordances` 里 startupRunning 那一项删掉,第一条红;把 `stop()` 里转去 `_stopStartup` 那一支
 * 删掉,停止那几条红;把开场失败处「用户停的就不说失败」那一支删掉,「不说起不来」红;把开场处接回留屏那一句删掉,
 * 「接着跑」那条红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';

const queuePrompt = vi.fn();
const stopSession = vi.fn();
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ queuePrompt, stopSession }),
}));
const toasts: Array<{ title: string }> = [];
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (arg: { title: string }) => { toasts.push(arg); } }));

let create: () => Promise<unknown> = () => new Promise(() => {});
vi.mock('@renderer/lib/acp/acp-live-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/acp/acp-live-session')>();
  return { ...actual, AcpLiveSession: { create: () => create() } };
});

type StoreModule = typeof import('./acp-chat-store');
type Store = InstanceType<StoreModule['AcpChatStore']>;

Object.defineProperty(document, 'fonts', { configurable: true, value: { load: vi.fn().mockResolvedValue([]) } });
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: (channel: string) =>
      Promise.resolve(channel === 'sessions.getStoredHistory' ? { turns: [], nextCursor: null } : []),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

type Internal = { _bootstrapped: boolean; _startInput: () => unknown; _runBootstrap: () => Promise<void> };

const FIRST = '帮我看看这个项目';
let seq = 0;
/** `firstMessage`:新建会话带着第一条(会话记录里存着);没有就是一条已经建立过的老会话。 */
function store(opts: { firstMessage: boolean }) {
  seq += 1;
  const s = new AcpChatStore(`conv-stop-startup-${seq}`, 'proj-1');
  const internal = s as unknown as Internal;
  internal._startInput = () => ({
    sessionId: s.sessionId,
    providerId: 'claude',
    ...(opts.firstMessage ? { initialQueue: [{ text: FIRST, origin: 'manual' }] } : {}),
  });
  runInAction(() => {
    internal._bootstrapped = true;
    s.historyLoading = false;
  });
  return { s, internal };
}

/** 起一次开场,开场卡在「建立中」直到 `fail()`。 */
function startStuck(internal: Internal) {
  const outcome = Promise.withResolvers<never>();
  create = () => outcome.promise;
  const running = internal._runBootstrap();
  return { running, fail: (error = new Error('start cancelled')) => { outcome.reject(error); return running; } };
}

const pending = (s: Store) => s.chatState.session.state.pendingPrompt;
const committed = (s: Store) => s.chatState.transcript.state.committedTurns;

beforeEach(() => {
  toasts.length = 0;
  queuePrompt.mockReset();
  queuePrompt.mockResolvedValue({ success: true, data: { queued: true } });
  stopSession.mockReset();
  stopSession.mockResolvedValue({ success: true, data: undefined });
});

describe('会话还在建立时也能停', () => {
  it('有一句在「处理中」:输入框是停止键', () => {
    const { s, internal } = store({ firstMessage: true });
    expect(s.affordances.isWorking, '阴控:还没有在跑的那一句').toBe(false);
    void startStuck(internal);
    expect(pending(s)?.text).toBe(FIRST);
    expect(s.affordances).toMatchObject({ isWorking: true, canCancel: true });
  });

  it('按停止:放弃这次启动;第一条留下、标「你停止了这一轮」;不说起不来、不弹错误', async () => {
    const { s, internal } = store({ firstMessage: true });
    const start = startStuck(internal);
    s.stop();
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith({ sessionId: s.sessionId }));
    expect(pending(s)).toBeNull();
    expect(s.affordances.isWorking).toBe(false);
    expect(committed(s)).toEqual([
      expect.objectContaining({
        outcome: { kind: 'cancelled', reason: 'cancelled' },
        items: [expect.objectContaining({ role: 'user', text: FIRST })],
      }),
    ]);
    await start.fail();
    expect(s.loadError, '用户要的停,❌ 说成起不来').toBeNull();
    expect(committed(s), '只留一份').toHaveLength(1);
    expect(toasts).toEqual([]);
  });

  it('第一条之外还没发出去的那几句:撤下,字还回输入框;随后的拒收不再弹错误', async () => {
    const { s, internal } = store({ firstMessage: false });
    void startStuck(internal);
    const rejected = Promise.withResolvers<unknown>();
    queuePrompt.mockReturnValue(rejected.promise);
    s.submitPrompt('老会话里说一句');
    s.submitPrompt('又补一句');
    expect(pending(s)?.text, '阳控:先上了屏').toBe('老会话里说一句');
    expect(s.queuedPrompts.map((prompt) => prompt.text)).toEqual(['又补一句']);
    expect(s.affordances.isWorking).toBe(true);

    s.stop();
    expect(pending(s)).toBeNull();
    expect(s.queuedPrompts).toEqual([]);
    expect(committed(s), '没存下的不留在对话里').toEqual([]);
    expect(s.draftText).toBe('老会话里说一句\n\n又补一句');

    rejected.resolve({ success: false, error: { type: 'invalid_state', message: 'startup failed' } });
    await vi.waitFor(() => expect(queuePrompt).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toasts).toEqual([]);
    expect(s.draftText).toBe('老会话里说一句\n\n又补一句');
  });

  it('停下之后再发一句:接着跑 —— 第一条回到「处理中」,新那句进排队条', async () => {
    const { s, internal } = store({ firstMessage: true });
    const start = startStuck(internal);
    s.stop();
    await start.fail();
    expect(committed(s)).toHaveLength(1);

    create = () => new Promise(() => {});
    s.submitPrompt('那就接着来');
    expect(pending(s)?.text).toBe(FIRST);
    expect(committed(s), '停下那一份换回在跑的样子,❌ 画两遍').toEqual([]);
    expect(s.queuedPrompts.map((prompt) => prompt.text)).toEqual(['那就接着来']);
    expect(s.affordances.isWorking).toBe(true);
  });
});

describe('自己起不来(不是停的)', () => {
  it('老会话里那句运行时已经收下:留在屏上、不在跑;接着跑时回到「处理中」', async () => {
    const { s, internal } = store({ firstMessage: false });
    const start = startStuck(internal);
    s.submitPrompt('老会话里说一句');
    await vi.waitFor(() => expect(queuePrompt).toHaveBeenCalled());
    await start.fail(new Error('engine exited'));
    expect(s.loadError, '阳控:这次是真失败').not.toBeNull();
    expect(pending(s)).toBeNull();
    expect(committed(s)).toEqual([
      expect.objectContaining({ items: [expect.objectContaining({ text: '老会话里说一句' })] }),
    ]);
    expect(committed(s)[0]).not.toHaveProperty('outcome');

    create = () => new Promise(() => {});
    s.retry();
    expect(pending(s)?.text).toBe('老会话里说一句');
    expect(committed(s)).toEqual([]);
  });

  it('那句运行时没收下:撤下,字还回输入框', async () => {
    const { s, internal } = store({ firstMessage: false });
    const start = startStuck(internal);
    const answer = Promise.withResolvers<unknown>();
    queuePrompt.mockReturnValue(answer.promise);
    s.submitPrompt('没被收下的一句');
    await vi.waitFor(() => expect(queuePrompt).toHaveBeenCalled());
    await start.fail(new Error('engine exited'));
    expect(committed(s), '阳控:先按还存着留在屏上').toHaveLength(1);
    answer.resolve({ success: false, error: { type: 'invalid_state', message: 'startup failed' } });
    await vi.waitFor(() => expect(committed(s)).toEqual([]));
    expect(s.draftText).toBe('没被收下的一句');
  });
});
