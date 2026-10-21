import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_STEP_WAIT_MS, EXTENSION_STEPS_TIMEOUT_MS } from '@shared/extensions/extension-check';

/**
 * Review r1 (10-12, an Electron 44 probe): a page whose main thread loops answers nothing — `executeJavaScript` and every
 * CDP command wait for good, and only `win.destroy()` comes back. app_check must still return within its own time,
 * destroy its hidden window, and never call such a page ok (review r2): whether it freezes when a step clicks, before
 * the steps, from its load, or while its pictures are taken. The steps are the real ones; the page and its pictures are
 * stand-ins that stop answering when told to. Control: the parent a3bebb7e90 hung (r1); 2dd5aab7e7 called the first ok (r2).
 */

type Listener = (...args: unknown[]) => void;
const page = { frozen: false, freezeOnClick: false, freezeOnResize: false, freezeOnPictures: false, ticking: false, destroyed: 0 };
const never = () => new Promise<never>(() => undefined);
/** A page with one button, "Go". */
const TREE = { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 }] };

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false;
    readonly webContents = {
      id: 9,
      setWindowOpenHandler: () => undefined,
      on: (_event: string, _listener: Listener) => undefined,
      once: () => undefined,
      isDestroyed: () => this.destroyed,
      // Ticking: a live page whose text changes every 100 ms, each read answered in 5 ms (a clock, a progress bar, a stream).
      executeJavaScript: async () =>
        page.frozen ? never() : page.ticking ? new Promise((resolve) => setTimeout(() => resolve(String(Math.floor(Date.now() / 100))), 5)) : 'Board',
      debugger: {
        isAttached: () => true,
        attach: () => undefined,
        sendCommand: async (method: string, params: { type?: string }) => {
          if (page.frozen) return never();
          if (method === 'Accessibility.getFullAXTree') return TREE;
          if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 40, 0, 40, 20, 0, 20] } };
          if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && page.freezeOnClick) page.frozen = true;
          return {};
        },
      },
    };
    loadURL = async () => undefined;
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
      page.destroyed += 1;
    };
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined } }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/preload.js' }));
vi.mock('./extension-check-source', () => ({ sourceLine: () => null, staticHints: () => [] }));
vi.mock('./extension-bridge', () => ({
  bindExtensionSurface: () => undefined,
  recentExtensionErrors: () => [],
  checkReadingsOf: () => ({ writes: 0, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 1, opensSettled: 1, shown: [] }),
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
// What waits on the page waits for good once it is frozen, as the probe read.
vi.mock('./extension-look-picture', () => ({
  keepPainting: async () => undefined,
  picturesOf: async () => {
    if (page.freezeOnPictures) page.frozen = true;
    return page.frozen ? never() : [];
  },
  endPictures: () => undefined,
  GROUP_PANEL: { width: 520, touch: false, says: '520 wide' },
  PHONE: { width: 412, touch: true, says: '412 wide' },
  PICTURE_MAX_HEIGHT: 900,
  taskPane: () => ({ width: 952, touch: false, says: '952 wide' }),
  pictureOf: async () => (page.frozen ? never() : { label: 'p', mimeType: 'image/jpeg', data: 'AAAA' }),
  showAtSize: async () => {
    if (page.freezeOnResize) page.frozen = true;
    return page.frozen ? never() : undefined;
  },
}));
vi.mock('./extension-webview-security', () => ({ isAllowedExtensionNavigation: () => true }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({ rootDir: '/bundle', manifest: { id: 'board', entry: 'main.html', contributes: { tabs: [{ name: 'main', entry: 'main.html' }] } } }),
    grantedHosts: () => [],
  }),
}));

const { checkExtensionSurface } = await import('./extension-check');
const { checkResult } = await import('./extension-agent-actions');

/** The whole check's time: loading and settling, the steps, then the snapshot and a picture, each their own wait. */
const BUDGET_MS = 15_000 + EXTENSION_STEPS_TIMEOUT_MS + 2 * EXTENSION_STEP_WAIT_MS;

async function checkWithin(ms: number, withSteps = true) {
  let report: Awaited<ReturnType<typeof checkExtensionSurface>> | undefined;
  const steps = withSteps ? { steps: [{ click: { role: 'button', name: 'Go' } }, { click: { role: 'button', name: 'Go' } }] } : {};
  void checkExtensionSurface({ extensionId: 'board', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' }, ...steps }).then((r) => (report = r));
  await vi.advanceTimersByTimeAsync(ms);
  expect(report, `app_check returned within ${ms} ms`).toBeDefined();
  expect(page.destroyed, 'its window destroyed').toBe(1);
  return report!;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(page, { frozen: false, freezeOnClick: false, freezeOnResize: false, freezeOnPictures: false, ticking: false, destroyed: 0 });
});
afterEach(() => vi.useRealTimers());

describe('a page that stops answering never holds app_check, and is never ok (review r1, r2)', () => {
  it('frozen by a step\'s click: that step fails saying so, the rest are not run, nothing more is asked of the page', async () => {
    page.freezeOnClick = true;
    // Back in its own few seconds: nothing more asked of a silent page (a snapshot and a picture would be 5 s each).
    const report = await checkWithin(EXTENSION_STEP_WAIT_MS);
    expect(report.steps).toEqual([
      { step: 1, ok: false, error: 'the page stopped answering after it' },
      { step: 2, ok: null, error: 'not run: step 1 failed' },
    ]);
    expect(report.stuck).toBe('quiet');
    expect(report, 'the page\'s failure, never gugu\'s').not.toHaveProperty('host');
    expect(checkResult(report).ok).toBe(false);
  });

  it('frozen before the steps begin (at their resize): app_check returns in its time, the steps said not run', async () => {
    page.freezeOnResize = true;
    const report = await checkWithin(BUDGET_MS);
    expect(report.steps).toEqual([1, 2].map((step) => ({ step, ok: null, error: 'not run: the page stopped answering' })));
    expect(checkResult(report).ok).toBe(false);
  });

  it('frozen from its load: a read that never answers is never called settled — stuck, not ok', async () => {
    page.frozen = true;
    const report = await checkWithin(BUDGET_MS);
    expect(report.stuck).toBe('quiet');
    expect(checkResult(report).ok).toBe(false);
  });

  // Review r3: the loop's last read raced a timer already at 0 — a live page was called silent in 4 of 20 settles.
  it('a page that keeps answering is never called silent: 20 checks of a ticking page, at 20 phases', async () => {
    page.ticking = true;
    const calledSilent: number[] = [];
    for (let phase = 0; phase < 20; phase++) {
      page.destroyed = 0;
      await vi.advanceTimersByTimeAsync(phase * 7);
      const report = await checkWithin(BUDGET_MS);
      if (report.steps?.some((step) => step.ok !== true) || !report.snapshot.includes('- button "Go"')) calledSilent.push(phase);
    }
    expect(calledSilent, 'the phases at which the live page was called silent').toEqual([]);
  });

  it('frozen while its four pictures are taken (no steps): app_check returns in its time, stuck, not ok', async () => {
    page.freezeOnPictures = true;
    const report = await checkWithin(15_000 + 2 * EXTENSION_STEP_WAIT_MS + 4 * EXTENSION_STEP_WAIT_MS, false);
    expect(report.stuck).toBe('quiet');
    expect(report).not.toHaveProperty('host');
    expect(checkResult(report).ok).toBe(false);
  });
});
