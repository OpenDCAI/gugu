import { beforeEach, expect, it, vi } from 'vitest';
import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';

const state = vi.hoisted(() => ({ granted: true, enabled: true, installed: true }));
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(name, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: vi.fn(), on: vi.fn(), send: vi.fn() }) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'task-app', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({
  grantedCapabilities: () => state.granted ? ['agents:tools'] : [],
  hasCapability: (_id: string, wanted: string) => state.installed && state.granted && wanted === 'agents:tools',
  isEnabled: () => state.enabled,
  get: () => { if (!state.installed) throw new Error('App is no longer installed'); return { manifest: { name: 'Task App' } }; },
}) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { bindExtensionSurface, unbindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost,
  updateAppSurfaceData, retargetExtensionSurface, extensionSurfaceBindingForTests } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const deliver = vi.fn(async (_origin: unknown, _action: unknown) => undefined);
const call = (args: Record<string, unknown>, gesture = true) => handlers.get(EXTENSION_BRIDGE_CHANNEL)!(
  { sender: { id: 7, session: {} } }, { method: 'taskMessage', args, gesture });
beforeEach(async () => {
  Object.assign(state, { granted: true, enabled: true, installed: true }); deliver.mockClear();
  unbindExtensionSurface(7);
  setExtensionBridgeHost({ deliver, presentation: () => ({ locale: 'zh-CN', themeMode: 'light', fullscreen: false, windowFocused: true }) });
  await bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'task-tab', tabKind: 'task-app.task', workspace: sessionWorkspace('bound-task') });
});

it('passes a fixed ordinary message and the host-bound task through the real bridge', async () => {
  expect(await call({ intent: 'pause' })).toEqual({ ok: true, value: undefined });
  expect(deliver).toHaveBeenCalledExactlyOnceWith({ extensionId: 'task-app', sessionId: 'bound-task', tabId: 'task-tab', embedderId: 42 },
    { kind: 'taskMessage', text: '请暂停。' });
});

it('does not lend a decorative native document a gesture, input channel or focus request', async () => {
  await bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'decoration', tabKind: 'task-app.surface',
    workspace: sessionWorkspace('bound-task'), surface: { id: 'decoration', decorative: true } });
  for (const [method, args] of [['taskMessage', { intent: 'pause' }], ['modalOpen', { entry: 'focus.html' }],
    ['appSurfacePost', { message: { click: true } }], ['projectionSend', { id: 'fake', input: {} }]] as const) {
    expect(await handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: { id: 7, session: {} } },
      { method, args, gesture: true, decorative: false })).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(deliver).not.toHaveBeenCalled();
});

async function expectDecorativeRefusals() {
  for (const [method, args] of [['taskMessage', { intent: 'pause' }], ['modalOpen', { entry: 'focus.html' }],
    ['modalKey', { key: 'tab' }], ['appSurfacePost', { message: { click: true } }],
    ['projectionSend', { id: 'fake', input: {} }]] as const) {
    expect(await handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: { id: 7, session: {} } },
      { method, args, gesture: true, decorative: false })).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(extensionSurfaceBindingForTests(7)?.surface?.decorative).toBe(true);
  expect(deliver).not.toHaveBeenCalled();
}
const bindDecoration = () => bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'decoration', tabKind: 'task-app.surface',
  workspace: sessionWorkspace('bound-task'), surface: { id: 'decoration', decorative: true, data: {} } });

it('preserves the immutable mode across repeated display data updates, including data that claims another mode', async () => {
  await bindDecoration();
  for (const data of [{ frame: 1 }, { decorative: false, id: 'another-surface', frame: 2 }]) {
    updateAppSurfaceData(7, 'decoration', data);
    expect(extensionSurfaceBindingForTests(7)?.surface).toMatchObject({ id: 'decoration', data });
    await expectDecorativeRefusals();
  }
  expect(() => updateAppSurfaceData(7, 'wrong-surface', {})).toThrow('binding changed');
  await expectDecorativeRefusals();
});

