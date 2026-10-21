import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7126: in one of four checks of radar 0.1.2 on mac1, Electron's own sandbox bootstrap printed two console errors
 * (`node:electron/js2c/sandbox_bundle`) — the App's page worked (its text and tools were all read back), yet the check
 * said ok:false and told the agent to fix its App. What Electron's own scripts say is gugu's failure: said apart
 * (`host_errors`), never counted against the App. On a fake clock.
 */

type Listener = (...args: unknown[]) => void;
/** What the page prints while it loads: [level, message, sourceId]. */
const printed: [string, string, string][] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false;
    private readonly listeners = new Map<string, Listener[]>();
    readonly webContents = {
      id: 7,
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: Listener) => void this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]),
      once: () => undefined,
      isDestroyed: () => this.destroyed,
      executeJavaScript: async () => 'Radar',
    };
    loadURL = async () => {
      for (const [level, message, sourceId] of printed) {
        for (const listener of this.listeners.get('console-message') ?? []) listener({ level, message, sourceId, lineNumber: 2 });
      }
    };
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
    };
  },
}));
const warned = vi.hoisted(() => [] as unknown[]);
vi.mock('@main/lib/logger', () => ({ log: { warn: (...args: unknown[]) => void warned.push(args) } }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/preload.js' }));
vi.mock('./extension-check-source', () => ({ sourceLine: () => null, staticHints: () => [] }));
vi.mock('./extension-bridge', () => ({
  bindExtensionSurface: () => undefined,
  recentExtensionErrors: () => [],
  checkReadingsOf: () => null,
  reportBlockedNavigation: () => undefined,
  showAgentPageInTheme: () => undefined,
  shownTabWidth: () => null,
  watchExtensionSurfaceErrors: () => () => undefined,
}));
vi.mock('./extension-programs', () => ({
  extensionPrograms: { installed: () => [], tools: async () => [] },
  programFailureReason: () => '',
  agentToolsOf: () => ({ tools: [], clashes: [] }),
}));
vi.mock('./extension-session', () => ({ configureExtensionSession: () => undefined }));
vi.mock('./extension-look-picture', () => ({
  keepPainting: async () => undefined,
  picturesOf: async () => [],
  endPictures: () => undefined,
  GROUP_PANEL: { width: 520, touch: false, says: '520 wide' },
  PHONE: { width: 412, touch: true, says: '412 wide' },
  PICTURE_MAX_HEIGHT: 900,
  taskPane: () => ({ width: 952, touch: false, says: '952 wide' }),
  pictureOf: async () => null,
  showAtSize: async () => undefined,
}));
// The snapshot and the steps are extension-check-steps.test.ts's: here the page's tree reads as one line.
vi.mock('./extension-check-steps', () => ({
  ariaSnapshot: () => '- text: "page"',
  byDeadline: <T>(work: Promise<T>) => work,
  readTree: async () => ({ nodes: [] }),
  runSteps: async () => ({ results: [], pictures: [] }),
}));
vi.mock('./extension-webview-security', () => ({ isAllowedExtensionNavigation: () => true }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({ rootDir: '/bundle', manifest: { id: 'radar', entry: 'radar.html', contributes: { tabs: [{ name: 'radar', entry: 'radar.html' }] } } }),
    grantedHosts: () => [],
  }),
}));

const { checkExtensionSurface } = await import('./extension-check');
const { checkResult } = await import('./extension-agent-actions');

/** Electron's two lines, as #7126's run printed them. */
const SANDBOX = 'node:electron/js2c/sandbox_bundle';
const BOOTSTRAP: [string, string, string][] = [
  ['error', 'Electron sandboxed_renderer.bundle.js script failed to run', SANDBOX],
  ['error', "TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null.", SANDBOX],
];

async function check(lines: [string, string, string][]): Promise<ReturnType<typeof checkResult>> {
  printed.splice(0, printed.length, ...lines);
  const running = checkExtensionSurface({ extensionId: 'radar', tabName: 'radar', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' } });
  await vi.advanceTimersByTimeAsync(20_000);
  return checkResult(await running);
}

beforeEach(() => {
  vi.useFakeTimers();
  warned.splice(0);
});
afterEach(() => vi.useRealTimers());

describe('Electron failing to start the page is gugu\'s failure, not the App\'s (#7126)', () => {
  it('its lines go to host_errors and gugu\'s log; the App that worked is ok, and told to change nothing', async () => {
    const result = await check(BOOTSTRAP);
    expect(result.ok).toBe(true);
    expect(result.console).toEqual([]);
    expect(result.host_errors).toEqual([
      { level: 'error', message: `Electron sandboxed_renderer.bundle.js script failed to run (${SANDBOX}:2)` },
      { level: 'error', message: `TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null. (${SANDBOX}:2)` },
    ]);
    expect(result.next).toMatch(/gugu's problem, not your App's — change nothing in your App for it/);
    expect(warned).toHaveLength(2);
  });

  it('control: the same line from the App\'s own script is the App\'s, and fails it', async () => {
    const result = await check([['error', BOOTSTRAP[0]![1], 'gugu-ext://radar/radar.js']]);
    expect(result.ok).toBe(false);
    expect(result.console).toEqual([{ level: 'error', message: `${BOOTSTRAP[0]![1]} (gugu-ext://radar/radar.js:2)` }]);
    expect(result).not.toHaveProperty('host_errors');
  });

  it('both: not ok for the App\'s own error, and told to check again before changing anything', async () => {
    const result = await check([...BOOTSTRAP, ['error', 'ReferenceError: gugu is not defined', 'gugu-ext://radar/radar.js']]);
    expect(result.ok).toBe(false);
    expect(result.host_errors).toHaveLength(2);
    expect(result.next).toMatch(/run app_check again before you change anything/);
  });

  it('none: no host_errors, and nothing said about them', async () => {
    const result = await check([]);
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('host_errors');
    expect(result.next).not.toMatch(/gugu itself/);
  });
});
