import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F103 (L5, S16 rerun, load 60–90): app_install's check read the page at 2 s, found no text and no picture
 * and called it blank — errors [], no card. Seven seconds later, not a line changed, it was ok. "Blank" was a guess, not
 * something the App reported: it is gone. ok is what the page reported (loaded, settled, nothing thrown); what it shows
 * goes back as text for the agent to read. On a fake clock: nothing here waits for real.
 */

type Listener = (...args: unknown[]) => void;
const page = { text: '', paintAt: 0, reportAt: Number.POSITIVE_INFINITY };
let reportError: ((message: string, level: 'error' | 'hint') => void) | null = null;

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false;
    readonly webContents = {
      id: 7,
      setWindowOpenHandler: () => undefined,
      on: (_event: string, _listener: Listener) => undefined,
      once: () => undefined,
      isDestroyed: () => this.destroyed,
      executeJavaScript: async () => {
        if (Date.now() >= page.reportAt) {
          page.reportAt = Number.POSITIVE_INFINITY;
          reportError?.('TypeError: votes is undefined', 'error');
        }
        return Date.now() >= page.paintAt ? page.text : '';
      },
    };
    loadURL = async () => undefined;
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
    };
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined } }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/preload.js' }));
vi.mock('./extension-check-source', () => ({ sourceLine: () => null, staticHints: () => [] }));
vi.mock('./extension-bridge', () => ({
  bindExtensionSurface: () => undefined,
  recentExtensionErrors: () => [],
  checkReadingsOf: () => ({
    writes: 0, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 1, opensSettled: 1, shown: [],
  }),
  reportBlockedNavigation: () => undefined,
  showAgentPageInTheme: () => undefined,
  shownTabWidth: () => null,
  watchExtensionSurfaceErrors: (_id: number, onError: (message: string, level: 'error' | 'hint') => void) => {
    reportError = onError;
    return () => {
      reportError = null;
    };
  },
}));
vi.mock('./extension-programs', () => ({
  extensionPrograms: { installed: () => [], tools: async () => [] },
  programFailureReason: () => '',
  agentToolsOf: () => ({ tools: [], clashes: [] }),
}));
vi.mock('./extension-session', () => ({ configureExtensionSession: () => undefined }));
// Its pictures are app-look-pictures.test.ts's: here the check takes none.
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
    get: () => ({ rootDir: '/bundle', manifest: { id: 'draw-guess', entry: 'main.html', contributes: { tabs: [{ name: 'main', entry: 'main.html' }] } } }),
    grantedHosts: () => [],
  }),
}));

const { checkExtensionSurface } = await import('./extension-check');
const { checkResult } = await import('./extension-agent-actions');

async function check(): Promise<ReturnType<typeof checkResult>> {
  const running = checkExtensionSurface({ extensionId: 'draw-guess', tabName: 'main', chatId: 'chat-1', itemId: 'item-1', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' } });
  await vi.advanceTimersByTimeAsync(20_000);
  return checkResult(await running);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T03:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('the check judges what the page reported, not what it shows (F103)', () => {
  it('a page whose first text comes 3 s in, under load: ok, and what it shows is read back', async () => {
    Object.assign(page, { text: 'Draw! Your turn', paintAt: Date.now() + 3_000, reportAt: Number.POSITIVE_INFINITY });
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('stuck');
    expect(result.snapshot).toBe('- text: "page"');
    expect(result.next).toMatch(/Read snapshot too/);
  });

  it('control: a page that reports an error is not ok, text or no text', async () => {
    Object.assign(page, { text: 'Draw! Your turn', paintAt: Date.now(), reportAt: Date.now() + 100 });
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ kind: 'reportError', level: 'error', message: 'TypeError: votes is undefined' })]);
    expect(result.next).toMatch(/Do not tell the person it is done/);
  });
});
