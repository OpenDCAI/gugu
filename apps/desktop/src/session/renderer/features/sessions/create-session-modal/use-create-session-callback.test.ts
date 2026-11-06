import { SessionCreationFailedError } from '../stores/session-failure';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import type { CreateSessionState } from './use-create-session-state';
import { machineRegistry } from '@renderer/lib/machine-routing';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  admit: vi.fn(),
  start: vi.fn(),
  localSendMessage: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
  onClose: vi.fn(),
  onCreated: vi.fn(),
  assertProtocol: vi.fn(),
  installAgent: vi.fn(),
  stopInstallProgress: vi.fn(),
}));
const devices = vi.hoisted(() => [] as Array<{ device_id: string; capabilities: { remote_protocol?: number } }>);

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionManagerStore: () => ({ createSession: mocks.createSession }),
  getSessionPageStore: () => ({ workspaceId: 'workspace' }),
  asProvisioned: (value: unknown) => value,
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { sessions: { sendMessage: mocks.localSendMessage } },
  rpcOn: () => ({ sessionCreate: { admitFirstMessages: mocks.admit }, sessionTimeline: { sessionStart: mocks.start }, agents: { install: mocks.installAgent } }),
  onMachineEvent: () => mocks.stopInstallProgress,
}));
vi.mock('@renderer/lib/stores/use-agents', () => ({
  useAgents: () => ({ data: [{ id: 'codex', name: 'Codex', reading: 'not-detected' }] }),
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, params?: Record<string, unknown>) => `${key} ${Object.values(params ?? {}).join(' ')}`.trim() }),
}));
vi.mock('@/lib/taskAttachmentTarget', () => ({ assertTaskAttachmentProtocol: mocks.assertProtocol, taskAttachmentUsesSsh: () => false, taskAttachmentWorkspacePath: (id: string, name: string) => `.gugu/attachments/${id}/${name}` }));
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => devices }));
vi.mock('@renderer/utils/logger', () => ({ log: { error: mocks.logError, warn: mocks.logWarn } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));

const { useCreateSessionCallback } = await import('./use-create-session-callback');
const { useRemoteInstallBeforeCreate } = await import('../remote-install-before-create');

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
  openAfterCreate,
  remoteInstall = false,
}: {
  birthChatId?: string
  taskChatId?: string
  openAfterCreate?: boolean
  remoteInstall?: boolean
}) {
  const { beforeCreate } = useRemoteInstallBeforeCreate(remoteInstall ? { deviceId: 'remote-1', label: 'Remote' } : null, initialSession.provider);
  latest = useCreateSessionCallback({
    selectedProjectId: 'project-1',
    state: sessionState,
    initialSession,
    navigate: mocks.navigate as unknown as NavigateFnTyped,
    onClose: mocks.onClose,
    onCreated: mocks.onCreated,
    birthChatId,
    taskChatId,
    openAfterCreate,
    beforeCreate,
  });
  return null;
}

function attachFirstFile() {
  const ref = { itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 };
  const chip = { id: 'file', name: ref.name, kind: 'file' as const };
  initialSession.promptCapability = { kind: 'none', startupDelivery: 'startup-prompt' };
  initialSession.attachments = [chip];
  initialSession.prepareAttachments = vi.fn(async () => [ref]);
  initialSession.placeAttachments = vi.fn(async () => [ref]);
  initialSession.dropAttachment = vi.fn();
  return { ref, chip };
}

