import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckReadings } from '@shared/extensions/bridge-protocol';
import { EXTENSION_CHECK_PAGE_IDLE_MS, type ExtensionCheckRequest } from '@shared/extensions/extension-check';

/**
 * `app_check { page }` (owner 10-13: 「连续地操作一个页面…而不是每次从头执行」): a check's page is kept for the session
 * that opened it, and a later check of that session goes on with it where it was left — no new window, no second load.
 * Each call says only what the page said and did since the one before. It closes when left unused, when its session
 * holds too many, when its session ends or its App is removed, and when it is loaded again under it; another session's
 * page is not found, exactly as a closed one. Where it opens decides its size (a group's panel, the session's tab as wide
 * as it is shown, a phone). The page is a stand-in with one button; the steps are the real ones.
 */

type Listener = (...args: unknown[]) => void;
const windows: { id: number; destroyed: boolean; loads: number; size: { width: number }; listeners: Map<string, Listener[]> }[] = [];
const binds: Record<string, unknown>[] = [];
const watchers = new Map<number, (message: string, level: 'error' | 'hint') => void>();
const readings = new Map<number, CheckReadings>();
const shown = { width: null as number | null };
const pictured: string[][] = [];
const TREE = { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 }] };
const counts = (writes: number): CheckReadings => ({ writes, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 1, opensSettled: 1, shown: [] });

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly record;
    readonly webContents;
    constructor(options: { width: number }) {
      const id = 100 + windows.length;
      const listeners = new Map<string, Listener[]>();
      this.record = { id, destroyed: false, loads: 0, size: { width: options.width }, listeners };
      windows.push(this.record);
      const record = this.record;
      const on = (event: string, listener: Listener) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      this.webContents = {
        id,
        setWindowOpenHandler: () => undefined,
        on,
        once: on,
        isDestroyed: () => record.destroyed,
        executeJavaScript: async () => 'Board',
        debugger: {
          isAttached: () => true,
          attach: () => undefined,
          sendCommand: async (method: string) => {
            if (method === 'Accessibility.getFullAXTree') return TREE;
            if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 40, 0, 40, 20, 0, 20] } };
            return {};
          },
        },
      };
    }
    loadURL = async () => {
      this.record.loads += 1;
      for (const listener of this.record.listeners.get('did-finish-load') ?? []) listener();
    };
    isDestroyed = () => this.record.destroyed;
    destroy = () => {
      this.record.destroyed = true;
      for (const listener of this.record.listeners.get('destroyed') ?? []) listener();
    };
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined } }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/preload.js' }));
vi.mock('./extension-check-source', () => ({ sourceLine: () => null, staticHints: () => [] }));
vi.mock('./extension-bridge', () => ({
  bindExtensionSurface: async (input: Record<string, unknown>) => void binds.push(input),
  recentExtensionErrors: () => [],
  checkReadingsOf: (id: number) => readings.get(id) ?? null,
  reportBlockedNavigation: () => undefined,
  showAgentPageInTheme: () => undefined,
  shownTabWidth: () => shown.width,
  watchExtensionSurfaceErrors: (id: number, onError: (message: string, level: 'error' | 'hint') => void) => {
    watchers.set(id, onError);
    return () => watchers.delete(id);
  },
}));
vi.mock('./extension-programs', () => ({
  extensionPrograms: { installed: () => [], tools: async () => [] },
  programFailureReason: () => '',
  agentToolsOf: () => ({ tools: [], clashes: [] }),
}));
vi.mock('./extension-session', () => ({ configureExtensionSession: () => undefined }));
// Each session in a project of its own name.
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async (sessionId: string) => ({ projectId: `project-of-${sessionId}` }) }));
vi.mock('./extension-look-picture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extension-look-picture')>()),
  keepPainting: async () => undefined,
  endPictures: () => undefined,
  showAtSize: async () => undefined,
  pictureOf: async (_contents: unknown, _size: unknown, label: string) => ({ label, mimeType: 'image/jpeg', data: 'AAAA' }),
  picturesOf: async (_contents: unknown, sizes: { says: string }[]) => {
    pictured.push(sizes.map((size) => size.says));
    return [];
  },
}));
vi.mock('./extension-webview-security', () => ({ isAllowedExtensionNavigation: () => true }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    get: (id: string) => ({ rootDir: '/bundle', manifest: { id, entry: 'main.html', contributes: { tabs: [{ name: 'main', entry: 'main.html' }] } } }),
    grantedHosts: () => [],
  }),
}));

const { checkExtensionSurface, closeCheckPages } = await import('./extension-check');

