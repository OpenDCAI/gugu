import { describe, expect, it, vi } from 'vitest';

/**
 * A page keeps the file tree of a working copy it listed until it goes away (`stopPageWatches`). A page that goes away
 * while it is still listing must not leave that tree held for good: the listing lets go when it comes back.
 */
const PAGE = 7;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: null, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  clipboard: { writeText: vi.fn() },
  shell: {},
  webContents: { fromId: (id: number) => (id === PAGE ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'board', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => ['files:read'],
    hasCapability: () => true,
    get: () => ({ manifest: { name: 'Board', contributes: { tabs: [] } } }),
  }),
  extensionDataRoot: () => '/data/board',
}));
vi.mock('@main/core/extensions/extension-data', () => ({ writeExtensionData: vi.fn(), readExtensionData: vi.fn(), listExtensionData: vi.fn() }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: { callFromPage: vi.fn() }, onExtensionProgramNotification: () => () => undefined }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => new Map() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

let finishListing: (entries: unknown[]) => void = () => undefined;
const listAppFiles = vi.fn(() => new Promise<unknown[]>((resolve) => { finishListing = resolve; }));
vi.mock('@main/core/extensions/app-files', () => ({ listAppFiles, resourceChatOf: async (id: string) => id }));
const releaseWorkingCopies = vi.fn();
vi.mock('@main/core/extensions/working-copy-files', () => ({ releaseWorkingCopies }));

const { bindExtensionSurface, registerExtensionBridge, stopPageWatches } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const list = () => handle({ sender: { id: PAGE, session: {} } }, { method: 'filesList', args: { place: { workspace: { project: 'p' } } } }) as Promise<{ ok: boolean }>;

describe('a page listing a working copy', () => {
  it('still open when its listing comes back: it keeps the tree', async () => {
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'board', tabId: 'slot', tabKind: 'board.main', conversation: '0b000000-0000-4000-8000-000000000069' });
    releaseWorkingCopies.mockClear();
    const answer = list();
    await vi.waitFor(() => expect(listAppFiles).toHaveBeenCalledTimes(1));
    finishListing([]);
    expect((await answer).ok).toBe(true);
    expect(releaseWorkingCopies).not.toHaveBeenCalled();
    stopPageWatches(PAGE);
    await vi.waitFor(() => expect(releaseWorkingCopies).toHaveBeenCalledTimes(1));
  });

  it('gone before its listing comes back: the listing lets the tree go', async () => {
    releaseWorkingCopies.mockClear();
    listAppFiles.mockClear();
    const answer = list();
    await vi.waitFor(() => expect(listAppFiles).toHaveBeenCalledTimes(1));
    stopPageWatches(PAGE);
    await vi.waitFor(() => expect(releaseWorkingCopies).toHaveBeenCalledTimes(1));
    finishListing([]);
    await answer;
    expect(releaseWorkingCopies).toHaveBeenCalledTimes(2);
    expect(releaseWorkingCopies).toHaveBeenLastCalledWith(PAGE);
  });
});
