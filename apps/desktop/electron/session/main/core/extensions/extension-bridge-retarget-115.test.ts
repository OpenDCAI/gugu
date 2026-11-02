import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F115 (L4's C1 walk, 统筹 05:01): the resident page moved from plan.md to cfg.json in the same slot heard its
 * context twice — the move zeroed the page's size and pushed, then the slot said its size again (as it does after every
 * move) and, differing from the zero, pushed again. A page that opens its file on a context opened cfg.json twice. The
 * page keeps its size across a move: the same slot says nothing new, a slot of another size says so.
 */

const PAGE = 7;
const CHAT = '0b000000-0000-4000-8000-000000000001';
const PLAN = '0c000000-0000-4000-8000-000000000001';
const CFG = '0c000000-0000-4000-8000-000000000002';
const resourceChat = vi.hoisted(() => vi.fn(async (chatId: string, _reader: { asAgent: string | null }) => chatId));
const sent: { id: number; event: { type: string; context?: { file?: { id: string }; layout?: { width: number; height: number } } } }[] = [];

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {
    fromId: (id: number) =>
      id === PAGE
        ? { id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: (_channel: string, event: never) => sent.push({ id, event }) }
        : undefined,
  },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true,
    isEnabled: () => true, get: () => ({ manifest: { name: 'Workspace', version: '1.0.0' } }) }),
}));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ knownSessionMachine: () => ({ deviceId: 'actual-task-host' }), sessionMachine: async () => null }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// A page in a group hears its context only with its chat (「在本群打开」): the chat is read before the first push.
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: resourceChat,
  localRootOf: async () => ({ workspaceRoot: '/projection-fixture' }),
  chatMembersOf: async () => [],
  surfaceChatOf: async () => ({ id: '0b000000-0000-4000-8000-000000000001', name: 'G', kind: 'group', groupId: '0b000000-0000-4000-8000-000000000001' }),
}));

const { bindExtensionSurface, retargetExtensionSurface, setExtensionBridgeHost, updateExtensionSurfaceLayout } = await import('./extension-bridge');

const contexts = () => sent.filter(({ event }) => event.type === 'context').map(({ event }) => event.context!);