describe('useCreateSessionCallback ordinary messaging', () => {
  let dom: JSDOM;
  let root: Root;

  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createSession.mockImplementation(async (_params: unknown, options?: { onOptimistic?: () => void }) => { options?.onOptimistic?.(); });
    mocks.localSendMessage.mockResolvedValue({ id: 'local-id', status: 'queued' });
    mocks.start.mockResolvedValue({ ok: true });
    mocks.installAgent.mockResolvedValue({ success: true });
    devices.length = 0;
    initialSession.attachments = [];
    initialSession.prepareAttachments = async () => [];
    initialSession.placeAttachments = async () => [];
    initialSession.dropAttachment = () => {};
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
    machineRegistry.forgetMachine('remote-host');
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it.each([
    [{ type: 'no-install-command', id: 'codex' }, 'agentsPage.errNoInstallCommand codex'],
    [{ type: 'unsupported-host', message: 'No installer here' }, 'agentsPage.errUnsupportedHost'],
    [{ type: 'command-failed', message: 'npm failed', output: `npm error code EACCES\n${'extra diagnostic output\n'.repeat(500)}`, stage: 'install' }, 'EACCES'],
  ] as const)('a failed remote install leaves its reason in deliveryError without creating or clearing the draft: %j', async (error, reason) => {
    const chips = [{ id: 'kept-chip' }] as never;
    initialSession.attachments = chips;
    mocks.installAgent.mockResolvedValue({ success: false, error });
    await act(async () => root.render(React.createElement(Probe, { remoteInstall: true })));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.installAgent).toHaveBeenCalledExactlyOnceWith('codex');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(latest?.deliveryError).toMatchObject({ kind: 'raw', detail: expect.stringContaining(reason) });
    if (typeof error === 'object' && 'output' in error) {
      expect(latest?.deliveryError).not.toMatchObject({ detail: expect.stringContaining('Failed at stage: install') });
      expect(latest?.deliveryError).not.toMatchObject({ detail: expect.stringContaining('extra diagnostic output') });
      expect(mocks.logError).toHaveBeenCalledWith('remote agent installation failed', {
        providerId: 'codex', diagnostic: expect.stringContaining(error.output.trim()),
      });
    }
    expect(initialSession.prompt).toBe('make one task');
    expect(initialSession.attachments).toBe(chips);
    expect(mocks.stopInstallProgress).toHaveBeenCalledTimes(1);
    expect(mocks.onClose).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { success: 'true' }, { success: false }])('an invalid remote install result blocks creation and says so: %j', async (result) => {
    mocks.installAgent.mockResolvedValue(result);
    await act(async () => root.render(React.createElement(Probe, { remoteInstall: true })));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(latest?.deliveryError).toMatchObject({ kind: 'raw', detail: expect.stringContaining('Invalid agents.install result') });
    expect(initialSession.prompt).toBe('make one task');
    expect(mocks.stopInstallProgress).toHaveBeenCalledTimes(1);
  });

  it('keeps the original machine when routing changes before a delayed creation error returns', async () => {
    const machine = vi.spyOn(machineRegistry, 'machineOf').mockReturnValue('original-machine');
    try {
      await act(async () => root.render(React.createElement(Probe)));
      let reject!: (error: Error) => void;
      mocks.createSession.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
      await act(async () => latest!.handleCreateSession());
      machine.mockReturnValue('new-machine');
      await act(async () => { reject(new Error('local Codex app-server exited (code=1 signal=null)')); await Promise.resolve(); });
      expect(latest!.deliveryError).toMatchObject({ target: { machineId: 'original-machine', leg: 'acp' } });
    } finally { machine.mockRestore(); }
  });

  it('keeps a typed missing-engine failure with its target for the shared composer notice', async () => {
    mocks.createSession.mockRejectedValue(new SessionCreationFailedError('harness-unavailable', { kind: 'harness-unavailable', reason: 'missing', providerId: 'codex', harnessName: 'Codex', detail: 'missing executable' }));
    await act(async () => latest!.handleCreateSession());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(latest!.deliveryError).toMatchObject({ kind: 'harness-unavailable', reason: 'missing', target: { leg: 'acp' } });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('a successful remote install continues through the existing create path', async () => {
    await act(async () => root.render(React.createElement(Probe, { remoteInstall: true })));
    act(() => latest?.handleCreateSession());
    await act(async () => {});
    expect(mocks.installAgent).toHaveBeenCalledExactlyOnceWith('codex');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(latest?.deliveryError).toBeNull();
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([15, undefined])('keeps the file chip and draft without creating on remote attachment protocol %s', async protocol => {
    machineRegistry.register('remote-host', ['project-1']);
    devices.push({ device_id: 'remote-host', capabilities: { remote_protocol: protocol } });
    mocks.assertProtocol.mockImplementationOnce(() => { throw new Error('Update the task host to send attachments'); });
    const { chip } = attachFirstFile();
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(mocks.assertProtocol).toHaveBeenCalledWith(protocol);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(initialSession.prepareAttachments).not.toHaveBeenCalled();
    expect(initialSession.placeAttachments).not.toHaveBeenCalled();
    expect(initialSession.dropAttachment).not.toHaveBeenCalled();
    expect(initialSession.attachments).toEqual([chip]);
    expect(initialSession.prompt).toBe('make one task');
    expect(latest?.deliveryError).toEqual({ kind: 'raw', detail: 'Update the task host to send attachments' });
    expect(mocks.navigate).not.toHaveBeenCalled();

    initialSession.attachments = [];
    initialSession.attachmentEditSeq += 1;
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(latest?.deliveryError).toBeNull();
    expect(mocks.navigate).toHaveBeenCalled();
  });

  it.each([null, 'remote-host'])('creates an attached task on a local or protocol-16 host (machine=%s)', async machine => {
    if (machine) machineRegistry.register(machine, ['project-1']);
    devices.push({ device_id: 'remote-host', capabilities: { remote_protocol: machine ? 16 : 15 } });
    const { ref } = attachFirstFile();
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    if (machine) expect(mocks.assertProtocol).toHaveBeenCalledWith(16);
    else expect(mocks.assertProtocol).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.createSession.mock.calls[0]?.[0].sessionConfig.initialSession.initialQueue[0].files).toEqual([ref]);
    expect(mocks.admit).toHaveBeenCalledOnce();
    expect(latest?.deliveryError).toBeNull();
    expect(mocks.navigate).toHaveBeenCalled();
  });

  it('still navigates to the created task when the first-turn admission RPC fails', async () => {
    attachFirstFile();
    mocks.admit.mockRejectedValueOnce(new Error('[machine] internal-device runs an older host without sessionCreate.admitFirstMessages'));
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.admit).toHaveBeenCalledOnce();
    expect(latest?.deliveryError).toBeNull();
    expect(mocks.logWarn).toHaveBeenCalledWith('admit the first task turn failed', expect.objectContaining({ error: expect.stringContaining('admitFirstMessages') }));
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith('session', expect.objectContaining({ projectId: 'project-1' }));
    expect(mocks.onClose).toHaveBeenCalled();
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

  it.each([undefined, 'chat-target'])('PTY startup only includes a local path outside a chat task card (chat=%s)', async taskChatId => {
    const ref = { itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3, path: '/private/brief.txt' };
    initialSession.sessionView = 'code';
    initialSession.sessionpage = { 'tui': { identity: 'addressable', messageTransport: 'local-session' } };
    initialSession.promptCapability = { kind: 'argv', startupDelivery: 'startup-prompt' };
    initialSession.attachments = [{ id: 'file', name: ref.name, kind: 'file' }];
    initialSession.prepareAttachments = async () => [ref];
    initialSession.placeAttachments = async () => [ref];
    await act(async () => root.render(React.createElement(Probe, { taskChatId })));
    try {
      await act(async () => latest?.handleCreateSession());
      const prompt = mocks.createSession.mock.calls.at(-1)?.[0].sessionConfig.initialSession.initialPrompt as string;
      expect(prompt).toContain('make one task');
      expect(prompt).toContain('brief.txt');
      expect(prompt).toContain('gugu-file://brief?v=1');
      if (taskChatId) {
        expect(prompt).not.toContain(ref.path);
        expect(prompt).toContain('not saved');
      } else expect(prompt).toContain(ref.path);
    } finally {
      initialSession.attachments = [];
      initialSession.prepareAttachments = async () => [];
      initialSession.placeAttachments = async () => [];
    }
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
  it.each([true, false])('keeps the first turn deferred until attachment placement finishes (placed=%s)', async placed => {
    const ref = { itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 };
    let finish!: (value: typeof ref[] | null) => void;
    initialSession.promptCapability = { kind: 'none', startupDelivery: 'startup-prompt' };
    initialSession.attachments = [{ id: 'file', name: ref.name, kind: 'file' }];
    initialSession.prepareAttachments = async () => [ref];
    initialSession.placeAttachments = () => new Promise(resolve => { finish = resolve; });
    mocks.admit.mockReset().mockResolvedValue(undefined);
    await act(async () => root.render(React.createElement(Probe)));
    try {
      await act(async () => latest?.handleCreateSession());
      expect(mocks.createSession.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ deferFirstTurn: true, onOptimistic: expect.any(Function) }));
      const initial = mocks.createSession.mock.calls.at(-1)?.[0].sessionConfig.initialSession;
      expect(initial.initialQueue[0]).toMatchObject({ text: 'make one task', files: [ref] });
      expect(mocks.admit).not.toHaveBeenCalled();
      await act(async () => finish(placed ? [ref] : null));
      expect(mocks.admit).toHaveBeenCalledExactlyOnceWith(initial.id);
      expect(mocks.onClose).toHaveBeenCalled();
    } finally {
      initialSession.attachments = [];
      initialSession.prepareAttachments = async () => [];
      initialSession.placeAttachments = async () => [];
    }
  });

  it.each(['', '\nnewer draft'])('consumes only the submitted startup draft after creation succeeds (extra=%s)', async extra => {
    let complete!: () => void;
    mocks.createSession.mockImplementationOnce((_params: unknown, options?: { onOptimistic?: () => void }) => {
      options?.onOptimistic?.();
      return new Promise<void>(resolve => { complete = resolve; });
    });
    initialSession.prompt = '  original draft  ';
    initialSession.promptCapability = { kind: 'none', startupDelivery: 'startup-prompt' };
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(initialSession.prompt).toBe('  original draft  ');
    initialSession.prompt += extra;
    await act(async () => complete());
    expect(initialSession.prompt).toBe(extra.replace(/^\n/, ''));
    expect(mocks.navigate).toHaveBeenCalled();
  });

  it.each(['startup', 'local-session'])('consumes a successful %s draft when the page stays open', async transport => {
    initialSession.promptCapability = transport === 'startup' ? { kind: 'none', startupDelivery: 'startup-prompt' } : { kind: 'keystroke' };
    if (transport === 'local-session') {
      initialSession.sessionView = 'code';
      initialSession.sessionpage = { tui: { identity: 'none', messageTransport: 'local-session' } };
    }
    await act(async () => root.render(React.createElement(Probe, { openAfterCreate: false })));
    await act(async () => latest?.handleCreateSession());
    expect(initialSession.prompt).toBe('');
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('a successful PTY attachment delivery consumes the raw caption rather than the expanded prompt', async () => {
    attachFirstFile();
    initialSession.prompt = '  original caption  ';
    initialSession.sessionView = 'code';
    initialSession.sessionpage = { tui: { identity: 'none', messageTransport: 'local-session' } };
    initialSession.promptCapability = { kind: 'keystroke' };
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(mocks.localSendMessage.mock.calls[0]?.[0].text).toContain('gugu-file://brief?v=1');
    expect(initialSession.prompt).toBe('');
  });

  it('documents that editing after delivery failure still retries the original request', async () => {
    mocks.localSendMessage.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ id: 'retried', status: 'queued' });
    await act(async () => latest?.handleCreateSession());
    initialSession.prompt = 'edited after failure';
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(mocks.localSendMessage.mock.calls.map(([request]) => request.text)).toEqual(['make one task', 'make one task']);
    expect(initialSession.prompt).toBe('edited after failure');
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it('a created PTY retry consumes the original caption while keeping newer input', async () => {
    attachFirstFile();
    initialSession.sessionView = 'code';
    initialSession.sessionpage = { tui: { identity: 'none', messageTransport: 'local-session' } };
    initialSession.promptCapability = { kind: 'keystroke' };
    mocks.localSendMessage.mockRejectedValueOnce(new Error('not delivered')).mockResolvedValueOnce({ id: 'retried', status: 'queued' });
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(initialSession.prompt).toBe('make one task');
    initialSession.prompt += '\nnewer draft';
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => latest?.handleCreateSession());
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(initialSession.prompt).toBe('newer draft');
  });

});
