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
const { bindExtensionSurface, unbindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const deliver = vi.fn(async (_origin: unknown, _action: unknown) => undefined);
const call = (args: Record<string, unknown>, gesture = true) => handlers.get(EXTENSION_BRIDGE_CHANNEL)!(
  { sender: { id: 7, session: {} } }, { method: 'taskMessage', args, gesture });
beforeEach(async () => {
  Object.assign(state, { granted: true, enabled: true, installed: true }); deliver.mockClear();
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
