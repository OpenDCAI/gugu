import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import type { SessionpageMessageHost } from '@shared/sessionpage-message-host';
import type { CreateSessionState } from './use-create-session-state';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  localSendMessage: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
  onClose: vi.fn(),
  onCreated: vi.fn(),
  sendMessageToChat: vi.fn(),
  sendAttachmentsToChat: vi.fn(),
  openAgentChat: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionManagerStore: () => ({ createSession: mocks.createSession }),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { sessions: { sendMessage: mocks.localSendMessage } },
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: mocks.logError, warn: mocks.logWarn } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));

const { useCreateSessionCallback } = await import('./use-create-session-callback');
const { translateSessionMessage } = await import('@renderer/localization/locale-store');

type HookResult = ReturnType<typeof useCreateSessionCallback>;
let latest: HookResult | undefined;

const sessionState = {
  isValid: true,
  linkedType: null,
  linkedIssue: null,
  linkedPR: null,
  sessionName: { effectiveSessionName: 'one-task' },
  workspaceConfig: { resolvedConfig: { version: '2' } },
} as unknown as CreateSessionState;

const initialSession = {
  provider: 'codex',
  providerError: null,
  sessionpage: {
    'acp': { identity: 'addressable', messageTransport: 'router' },
    'tui': { identity: 'none', messageTransport: 'local-session' },
  },
  promptCapability: undefined,
  prompt: 'make one task',
  mentionContext: undefined,
  issueContext: null,
  // 替身要说真话:真 composer(useInitialSessionState)**一定**解析出一个档,而聊天页那一面
  // 的默认就是无人值守那一档 —— 所以这两格照它写。此前这里只有一个 `autoApprove: false`、
  // 没有 permissionMode,而下面那条断言仍读到 full-access/true:那是 buildInitialSession 里
  // 的覆盖在替身背后**替它做了决定**(#5597 的病根)。覆盖拿掉之后,替身必须自己是真的。
  permissionMode: 'full-access',
  model: null,
  effort: null,
  platformModel: null,
  sessionView: 'general',
  setSessionView: () => {},
  sessionViewOffered: true,
  sessionViewLock: null,
  issueMentionContexts: {},
  attachmentChannel: 'chat-attachment',
  // chip 与待发 File 在产品里是同一件事(composer 同时增删两者),替身也必须如此 ——
  // 分成两份就会让「有 chip 但没 File」这种产品里不存在的状态混进读数。
  get attachments() { return pendingAttachments.map((entry) => ({ id: entry.id, name: entry.file.name })); },
  // 用户增删的次数。⚠️ dropAttachment 是**发送端**在移走已送达的那件,故意不动它 ——
  // 产品里也是这样,而这正是「失败原因不会被自己的成功清掉」所依赖的那条区分。
  get attachmentEditSeq() { return attachmentEditSeq; },
  pendingAttachmentFiles: () => pendingAttachments,
  // path-mention 通道那一半(#5269)。这些用例全是 chat 通道的,所以恒空 —— 但**必须在场**:
  // 这份替身用 `as unknown as` 断言成完整的 state,少一个成员编译期不会说话,运行期才炸。
  pathAttachmentMentions: () => [],
  pathAttachmentsUnsettled: () => false,
  waitForPathAttachments: async () => true,
  enqueuePathAttachments: async () => {},
  // 任务 id 由 composer 先定下来:path-mention 的附件在**创建之前**就按它落进了
  // `<userData>/task-attachments/<会话 id>/`(#5269)。替身给一个稳定值,好让「重试用同一个
  // 已创建任务的 id」那条断言仍然读得出「同一个 id」。
  reserveSessionId: () => 'reserved-task-id',
  pathAttachmentEntries: () => [],
  dropAttachment: (id: string) => {
    pendingAttachments = pendingAttachments.filter((entry) => entry.id !== id);
  },
  rememberStartedConfiguration: vi.fn(async () => {}),
  setPrompt: vi.fn(),
} as unknown as InitialSessionState;

// 待发附件队列的替身:composer 是保管者,一件送达就移走一件(与产品同语义)。
let pendingAttachments: Array<{ id: string; file: File }> = [];
// 用户自己动队列的计数(产品里由 enqueue/用户点掉 chip 递增,dropAttachment 不递增)。
let attachmentEditSeq = 0;

