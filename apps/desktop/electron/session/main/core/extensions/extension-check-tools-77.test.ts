import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F77 app_check says an App's tools for agents as its programs list them now — and a program that does not
 * start (a tools module with an export that is not a tool) is the App failing, said by the check rather than found by an
 * agent calling it. On a fake clock: nothing here waits for real.
 */

type Program = { extensionId: string; server: string };
type Tool = { name: string; inputSchema: { type: 'object' }; _meta?: { ui: { visibility: string[] } } };
const tool = (name: string, only?: 'app'): Tool => ({ name, inputSchema: { type: 'object' }, ...(only ? { _meta: { ui: { visibility: [only] } } } : {}) });
const programs: { installed: Program[]; tools: Record<string, Tool[] | Error> } = { installed: [], tools: {} };

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false;
    readonly webContents = {
      id: 7,
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      once: () => undefined,
      isDestroyed: () => this.destroyed,
      executeJavaScript: async () => 'Board',
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
    writes: 0, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 0, opensSettled: 0, shown: [],
  }),
  reportBlockedNavigation: () => undefined,
  showAgentPageInTheme: () => undefined,
  shownTabWidth: () => null,
  watchExtensionSurfaceErrors: () => () => undefined,
}));
vi.mock('./extension-programs', async (importOriginal) => ({
  extensionPrograms: {
    installed: () => programs.installed,
    tools: async (program: Program) => {
      const tools = programs.tools[program.server];
      if (tools instanceof Error) throw tools;
      return tools ?? [];
    },
  },
  programFailureReason: (_program: Program, error: unknown) => (error as Error).message,
  // The real rule: `<App id>__<tool>`, page-only tools (`_meta.ui.visibility` ["app"]) left out, clashes named.
  agentToolsOf: (await importOriginal<typeof import('./extension-programs')>()).agentToolsOf,
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
    get: () => ({ rootDir: '/bundle', manifest: { id: 'board', entry: 'main.html', contributes: { tabs: [{ name: 'main', entry: 'main.html' }] } } }),
    grantedHosts: () => [],
  }),
}));

const { checkExtensionSurface } = await import('./extension-check');
const { checkResult } = await import('./extension-agent-actions');

async function check(): Promise<ReturnType<typeof checkResult>> {
  const running = checkExtensionSurface({ extensionId: 'board', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' } });
  await vi.advanceTimersByTimeAsync(20_000);
  return checkResult(await running);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T08:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('app_check lists the tools an App gives agents (F77)', () => {
  it('its programs’ tools for agents, not its page-only ones nor another App’s', async () => {
    programs.installed = [{ extensionId: 'board', server: 'board' }, { extensionId: 'other', server: 'other' }];
    programs.tools = { board: [tool('follow'), tool('panel', 'app')], other: [tool('theirs')] };
    const result = await check();
    expect(result.ok).toBe(true);
    // L11 R8: the names agents call, as the catalog gives them — not the bare `follow` an author then tells the group.
    expect(result.tools).toEqual(['board__follow']);
    expect(result.next).toMatch(/Its tools for agents: board__follow\./);
  });

  it('a program that does not start fails the check, with what stopped it', async () => {
    programs.installed = [{ extensionId: 'board', server: 'board' }];
    programs.tools = { board: new Error('tools.js: helper is not a tool (no run)') };
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ kind: 'program', level: 'error', message: 'program board: tools.js: helper is not a tool (no run)' }),
    ]);
  });

  // 摩擦单 F119: every tool is `<App id>__<tool>`, so two programs of one App giving one name is the App failing, said here.
  it('two programs giving the same tool fail the check, naming both', async () => {
    programs.installed = [{ extensionId: 'board', server: 'board' }, { extensionId: 'board', server: 'more' }];
    programs.tools = { board: [tool('follow')], more: [tool('follow'), tool('count')] };
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.tools).toEqual(['board__count']);
    expect(result.errors).toEqual([
      expect.objectContaining({ kind: 'program', level: 'error', message: 'board__follow is given by programs board and more of one App — rename one' }),
    ]);
  });

  it('control: an App with no programs has no tools field', async () => {
    programs.installed = [];
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('tools');
  });
});