it('keeps its native surface metadata when generic host rebinding omits it or supplies only new data', async () => {
  await bindDecoration(); updateAppSurfaceData(7, 'decoration', { frame: 1 });
  const rebind = { webContentsId: 7, extensionId: 'task-app', tabId: 'decoration', tabKind: 'task-app.surface', workspace: sessionWorkspace('bound-task') };
  await bindExtensionSurface(rebind); await expectDecorativeRefusals();
  await bindExtensionSurface({ ...rebind, surface: { id: 'decoration', data: { frame: 2 } } });
  await expectDecorativeRefusals();
  for (const surface of [{ id: 'decoration', decorative: false }, { id: 'replacement', decorative: true }]) {
    await expect(bindExtensionSurface({ ...rebind, surface })).rejects.toThrow('native surface');
    await expectDecorativeRefusals();
  }
});

it('retains decorative refusal after retarget and restoration of a failed host rebind', async () => {
  await bindDecoration(); updateAppSurfaceData(7, 'decoration', { frame: 1 });
  await retargetExtensionSurface({ webContentsId: 7, tabId: 'decoration', workspace: sessionWorkspace('bound-b') });
  await expectDecorativeRefusals();
  const files = await import('./app-files');
  const lookup = vi.spyOn(files, 'resourceChatOf').mockRejectedValueOnce(new Error('fixture lookup failed'));
  try {
    await expect(bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'decoration', tabKind: 'task-app.surface',
      workspace: sessionWorkspace('bound-c'), conversation: 'fixture-chat' })).rejects.toThrow('fixture lookup failed');
    expect(extensionSurfaceBindingForTests(7)?.workspace).toBe('session:bound-b');
    await expectDecorativeRefusals();
  } finally { lookup.mockRestore(); }
});

it('owns a copy of native mode facts rather than a mutable reference supplied by the host caller', async () => {
  const surface = { id: 'decoration', decorative: true, data: {} };
  await bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'decoration', tabKind: 'task-app.surface',
    workspace: sessionWorkspace('bound-task'), surface });
  surface.decorative = false;
  await expectDecorativeRefusals();
});

it('does not send without a host gesture or with an App-supplied target or text', async () => {
  expect(await call({ intent: 'pause', gesture: true }, false)).toMatchObject({ ok: false, code: 'denied' });
  for (const extra of [{ sessionId: 'other-task' }, { text: 'arbitrary' }]) {
    expect(await call({ intent: 'continue', ...extra })).toMatchObject({ ok: false, code: 'invalid' });
  }
  expect(deliver).not.toHaveBeenCalled();
});

it('refuses an unbound click at IPC admission instead of lending a later task B binding to it', async () => {
  unbindExtensionSurface(7);
  const oldClick = call({ intent: 'pause' });
  await bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'task-b-tab', tabKind: 'task-app.task', workspace: sessionWorkspace('task-b') });
  expect(await oldClick).toMatchObject({ ok: false, code: 'denied' });
  expect(deliver).not.toHaveBeenCalled();
  expect(await call({ intent: 'continue' })).toMatchObject({ ok: true });
  expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'task-b' }), { kind: 'taskMessage', text: '请继续。' });
});

it('does not admit a task shortcut while the host is rebinding the page', async () => {
  const rebinding = bindExtensionSurface({ webContentsId: 7, extensionId: 'task-app', tabId: 'task-b-tab', tabKind: 'task-app.task', workspace: sessionWorkspace('task-b') });
  const oldClick = call({ intent: 'pause' });
  await rebinding;
  expect(await oldClick).toMatchObject({ ok: false, code: 'denied' });
  expect(deliver).not.toHaveBeenCalled();
});

it('honors permission withdrawal, disabling and uninstalling at the next click', async () => {
  state.granted = false;
  expect(await call({ intent: 'pause' })).toMatchObject({ ok: false, code: 'denied' });
  state.granted = true; state.enabled = false;
  expect(await call({ intent: 'pause' })).toMatchObject({ ok: false });
  state.enabled = true; state.installed = false;
  expect(await call({ intent: 'pause' })).toMatchObject({ ok: false, code: 'denied' });
  expect(deliver).not.toHaveBeenCalled();
});