function Probe({
  creationSurface = 'chat-page',
  birthChatId,
}: {
  creationSurface?: 'chat-page' | 'session-page'
  birthChatId?: string
}) {
  latest = useCreateSessionCallback({
    selectedProjectId: 'project-1',
    state: sessionState,
    initialSession,
    navigate: mocks.navigate as unknown as NavigateFnTyped,
    onClose: mocks.onClose,
    onCreated: mocks.onCreated,
    creationSurface,
    birthChatId,
  });
  return null;
}

describe('useCreateSessionCallback ordinary messaging', () => {
  let dom: JSDOM;
  let root: Root;

  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    pendingAttachments = [];
    attachmentEditSeq = 0;
    mocks.sendAttachmentsToChat.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue(undefined);
    mocks.localSendMessage.mockResolvedValue({ id: 'local-id', status: 'queued' });
    mocks.invoke.mockResolvedValue({ chatId: 'chat-1', agentUserId: 'agent-1' });
    mocks.sendMessageToChat.mockResolvedValue('message-id');
    initialSession.prompt = 'make one task';
    initialSession.mentionContext = undefined;
    // ⚠️ 这个替身是模块级共享对象:改过档位的用例不复位,后面每一条都继承它 ——
    //    而那读起来像「产品把档改了」。复位回聊天页那一面的默认(见替身抬头)。
    initialSession.permissionMode = 'full-access';
    initialSession.autoApprove = true;
    initialSession.sessionView = 'general';
    initialSession.promptCapability = undefined;
    initialSession.sessionpage = {
      'acp': { identity: 'addressable', messageTransport: 'router' },
      'tui': { identity: 'none', messageTransport: 'local-session' },
    };
    vi.mocked(initialSession.setPrompt).mockImplementation((update) => {
      initialSession.prompt = typeof update === 'function'
        ? update(initialSession.prompt)
        : update;
    });

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    const host: SessionpageMessageHost = {
      sendMessageToChat: mocks.sendMessageToChat,
      sendAttachmentsToChat: mocks.sendAttachmentsToChat,
      openAgentChat: mocks.openAgentChat,
      openTopic: () => { throw new Error('not used here'); },
      openTopics: () => { throw new Error('not used here'); },
    };
    Object.assign(dom.window, {
      electronAPI: { invoke: mocks.invoke },
      __GUGU_SESSIONPAGE_MESSAGES__: host,
    });
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    await act(async () => root.render(React.createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('#6264 附件还在传:点创建先等它传完再建;有一件没成就不建', async () => {
    let finish: (ok: boolean) => void = () => {};
    initialSession.pathAttachmentsUnsettled = () => true;
    initialSession.waitForPathAttachments = () => new Promise<boolean>((resolve) => (finish = resolve));
    try {
      act(() => latest?.handleCreateSession());
      await act(async () => {});
      expect(mocks.createSession).not.toHaveBeenCalled();
      await act(async () => finish(true));
      expect(mocks.createSession).toHaveBeenCalledTimes(1);

      mocks.createSession.mockClear();
      act(() => latest?.handleCreateSession());
      await act(async () => finish(false));
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      initialSession.pathAttachmentsUnsettled = () => false;
      initialSession.waitForPathAttachments = async () => true;
    }
  });

  it('create then user message calls the exact same sendMessageToChat API as a later message', async () => {
    act(() => latest?.handleCreateSession());
    await act(async () => {});

    const createParams = mocks.createSession.mock.calls[0]?.[0];
    expect(createParams.sessionConfig.initialSession).not.toHaveProperty('initialPrompt');
    expect(createParams.sessionConfig.initialSession).not.toHaveProperty('initialQueue');
    // 聊天页那一面开出来的会话是无人值守的完全访问 —— 但那个决定来自 composer(state),
    // 这一层只是**原样带过去**,❌ 不再自己覆盖一遍(#5597)。
    expect(createParams.sessionConfig.initialSession).toEqual(expect.objectContaining({
      permissionMode: 'full-access',
    }));
    expect(mocks.sendMessageToChat).toHaveBeenCalledWith(
      'chat-1',
      'make one task',
      { toUserIds: ['agent-1'], clientMessageId: expect.any(String) },
    );

    const stableId = mocks.sendMessageToChat.mock.calls[0]?.[2].clientMessageId;
    await (dom.window as unknown as { __GUGU_SESSIONPAGE_MESSAGES__: SessionpageMessageHost })
      .__GUGU_SESSIONPAGE_MESSAGES__
      .sendMessageToChat('chat-1', 'later message', {
        toUserIds: ['agent-1'],
        clientMessageId: 'later-id',
      });
    expect(mocks.sendMessageToChat).toHaveBeenCalledTimes(2);
    expect(stableId).not.toBe('later-id');
  });

  // ⭐ #5597 —— 聊天页创建这一层**不许**替用户改档。此前它拿 `unattended` 把 composer 选中的档
  // 无条件覆盖成 full-access,于是草稿上选只读、会话开成最松档,而且不报错(安全边界上的静默失效)。
  // 判据落在**严格档**上:覆盖那一版下面这条必然读到 full-access ⇒ 它会红。
  it('聊天页创建:草稿选的严格档原样进落库载荷,❌ 不被无人值守覆盖(#5597)', async () => {
    initialSession.permissionMode = 'read-only';
    initialSession.autoApprove = false;
    await act(async () => root.render(React.createElement(Probe)));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession)
      .toEqual(expect.objectContaining({ permissionMode: 'read-only' }));
  });

  // 群成员里「新建 Agent」:托盘上那个群原样进建会话的参数(主进程据此在身份建出来时进群);没群就没有这一格。
  it('从群里建:birthChatId 进落库参数;不从群里建就不出现', async () => {
    await act(async () => root.render(React.createElement(Probe, { birthChatId: 'chat-group-1' })));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ birthChatId: 'chat-group-1' }));
  });

  it('不从群里建:落库参数里没有 birthChatId', async () => {
    await act(async () => root.render(React.createElement(Probe)));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty('birthChatId');
  });

  it('startup-capable session-page provider puts the first text in the create payload and skips post-create delivery', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'local-session' },
    };
    initialSession.promptCapability = { kind: 'argv', startupDelivery: 'startup-prompt' };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'session-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession).toEqual(expect.objectContaining({
      initialPrompt: 'make one task',
    }));
    expect(mocks.localSendMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
  });

  it('[#4653] 对话页 + 选终端 的启动通道首轮:裸文本进创建载荷,并且仍然要能解析出私聊地址', async () => {
    // 真机 B 读数就红在这条的后半:首句确实经启动通道送到了、DM 也开好了,但创建收尾去解析
    // 地址时被 `sessionpage:ensure-agent-address` 的 router 闸挡住,创建面卡住不关,屏幕上写着
    // `does not declare router message transport`。那道闸把「首轮走哪条路」又算了一遍
    // (真身在 firstTurnTransportOf),两处一漂开就是这个形状 —— 所以这里把**两半一起**钉住。
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'local-session' },
    };
    initialSession.promptCapability = { kind: 'argv', startupDelivery: 'startup-prompt' };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession).toEqual(expect.objectContaining({
      // ⚠️ 落库的是**裸文本 + 稳定 message id**,信封在 spawn 那一刻才临时构造(spec agent-create)。
      initialPrompt: 'make one task',
      startupOrigin: 'chat-page',
      initialMessageId: expect.any(String),
    }));
    // 首句已由启动通道消费 ⇒ ❌ 不许再走第二条普通投递。
    expect(mocks.localSendMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
    // 而地址仍然要解析得出来,否则用户创建完进不去那条私聊(B 读数红的就是这一步)。
    expect(mocks.invoke).toHaveBeenCalledWith('sessionpage:ensure-agent-address', expect.objectContaining({
      sessionId: expect.any(String),
    }));
    expect(mocks.openAgentChat).toHaveBeenCalledWith({ chatId: 'chat-1', agentUserId: 'agent-1' });
  });

  it('startup-capable chat-page provider puts the first text in the create payload and skips post-create delivery', async () => {
    initialSession.sessionView = 'general';
    initialSession.sessionpage = {
      'acp': { identity: 'addressable', messageTransport: 'router' },
    };
    initialSession.promptCapability = { kind: 'none', startupDelivery: 'startup-prompt' };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession).toEqual(expect.objectContaining({
      initialQueue: [{ text: 'make one task', origin: 'manual' }],
      startupOrigin: 'chat-page',
      initialMessageId: expect.any(String),
    }));
    expect(mocks.localSendMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('sessionpage:ensure-agent-address', expect.objectContaining({
      sessionId: expect.any(String),
    }));
    expect(mocks.openAgentChat).toHaveBeenCalledWith({ chatId: 'chat-1', agentUserId: 'agent-1' });
  });

  it('keeps a selected local-session mention in the startup queue text', async () => {
    const peerId = '11111111-1111-4111-8111-111111111111';
    const mentionContext = `@user:${peerId}: name: Codex 1; kind=agent; scope=local ACP session in this task; send with session_message to=user:${peerId}`;
    initialSession.sessionView = 'general';
    initialSession.sessionpage = {
      'acp': { identity: 'addressable', messageTransport: 'router' },
    };
    initialSession.promptCapability = { kind: 'none', startupDelivery: 'startup-prompt' };
    initialSession.prompt = `Ask @user:${peerId} to inspect the task`;
    initialSession.mentionContext = mentionContext;
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession).toEqual(expect.objectContaining({
      initialQueue: [{
        text: `Ask @user:${peerId} to inspect the task`,
        hiddenContext: mentionContext,
        origin: 'manual',
      }],
    }));
  });

  it('an unmarked session-page provider keeps the legacy post-create message path', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'none', messageTransport: 'local-session' },
    };
    initialSession.promptCapability = { kind: 'keystroke' };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'session-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession)
      .not.toHaveProperty('initialPrompt');
    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'make one task' }));
  });

  // L11 复核 58 补看 (125 10-06 05:24): the new-session memory is written after the session is up, never in its way.
  // Control (0fb0ea831d): written first and awaited — a failed write left a made session without its first line, and
  // the box said the task could not be created.
  it('a new-session memory that cannot be saved: the session is made, its first line sent, a light notice', async () => {
    vi.mocked(initialSession.rememberStartedConfiguration).mockRejectedValueOnce(new Error('settings unavailable'));
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'none', messageTransport: 'local-session' },
    };
    initialSession.promptCapability = { kind: 'keystroke' };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'session-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'make one task' }));
    expect(mocks.navigate).toHaveBeenCalledWith('session', expect.objectContaining({ projectId: 'project-1' }));
    expect(mocks.onClose).toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith('remember the started configuration failed', { error: 'settings unavailable' });
    expect(mocks.toast).toHaveBeenCalledWith({ title: translateSessionMessage('task.newSessionMemoryNotSaved'), tier: 'warning' });
  });

  it('retries the same created task and stable id after an ambiguous router failure', async () => {
    mocks.sendMessageToChat
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce('message-id');

    act(() => latest?.handleCreateSession());
    await act(async () => {});
    const firstId = mocks.sendMessageToChat.mock.calls[0]?.[2].clientMessageId;
    expect(initialSession.prompt).toBe('make one task');

    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.sendMessageToChat.mock.calls[1]?.[2].clientMessageId).toBe(firstId);
    expect(initialSession.prompt).toBe('');
  });

  it('identity-none TUI uses conversations.sendMessage and never asks for an address', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'none', messageTransport: 'local-session' },
    };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'make one task',
      clientMessageId: expect.any(String),
    }));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
  });

  // ⬇ P0(owner 现场撞出来):会话页建的会话,首轮曾经也走 IM 私聊投递 —— 于是它被 gugu IM 的
  // 链路裹上 listen-mode `<system_hint>` 送进终端(agent 以为自己在私聊里被叫到)、顺带建出私聊、
  // 触发 shell 的「agent 起来了」事件把人从会话页拽去聊天页。会话页与聊天页行为一模一样。
  //
  // 判据钉的是**创建面决定首轮通道**:provider 明明声明了 router(claude 的 tui 就是),
  // 会话页也**必须**走会话内投递,一次都不许碰私聊。摘掉 use-create-session-callback 里那个
  // `creationSurface === 'session-page' ? 'local-session' : …`,这条立刻红。
  it('任务页创建:首轮走会话内投递,绝不经过 IM 私聊 —— 哪怕 provider 声明了 router', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'router' },
    };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'session-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'make one task',
    }));
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.openAgentChat).not.toHaveBeenCalled();
    // 留在会话页:导航到这条会话,它的 id 就是附件落盘时预留的那个。
    expect(mocks.navigate).toHaveBeenCalledWith('session', { projectId: 'project-1', sessionId: 'reserved-task-id' });
  });

  // 阳控:同一把尺子在对话页创建时必须读到「走了私聊」—— 否则上面那条的绿是把整条路测没了。
  it('[阳控] 对话页创建:首轮就是一条普通私聊消息,发完进入那个 Agent 的私聊', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'router' },
    };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.sendMessageToChat).toHaveBeenCalled();
    expect(mocks.openAgentChat).toHaveBeenCalled();
    expect(mocks.localSendMessage).not.toHaveBeenCalled();
  });

  // #4325 —— 首轮附件与它所在的那条消息同路:调的是消息面既有的批发送(经 host bridge),
  // 顺序是先附件后正文,且每一件真送达才从 composer 移走。
  it('[#5049] 对话页创建 + 启动通道首轮带附件:正文随 spawn 载荷,附件走同一条附件发送路,不重发正文', async () => {
    // owner 2026-09-05:对话页 + 通用视角(ACP 腿)带图片建 agent。修前 tripwire 把整次创建挡在
    // 「1 pending chat attachment(s) on a startup first turn」上(mac1 9385 复现),一个 Agent 都建不出来。
    initialSession.sessionView = 'general';
    initialSession.sessionpage = {
      'acp': { identity: 'addressable', messageTransport: 'router' },
    };
    initialSession.promptCapability = { kind: 'none', startupDelivery: 'startup-prompt' };
    const file = { name: 'probe.png' } as unknown as File;
    pendingAttachments = [{ id: 'att-1', file }];
    mocks.sendAttachmentsToChat.mockImplementation(async (
      _chatId: string,
      files: Array<{ id: string; file: File }>,
      options: { onSent: (id: string) => void },
    ) => {
      for (const entry of files) options.onSent(entry.id);
    });
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(latest?.deliveryError).toBeNull();
    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession).toEqual(expect.objectContaining({
      initialQueue: [{ text: 'make one task', origin: 'manual' }],
      startupOrigin: 'chat-page',
      initialMessageId: expect.any(String),
    }));
    // 附件与这条 DM 里稍后任何一条附件消息完全同路(spec agent-create #4325);正文 ❌ 不经普通消息 API 第二次发送。
    expect(mocks.sendAttachmentsToChat).toHaveBeenCalledWith(
      'chat-1',
      [{ id: 'att-1', file }],
      expect.objectContaining({ toUserIds: ['agent-1'] }),
    );
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
    expect(pendingAttachments).toEqual([]);
    expect(mocks.openAgentChat).toHaveBeenCalledWith({ chatId: 'chat-1', agentUserId: 'agent-1' });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it('对话页创建:首轮附件走消息面既有的附件发送,先附件后正文', async () => {
    const file = { name: 'brief.txt' } as unknown as File;
    pendingAttachments = [{ id: 'att-1', file }];
    const order: string[] = [];
    mocks.sendAttachmentsToChat.mockImplementation(async (
      _chatId: string,
      files: Array<{ id: string; file: File }>,
      options: { onSent: (id: string) => void },
    ) => {
      order.push('attachments');
      for (const entry of files) options.onSent(entry.id);
    });
    mocks.sendMessageToChat.mockImplementation(async () => {
      order.push('text');
      return 'message-id';
    });
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.sendAttachmentsToChat).toHaveBeenCalledWith(
      'chat-1',
      [{ id: 'att-1', file }],
      expect.objectContaining({ toUserIds: ['agent-1'] }),
    );
    // 顺序是判据的一部分:正文先落库会让 agent 在附件还没到时就被叫醒。
    expect(order).toEqual(['attachments', 'text']);
    // 送达一件就从 composer 移走一件 —— 重试只会补剩下的。
    expect(pendingAttachments).toEqual([]);
    // ❌ 没有 create 专用的上传/消息类型:正文仍走同一个 sendMessageToChat。
    expect(mocks.sendMessageToChat).toHaveBeenCalledWith(
      'chat-1',
      'make one task',
      expect.objectContaining({ toUserIds: ['agent-1'] }),
    );
  });

  // 阳控 + 反例:会话页那条路**不**碰 chat 附件发送(它的附件是会话内的路径 mention,所以
  // 待发队列本来就是空的 —— attachmentChannelOf('local-session') = 'path-mention')。
  // 没有这一条,上面那条绿说明不了「判据认得出两个取值」。
  // ⚠️ 这里**不**人为往队列里塞附件:那是产品造不出来的状态,塞了测的就不是这条路,
  // 而是下面那条 fail-loud 守卫(它有自己的用例)。
  it('[阳控] 任务页创建:首轮不走 chat 附件发送', async () => {
    expect(pendingAttachments).toHaveLength(0);
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'session-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.sendAttachmentsToChat).not.toHaveBeenCalled();
    expect(mocks.localSendMessage).toHaveBeenCalled();
  });

  // 只有附件、没有文字,也是一条能提交的首轮(#4325)。
  it('对话页创建:纯附件的首轮可提交', async () => {
    initialSession.prompt = '';
    pendingAttachments = [{ id: 'att-1', file: { name: 'brief.txt' } as unknown as File }];
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    expect(latest?.canCreate).toBe(true);
    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.sendAttachmentsToChat).toHaveBeenCalled();
    // 正文是空的 → 不发第二条空消息。
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
  });

  // 附件失败必须说出来,并且原文与未送达的附件都留在 composer 里等显式重试(❌ 静默丢)。
  it('对话页创建:附件失败 fail loud,正文不抢跑', async () => {
    pendingAttachments = [{ id: 'att-1', file: { name: 'brief.txt' } as unknown as File }];
    mocks.sendAttachmentsToChat.mockRejectedValue(new Error('chat-media rejected the upload'));
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(latest?.deliveryError).toMatchObject({
      kind: 'raw',
      detail: expect.stringContaining('chat-media rejected the upload'),
    });
    // 附件没送出去,正文就不该先落库 —— 否则 agent 会在文件不存在时被叫醒。
    expect(mocks.sendMessageToChat).not.toHaveBeenCalled();
    // 那一件仍在 composer 里。
    expect(pendingAttachments).toEqual([{ id: 'att-1', file: expect.anything() }]);
  });

  // [回归 · #4325 review 发现①] 只带附件、没打字的一轮,若 provider 在该会话形态下没有 transport,
  // 闸必须挡住。挡不住的话:task 建出来了、附件一个字都没发、还不报错 —— 静默丢。
  it('对话页创建:纯附件 + 无 transport ⇒ 闸挡住并说明原因', async () => {
    initialSession.prompt = '';
    pendingAttachments = [{ id: 'att-1', file: { name: 'brief.txt' } as unknown as File }];
    initialSession.sessionpage = {
      'acp': { identity: 'none', messageTransport: 'none' },
    };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    // 判据能判假吗:能。把这道闸改回读 submittedText(第一版的写法),messageTransportError 会是
    // null、canCreate 变 true,这两行立刻红。
    expect(latest?.messageTransportError).toContain('has no acp message transport');
    expect(latest?.canCreate).toBe(false);
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendAttachmentsToChat).not.toHaveBeenCalled();
  });

  // [回归 · #4325 review 发现②] 会话内投递那一轮不该有 chat 待发附件(它的附件是正文里的路径
  // mention)。真有就说明两条轴漂开了 —— 必须响亮地停,❌ 不静默跳过整批。
  it('会话内投递的一轮若混进 chat 待发附件,必须 fail loud', async () => {
    pendingAttachments = [{ id: 'att-1', file: { name: 'brief.txt' } as unknown as File }];
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'local-session' },
    };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(latest?.deliveryError).toMatchObject({
      kind: 'raw',
      detail: expect.stringContaining('attachment channel and the message transport disagree'),
    });
    // ❌ 不许把正文照发、附件当没有过。
    expect(mocks.localSendMessage).not.toHaveBeenCalled();
    expect(pendingAttachments).toHaveLength(1);
    // 而且要在 createSession **之前**就停住:先建再抛会留下一个孤儿 task,重试还只会走回这里。
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  // [回归 · #4325 复审发现③] 一批附件里前面几件成功、最后一件失败:那次成功自己把待发数量
  // 改小了,失败原因不能因此被清掉。判据能判假吗:能 —— 把 deliveryErrorSubject 改回读
  // attachments.length(第二版的写法),这一条立刻红在 deliveryError 上。
  it('对话页创建:部分成功后失败,失败原因不被自己的成功清掉', async () => {
    pendingAttachments = [
      { id: 'att-1', file: { name: 'one.txt' } as unknown as File },
      { id: 'att-2', file: { name: 'two.txt' } as unknown as File },
    ];
    mocks.sendAttachmentsToChat.mockImplementation(async (
      _chatId: string,
      files: Array<{ id: string; file: File }>,
      options: { onSent: (id: string) => void },
    ) => {
      options.onSent(files[0].id);
      throw new Error('chat-media rejected the second upload');
    });
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(latest?.deliveryError).toMatchObject({
      kind: 'raw',
      detail: expect.stringContaining('chat-media rejected the second upload'),
    });
    // 送达的那件已经移走,剩下的那件仍在 composer 里等重试。
    expect(pendingAttachments).toEqual([{ id: 'att-2', file: expect.anything() }]);
  });

  // [阳控] 用户真的动了队列,原因就该清掉 —— 否则上面那条绿只说明「这道清理坏了」。
  it('对话页创建:用户增删附件后,旧的失败原因清掉', async () => {
    pendingAttachments = [{ id: 'att-1', file: { name: 'one.txt' } as unknown as File }];
    mocks.sendAttachmentsToChat.mockRejectedValue(new Error('chat-media rejected the upload'));
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(latest?.deliveryError).toMatchObject({
      kind: 'raw',
      detail: expect.stringContaining('chat-media rejected the upload'),
    });

    attachmentEditSeq += 1;
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    expect(latest?.deliveryError).toBeNull();
  });

  it('fails product support closed when the selected surface declares no message transport', async () => {
    initialSession.sessionpage = {
      'acp': { identity: 'none', messageTransport: 'none' },
    };
    await act(async () => root.render(React.createElement(Probe)));
    expect(latest?.canCreate).toBe(false);
    expect(latest?.messageTransportError).toContain('has no acp message transport');
    act(() => latest?.handleCreateSession());
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  // #4658 ②:关闭的格若自述了 `reason`,fail-loud 那条红字要把「为什么」原样接在「收不了」后面 ——
  // 「no … message transport」只说得了收不了,reason 说得出为什么(grok 终端腿首句待 #4653 链定语义)。
  // 这测的是 renderer 这一处的拼接(我改的那一行);descriptor 里 grok 两格的真 reason 由
  // impl/index.test.ts 的棘轮钉形状,两处各测各的。上面两条(:447/:528 无 reason)就是它的阴性对照。
  it('对话页创建:关闭格自述的 reason 原样接在 message-transport 错误后面(#4658 ②)', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': {
        identity: 'none',
        messageTransport: 'none',
        reason: 'Grok CLI terminal-session first turn is deferred pending the task-TUI first-turn work (#4653).',
      },
    };
    await act(async () => root.render(React.createElement(Probe, { creationSurface: 'chat-page' })));

    // 「收不了」仍在(通用句一字不改),后面接上了「为什么」。
    expect(latest?.messageTransportError).toContain('has no tui message transport');
    expect(latest?.messageTransportError).toContain('deferred pending the task-TUI first-turn work (#4653)');
    expect(latest?.canCreate).toBe(false);

    // 判据能判假吗:能。摘掉那段 `+ (closureReason ? …)` 拼接,第二行立刻红,而第一行仍绿 ——
    // 证明它钉的正是「reason 有没有被接上」,不是「有没有报错」。
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