beforeEach(async () => {
  setExtensionBridgeHost({
    deliver: () => Promise.resolve(),
    presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.main', conversation: CHAT, itemId: PLAN });
  updateExtensionSurfaceLayout(PAGE, { visible: true, width: 440, height: 700 });
  // The first context waits for the chat to be read.
  await vi.waitFor(() => expect(contexts().length).toBeGreaterThan(0));
  sent.length = 0;
  resourceChat.mockClear();
});

describe('a resident page moved to another file (摩擦单 F115)', () => {
  it('captures the real bound App/task and revokes remote signing before asynchronous retarget', async () => {
    const { captureSessionpageProjectionViewer, extensionSurfaceBindingForTests, unbindExtensionSurface } = await import('./extension-bridge');
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabKind: 'workspace.main', tabId: 'slot-1',
      workspace: sessionWorkspace('task-a'), conversation: CHAT, operator: { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000001' } });
    expect(extensionSurfaceBindingForTests(PAGE)?.workspace).toBe('session:task-a');
    const captured = await captureSessionpageProjectionViewer(PAGE);
    expect(captured).toMatchObject({ appId: 'workspace', version: '1.0.0', sessionId: 'task-a', deviceId: 'actual-task-host', id: String(PAGE) });
    resourceChat.mockClear();
    const lookup = Promise.withResolvers<void>();
    resourceChat.mockImplementationOnce(async id => { await lookup.promise; return id; });
    const moving = retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-2', workspace: sessionWorkspace('task-b'), conversation: CHAT });
    try {
      expect(captured.signal.aborted).toBe(true); expect(() => captured.assertCurrent()).toThrow(/page changed/);
      await vi.waitFor(() => expect(resourceChat).toHaveBeenCalledOnce());
    } finally { lookup.resolve(); await moving; captured.release(); }
    const next = await captureSessionpageProjectionViewer(PAGE);
    expect(next.epoch).toBeGreaterThan(captured.epoch); expect(next.sessionId).toBe('task-b');
    unbindExtensionSurface(PAGE); expect(next.signal.aborted).toBe(true);
    await expect(captureSessionpageProjectionViewer(PAGE)).rejects.toThrow(/unavailable/);
  });

  it('restores the old task when resolving the target file fails, including the rebind path', async () => {
    const { extensionSurfaceBindingForTests } = await import('./extension-bridge');
    const binding = extensionSurfaceBindingForTests(PAGE)!; binding.workspace = 'session:task-a';
    await expect(retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-2', workspace: sessionWorkspace('task-b'), filePath: '/projection-fixture/absent-file' })).rejects.toThrow(/ENOENT/);
    expect(binding.workspace).toBe('session:task-a');
    await expect(bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabKind: 'workspace.main', tabId: 'slot-2', workspace: sessionWorkspace('task-b'), filePath: '/projection-fixture/absent-file' })).rejects.toThrow(/ENOENT/);
    expect(extensionSurfaceBindingForTests(PAGE)?.workspace).toBe('session:task-a');
  });

  it('restores the last committed task when asynchronous retarget fails', async () => {
    const { extensionSurfaceBindingForTests } = await import('./extension-bridge');
    const binding = extensionSurfaceBindingForTests(PAGE)!;
    binding.workspace = 'session:task-a';
    binding.operator = { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000001' };
    resourceChat.mockRejectedValueOnce(new Error('Membership lookup failed'));
    await expect(retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-2', workspace: sessionWorkspace('task-b'), conversation: CHAT })).rejects.toThrow('Membership lookup failed');
    expect(binding.workspace).toBe('session:task-a');
    // The renderer still remembers task-a, so it may not issue another retarget.
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-3', workspace: sessionWorkspace('task-c'), conversation: CHAT });
    expect(binding.workspace).toBe('session:task-c');
  });

  it('does not let an older failed retarget overwrite a newer successful task', async () => {
    const { extensionSurfaceBindingForTests } = await import('./extension-bridge');
    const binding = extensionSurfaceBindingForTests(PAGE)!;
    binding.workspace = 'session:task-a';
    binding.operator = { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000001' };
    const lookup = Promise.withResolvers<string>();
    resourceChat.mockImplementationOnce(() => lookup.promise);
    const old = retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-2', workspace: sessionWorkspace('task-b'), conversation: CHAT });
    const rejected = expect(old).rejects.toThrow('Old lookup failed');
    await vi.waitFor(() => expect(resourceChat).toHaveBeenCalledOnce());
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-3', workspace: sessionWorkspace('task-c'), conversation: CHAT });
    lookup.reject(new Error('Old lookup failed')); await rejected;
    expect(binding.workspace).toBe('session:task-c');
  });

  it('in the same slot: it hears the new context once, with the size it has', async () => {
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-1', conversation: CHAT, itemId: CFG });
    // The slot says its size again after every move (extension-view-layer `aimAt`).
    updateExtensionSurfaceLayout(PAGE, { visible: true, width: 440, height: 700 });
    expect(contexts()).toHaveLength(1);
    expect(contexts()[0]).toMatchObject({ file: { chat: CHAT, id: CFG }, layout: { width: 440, height: 700 } });
    expect(resourceChat).not.toHaveBeenCalled();
  });

  it('a new file surface uses the live person context without another normalization request', async () => {
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-2', tabKind: 'workspace.main', conversation: CHAT, itemId: CFG });
    updateExtensionSurfaceLayout(PAGE, { visible: true, width: 440, height: 700 });
    expect(resourceChat).not.toHaveBeenCalled();
    expect(contexts().at(-1)).toMatchObject({ file: { chat: CHAT, id: CFG } });
  });

  it('a person context does not stand in for the membership of an agent', async () => {
    const agent = '0a000000-0000-4000-8000-000000000001';
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'agent-slot', tabKind: 'workspace.main', conversation: CHAT, operator: { kind: 'agent', id: `user:${agent}` } });
    expect(resourceChat).toHaveBeenLastCalledWith(CHAT, { asAgent: agent });
    resourceChat.mockRejectedValueOnce(new Error('This chat could not be read'));
    await expect(retargetExtensionSurface({ webContentsId: PAGE, tabId: 'agent-slot', conversation: CHAT, itemId: CFG })).rejects.toThrow('This chat could not be read');
  });

  it('control: in a slot of another size, a second context says the new size', async () => {
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-2', conversation: CHAT, itemId: CFG });
    updateExtensionSurfaceLayout(PAGE, { visible: true, width: 360, height: 640 });
    expect(contexts().map((context) => [context.file?.id, context.layout?.width])).toEqual([
      [CFG, 440],
      [CFG, 360],
    ]);
  });
  it('invalidates a task binding before asynchronous retarget work and closes viewers on rebind', async () => {
    const { extensionProjections } = await import('./extension-projection-bridge');
    const { extensionSurfaceBindingForTests } = await import('./extension-bridge');
    const closed = vi.spyOn(extensionProjections, 'closePage');
    const binding = extensionSurfaceBindingForTests(PAGE)!;
    binding.workspace = 'session:task-a';
    binding.operator = { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000001' };
    let finish!: () => void;
    resourceChat.mockImplementationOnce(async id => { await new Promise<void>(resolve => { finish = resolve; }); return id; });
    try {
      const moving = retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-2', workspace: sessionWorkspace('task-b'), conversation: CHAT });
      expect(binding.workspace).toBeNull();
      expect(closed).toHaveBeenLastCalledWith(PAGE);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function')); finish(); await moving;
      expect(binding.workspace).toBe('session:task-b');
      await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabKind: 'workspace.main', tabId: 'slot-3' });
      expect(closed).toHaveBeenCalledTimes(2);
    } finally { closed.mockRestore(); }
  });

});
