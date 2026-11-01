import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
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
  // 替身要说真话:真 composer(useInitialSessionState)**一定**解析出一个档,所以这一格照它写 ——
  // buildInitialSession 不在替身背后替它做决定(#5597 的病根)。
  permissionMode: 'full-access',
  model: null,
  effort: null,
  platformModel: null,
  sessionView: 'general',
  setSessionView: () => {},
  sessionViewOffered: true,
  sessionViewLock: null,
  issueMentionContexts: {},
  attachments: [],
  attachmentEditSeq: 0,
  prepareAttachments: async () => [],
  placeAttachments: async () => [],
  pendingAttachmentFiles: () => [],
  dropAttachment: () => {},
  rememberStartedConfiguration: vi.fn(async () => {}),
  setPrompt: vi.fn(),
} as unknown as InitialSessionState;

function Probe({
  birthChatId,
  taskChatId,
}: {
  birthChatId?: string
  taskChatId?: string
}) {
  latest = useCreateSessionCallback({
    selectedProjectId: 'project-1',
    state: sessionState,
    initialSession,
    navigate: mocks.navigate as unknown as NavigateFnTyped,
    onClose: mocks.onClose,
    onCreated: mocks.onCreated,
    birthChatId,
    taskChatId,
  });
  return null;
}

describe('useCreateSessionCallback ordinary messaging', () => {
  let dom: JSDOM;
  let root: Root;

  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createSession.mockResolvedValue(undefined);
    mocks.localSendMessage.mockResolvedValue({ id: 'local-id', status: 'queued' });
    initialSession.prompt = 'make one task';
    initialSession.mentionContext = undefined;
    // ⚠️ 这个替身是模块级共享对象:改过档位的用例不复位,后面每一条都继承它 ——
    //    而那读起来像「产品把档改了」。复位回替身抬头的那一档。
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
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    await act(async () => root.render(React.createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('#6264 附件还在传:点创建先等它传完再建;有一件没成就不建', async () => {
    let finish: (refs: [] | null) => void = () => {};
    initialSession.attachments = [{ id: 'file', name: 'brief.txt', kind: 'file' }];
    initialSession.prepareAttachments = () => new Promise((resolve) => (finish = resolve));
    await act(async () => root.render(React.createElement(Probe)));
    try {
      act(() => latest?.handleCreateSession());
      await act(async () => {});
      expect(mocks.createSession).not.toHaveBeenCalled();
      await act(async () => finish([]));
      expect(mocks.createSession).toHaveBeenCalledTimes(1);

      mocks.createSession.mockClear();
      act(() => latest?.handleCreateSession());
      await act(async () => finish(null));
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      initialSession.attachments = [];
      initialSession.prepareAttachments = async () => [];
    }
  });

  // ⭐ #5597 —— 创建这一层**不许**替用户改档。此前它拿 `unattended` 把 composer 选中的档
  // 无条件覆盖成 full-access,于是草稿上选只读、会话开成最松档,而且不报错(安全边界上的静默失效)。
  // 判据落在**严格档**上:覆盖那一版下面这条必然读到 full-access ⇒ 它会红。
  it('草稿选的严格档原样进落库载荷,❌ 不被无人值守覆盖(#5597)', async () => {
    initialSession.permissionMode = 'read-only';
    initialSession.autoApprove = false;
    await act(async () => root.render(React.createElement(Probe)));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession)
      .toEqual(expect.objectContaining({ permissionMode: 'read-only' }));
  });

  // 群成员里「新建 Agent」:托盘上那个群原样进建会话的参数(主进程据此在身份建出来时进群);没群就没有这一格。
  it('从群里建:birthGroup 进落库参数,群成员里建的是普通座位;不从群里建就不出现', async () => {
    await act(async () => root.render(React.createElement(Probe, { birthChatId: 'chat-group-1' })));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ birthGroup: { chatId: 'chat-group-1', asTask: false } }));
  });

  // gugu-dev#181:对话里派的新任务(带着任务卡的落点)坐任务座位(不发入群提示)。
  it('对话里派的新任务:birthGroup 是任务座位', async () => {
    await act(async () => root.render(React.createElement(Probe, { birthChatId: 'chat-group-1', taskChatId: 'chat-group-1' })));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ birthGroup: { chatId: 'chat-group-1', asTask: true } }));
  });

  it('不从群里建:落库参数里没有 birthGroup', async () => {
    await act(async () => root.render(React.createElement(Probe)));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession.mock.calls[0]?.[0]).not.toHaveProperty('birthGroup');
  });

  it('startup-capable session-page provider puts the first text in the create payload and skips post-create delivery', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'local-session' },
    };
    initialSession.promptCapability = { kind: 'argv', startupDelivery: 'startup-prompt' };
    await act(async () => root.render(React.createElement(Probe)));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession).toEqual(expect.objectContaining({
      initialPrompt: 'make one task',
    }));
    expect(mocks.localSendMessage).not.toHaveBeenCalled();
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
    await act(async () => root.render(React.createElement(Probe)));

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
    await act(async () => root.render(React.createElement(Probe)));

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
    await act(async () => root.render(React.createElement(Probe)));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'make one task' }));
    expect(mocks.navigate).toHaveBeenCalledWith('session', expect.objectContaining({ projectId: 'project-1' }));
    expect(mocks.onClose).toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith('remember the started configuration failed', { error: 'settings unavailable' });
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'Couldn’t save defaults', description: 'settings unavailable', tier: 'warning' });
  });

  it('retries the same created task and stable id after an ambiguous local-session failure', async () => {
    mocks.localSendMessage
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ id: 'local-id', status: 'queued' });

    act(() => latest?.handleCreateSession());
    await act(async () => {});
    const firstId = mocks.localSendMessage.mock.calls[0]?.[0].clientMessageId;
    expect(initialSession.prompt).toBe('make one task');

    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.localSendMessage.mock.calls[1]?.[0].clientMessageId).toBe(firstId);
    expect(initialSession.prompt).toBe('');
  });

  it('identity-none TUI uses conversations.sendMessage', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'none', messageTransport: 'local-session' },
    };
    await act(async () => root.render(React.createElement(Probe)));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'make one task',
      clientMessageId: expect.any(String),
    }));
  });

  // ⬇ P0(owner 现场撞出来):会话页建的会话,首轮曾经也走 IM 私聊投递 —— 于是它被 gugu IM 的
  // 链路裹上 listen-mode `<system_hint>` 送进终端(agent 以为自己在私聊里被叫到)、顺带建出私聊、
  // 触发 shell 的「agent 起来了」事件把人从会话页拽去聊天页。会话页与聊天页行为一模一样。
  //
  // 判据钉的是**首轮通道不读 messageTransport 声明**:provider 明明声明了 router(claude 的 tui 就是),
  // 会话页也**必须**走会话内投递,一次都不许碰私聊(firstTurnTransportOf 只看启动通道)。
  it('任务页创建:首轮走会话内投递,绝不经过 IM 私聊 —— 哪怕 provider 声明了 router', async () => {
    initialSession.sessionView = 'code';
    initialSession.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'router' },
    };
    await act(async () => root.render(React.createElement(Probe)));

    act(() => latest?.handleCreateSession());
    await act(async () => {});

    expect(mocks.localSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'make one task',
    }));
    // 留在会话页:导航到这条会话,它的 id 就是附件落盘时预留的那个。
    expect(mocks.navigate).toHaveBeenCalledWith('session', { projectId: 'project-1', sessionId: mocks.createSession.mock.calls[0]![0].sessionConfig.initialSession.id });
  });
});