/** One app_check, on the fake clock: its answer, or what it threw. */
async function check(request: Partial<ExtensionCheckRequest> = {}) {
  let outcome: { report?: Awaited<ReturnType<typeof checkExtensionSurface>>; error?: Error } | undefined;
  checkExtensionSurface({ extensionId: 'board', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' }, ...request }).then(
    (report) => (outcome = { report }),
    (error: Error) => (outcome = { error })
  );
  await vi.advanceTimersByTimeAsync(20_000);
  if (!outcome) throw new Error('the check did not return');
  if (outcome.error) throw outcome.error;
  return outcome.report!;
}
const GO = [{ click: { role: 'button', name: 'Go' } }];
const notFound = (id: string) => `app_check: page "${id}" is not found.`;

beforeEach(() => {
  vi.useFakeTimers();
  closeCheckPages({ extensionId: 'board' });
  closeCheckPages({ extensionId: 'chess' });
  windows.length = 0;
  binds.length = 0;
  pictured.length = 0;
  readings.clear();
  shown.width = null;
});
afterEach(() => vi.useRealTimers());

describe('a check\'s page is kept for its session to go on with (owner 10-13)', () => {
  it('kept and gone on with where it was left: the same window, loaded and bound once; the answer names it each time', async () => {
    const first = await check({ caller: 's1' });
    expect(first.page).toMatch(/^p-[0-9a-f]{6}$/);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.destroyed).toBe(false);
    const next = await check({ caller: 's1', page: first.page!, steps: GO });
    expect(next.steps).toEqual([{ step: 1, ok: true, did: 'clicked button "Go"' }]);
    expect(next.page).toBe(first.page);
    expect(next.pictures?.map(({ label }) => label)).toEqual(['the end, after the steps, 952 wide (a tab on the task page)']);
    const look = await check({ caller: 's1', page: first.page! });
    expect(look.pictures?.map(({ label }) => label)).toEqual(['as it is now, 952 wide (a tab on the task page)']);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.loads).toBe(1);
    expect(binds).toHaveLength(1);
  });

  it('each call says only what the page said and did since the one before', async () => {
    readings.set(100, counts(3));
    const first = await check({ caller: 's1' });
    expect(first.readings?.writes).toBe(3);
    // Said while no check ran (between the two): the next one's.
    watchers.get(100)!('between the checks', 'error');
    readings.set(100, counts(5));
    const next = await check({ caller: 's1', page: first.page!, steps: GO });
    expect(first.errors).toEqual([]);
    expect(next.errors).toEqual([{ kind: 'reportError', level: 'error', message: 'between the checks' }]);
    expect(next.readings?.writes).toBe(2);
    expect((await check({ caller: 's1', page: first.page! })).errors).toEqual([]);
    readings.set(100, counts(5));
    expect((await check({ caller: 's1', page: first.page!, steps: GO })).readings).toBeUndefined();
  });

  it('another session\'s page is not found, word for word as an unknown or a closed one; another tab\'s says whose it is', async () => {
    const { page } = await check({ caller: 's1' });
    await expect(check({ caller: 's2', page: page! })).rejects.toThrow(notFound(page!));
    await expect(check({ page: page! })).rejects.toThrow(notFound(page!));
    await expect(check({ caller: 's1', page: 'p-000000' })).rejects.toThrow(notFound('p-000000'));
    await expect(check({ caller: 's1', page: page!, extensionId: 'chess' })).rejects.toThrow(`app_check: page "${page}" is a page of board.main`);
    expect(windows[0]!.destroyed).toBe(false);
  });

  it(`closes ${EXTENSION_CHECK_PAGE_IDLE_MS / 60_000} min after its last check, and is not found after`, async () => {
    const { page } = await check({ caller: 's1' });
    await vi.advanceTimersByTimeAsync(EXTENSION_CHECK_PAGE_IDLE_MS - 30_000);
    await check({ caller: 's1', page: page!, steps: GO });
    await vi.advanceTimersByTimeAsync(EXTENSION_CHECK_PAGE_IDLE_MS - 30_000);
    expect(windows[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(windows[0]!.destroyed).toBe(true);
    await expect(check({ caller: 's1', page: page! })).rejects.toThrow(notFound(page!));
  });

  it('a session holds three: a fourth closes its least recently used; another session\'s are its own', async () => {
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push((await check({ caller: 's1' })).page!);
    const theirs = (await check({ caller: 's2' })).page!;
    await check({ caller: 's1', page: pages[0]!, steps: GO });
    const fourth = (await check({ caller: 's1' })).page!;
    expect(windows.map(({ destroyed }) => destroyed)).toEqual([false, true, false, false, false]);
    await expect(check({ caller: 's1', page: pages[1]! })).rejects.toThrow(notFound(pages[1]!));
    for (const page of [pages[0]!, pages[2]!, fourth]) expect((await check({ caller: 's1', page })).page).toBe(page);
    expect((await check({ caller: 's2', page: theirs })).page).toBe(theirs);
  });

  it('goes with its session, and with its App; loaded again under it (installed again, switched off), it is closed', async () => {
    const mine = (await check({ caller: 's1' })).page!;
    const other = (await check({ caller: 's2' })).page!;
    closeCheckPages({ sessionId: 's1' });
    expect(windows.map(({ destroyed }) => destroyed)).toEqual([true, false]);
    await expect(check({ caller: 's1', page: mine })).rejects.toThrow(notFound(mine));
    closeCheckPages({ extensionId: 'board' });
    expect(windows[1]!.destroyed).toBe(true);
    await expect(check({ caller: 's2', page: other })).rejects.toThrow(notFound(other));
    const reloaded = (await check({ caller: 's1' })).page!;
    for (const listener of windows[2]!.listeners.get('did-finish-load') ?? []) listener();
    expect(windows[2]!.destroyed).toBe(true);
    await expect(check({ caller: 's1', page: reloaded })).rejects.toThrow(notFound(reloaded));
  });

  // Review 9107b50e04: a page gone on with is its session's least recently used until its check ends — and a fourth one
  // opened meanwhile (an agent's calls in parallel) closed it under that check, which answered loaded with nothing done.
  it('a page in a check is never the one crowded out: the next least recently used goes; past its check, the limit holds again', async () => {
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push((await check({ caller: 's1' })).page!);
    let going: Awaited<ReturnType<typeof checkExtensionSurface>> | undefined;
    void checkExtensionSurface({ extensionId: 'board', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' }, caller: 's1', page: pages[0]!, steps: GO }).then((report) => (going = report));
    const fourth = await check({ caller: 's1' });
    expect(windows.map(({ destroyed }) => destroyed)).toEqual([false, true, false, false]);
    expect(going).toMatchObject({ loaded: true, page: pages[0], steps: [{ step: 1, ok: true }] });
    // All three in checks at once, and a fourth: opened over the limit, trimmed as soon as one of them is done — never the
    // page an answer has just named, which is there when that answer comes back.
    const answered = (request: Partial<ExtensionCheckRequest>, window: number) =>
      checkExtensionSurface({ extensionId: 'board', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' }, caller: 's1', ...request }).then((report) => ({
        loaded: report.loaded,
        openWhenAnswered: report.page !== undefined && !windows[window]!.destroyed,
      }));
    const all = [answered({ page: pages[0]!, steps: GO }, 0), answered({ page: pages[2]!, steps: GO }, 2), answered({ page: fourth.page!, steps: GO }, 3), answered({}, 4)];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await Promise.all(all)).toEqual(Array(4).fill({ loaded: true, openWhenAnswered: true }));
    expect(windows.filter(({ destroyed }) => !destroyed)).toHaveLength(3);
  });

  it('closed while a check of it runs — its session ended — that check says so, never loaded', async () => {
    const { page } = await check({ caller: 's1' });
    let answer: Awaited<ReturnType<typeof checkExtensionSurface>> | undefined;
    void checkExtensionSurface({ extensionId: 'board', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' }, caller: 's1', page: page!, steps: GO }).then((report) => (answer = report));
    await vi.advanceTimersByTimeAsync(100);
    closeCheckPages({ sessionId: 's1' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(answer).toMatchObject({ loaded: false, loadError: 'the page was closed (its session ended) while this check ran' });
    expect(answer?.page).toBeUndefined();
  });

  it('goes with its session\'s project, which is deleted without a word for each of its sessions', async () => {
    const mine = (await check({ caller: 's1' })).page!;
    await check({ caller: 's2' });
    closeCheckPages({ projectId: 'project-of-s1' });
    expect(windows.map(({ destroyed }) => destroyed)).toEqual([true, false]);
    await expect(check({ caller: 's1', page: mine })).rejects.toThrow(notFound(mine));
  });

  it('the machine holds nine (~1 GB): a tenth closes the machine\'s least recently used, whichever session\'s', async () => {
    for (const session of ['s1', 's2', 's3']) for (let i = 0; i < 3; i++) await check({ caller: session });
    expect(windows.filter(({ destroyed }) => !destroyed)).toHaveLength(9);
    await check({ caller: 's4' });
    expect(windows.map(({ destroyed }) => destroyed)).toEqual([true, ...Array<boolean>(9).fill(false)]);
  });

  it('a caller in no session keeps nothing: the page is closed after its check, and the answer names none', async () => {
    const report = await check();
    expect(report.page).toBeUndefined();
    expect(windows[0]!.destroyed).toBe(true);
  });
});

describe('where it opens decides its size (owner 10-13)', () => {
  it('a group\'s panel 520; its tab in the session as wide as it is shown, else 952; a phone 412; pictures add the phone where the App goes to chats', async () => {
    await check({ chatId: 'chat-1' });
    shown.width = 700;
    await check({ sessionId: 's1' });
    shown.width = null;
    await check({ sessionId: 's1' });
    const phone = await check({ chatId: 'chat-1', phone: true, steps: GO });
    expect(windows.map(({ size }) => size.width)).toEqual([520, 700, 952, 412]);
    expect(pictured).toEqual([
      ['520 wide (a group\'s side panel)', '412 wide (a phone, touch)'],
      ['700 wide (its tab on the task page, as wide as it is shown now)', '412 wide (a phone, touch)'],
      ['952 wide (a tab on the task page)', '412 wide (a phone, touch)'],
    ]);
    expect(phone.pictures?.map(({ label }) => label)).toEqual(['the end, after the steps, 412 wide (a phone, touch)']);
    expect(binds.slice(1, 3)).toEqual([expect.objectContaining({ sessionId: 's1' }), expect.objectContaining({ sessionId: 's1' })]);
  });
});
