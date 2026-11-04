import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { closeProgramResources } from './program-resource-lifetime';

const state = vi.hoisted(() => ({ windows: [] as unknown[], failPassthrough: false }));
const binding = vi.hoisted(() => ({ bindExtensionSurface: vi.fn(async () => {}), unbindExtensionSurface: vi.fn(),
  updateExtensionSurfaceLayout: vi.fn(), updateAppSurfaceData: vi.fn() }));
vi.mock('electron', () => ({
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }) },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { id: 913, setWindowOpenHandler: vi.fn() });
    destroyed = false; visible = false;
    constructor(public options: Record<string, unknown>) { super(); state.windows.push(this); }
    setIgnoreMouseEvents = vi.fn(() => { if (state.failPassthrough) throw new Error('native passthrough unavailable'); });
    setFocusable = vi.fn(); setContentProtection = vi.fn(); setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn();
    loadURL = vi.fn(async () => {}); isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => { this.destroyed = true; this.visible = false; });
    showInactive = vi.fn(() => { this.visible = true; }); hide = vi.fn(() => { this.visible = false; }); isVisible = () => this.visible;
    moveAbove = vi.fn(); setBounds = vi.fn(); getContentBounds = () => ({ x: 0, y: 0, width: 100, height: 100 });
  },
}));
vi.mock('./extension-bridge', () => binding);
vi.mock('./extensions-root', () => ({ extensionsService: () => ({ get: () => ({ rootDir: '/synthetic', manifest: { apiVersion: 30 } }),
  isEnabled: () => true, hasCapability: () => true, grantedHosts: () => [] }) }));
vi.mock('./extension-session', () => ({ configureExtensionSession: vi.fn() }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/synthetic/preload.cjs' }));
vi.mock('./projection-task', () => ({ projectionTaskProject: async () => 'project' }));
vi.mock('../sessions/session-events', () => ({ sessionEvents: { on: vi.fn() } }));
vi.mock('../projects/project-events', () => ({ projectEvents: { on: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
const { extensionAppSurfaces } = await import('./app-surface-host');
const from = { kind: 'program', pageId: -913, extensionId: 'decoration-app', callingSession: 'task-a',
  signal: new AbortController().signal, hear: vi.fn() } as unknown as BridgeCaller;
type Window = { options: Record<string, unknown>; setIgnoreMouseEvents: ReturnType<typeof vi.fn>; setFocusable: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
  webContents: EventEmitter; visible: boolean };
beforeEach(() => { state.windows.length = 0; state.failPassthrough = false; vi.clearAllMocks(); });
afterEach(async () => { await closeProgramResources(-913); });
const open = () => extensionAppSurfaces.open(from, { entry: 'cursor.html', bounds: { x: 0, y: 0, width: 100, height: 100 }, decorative: true });

it('sets native passthrough and a trusted immutable binding before any App script loads', async () => {
  expect(open()).toMatchObject({ shown: false });
  await vi.waitFor(() => expect(binding.bindExtensionSurface).toHaveBeenCalled());
  const win = state.windows[0] as Window;
  expect(win.options).toMatchObject({ focusable: false, show: false, webPreferences: { sandbox: true, contextIsolation: true, focusOnNavigation: false } });
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
  expect(win.setIgnoreMouseEvents.mock.calls.every(args => args.length === 1)).toBe(true);
  expect(win.setFocusable).toHaveBeenCalledWith(false);
  expect(win.setIgnoreMouseEvents.mock.invocationCallOrder[0]).toBeLessThan(win.loadURL.mock.invocationCallOrder[0]!);
  expect(binding.bindExtensionSurface).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'session:task-a', surface: expect.objectContaining({ decorative: true }) }));
  const preventDefault = vi.fn(); win.webContents.emit('before-input-event', { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
});
it('closes the hidden native window on a passthrough failure while open already returned its display handle', async () => {
  state.failPassthrough = true;
  expect(open()).toMatchObject({ shown: false });
  await vi.waitFor(() => expect((state.windows[0] as Window).destroy).toHaveBeenCalled());
  const win = state.windows[0] as Window;
  expect(win.visible).toBe(false); expect(win.showInactive).not.toHaveBeenCalled(); expect(win.loadURL).not.toHaveBeenCalled();
  expect(binding.bindExtensionSurface).not.toHaveBeenCalled();
});
