import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App 引用 pill, where a pill's place goes (复核 71c15165 要改 1): main holds it for the page about to open the pill's file
 * (`deliverToOpeningPage`) and hands it over when a page binds. It used to be keyed by App and chat only, and handed
 * newest first to whichever page of that chat bound first: clicking pill A then pill B framed A's place on B, or gave both
 * places to A; a page of another file opened within 30 s was framed too. Now: only a page of that file takes it, in the
 * order the places came (the page keeps the last), and a page moved to that file takes it too. Real extension-bridge.
 */

const PAGE_A = 21;
const PAGE_B = 22;
const PAGE_OTHER = 23;
const CHAT = '0b000000-0000-4000-8000-0000000000aa';
const DECK_A = '0c000000-0000-4000-8000-00000000000a';
const DECK_B = '0c000000-0000-4000-8000-00000000000b';
const SHEET = '0c000000-0000-4000-8000-00000000000c';
const sent: { id: number; event: { type?: string; query?: unknown } }[] = [];
const contentsOf = (id: number) => ({
  id,
  isDestroyed: () => false,
  hostWebContents: { id: 42 },
  session: { id },
  once: () => undefined,
  on: () => undefined,
  send: (_channel: string, event: { type?: string; query?: unknown }) => sent.push({ id, event }),
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (id: number) => ([PAGE_A, PAGE_B, PAGE_OTHER].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'office', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true, get: () => ({ manifest: { name: 'Office' } }) }),
}));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, deliverToOpeningPage, deliverToSessionFilePage, retargetExtensionSurface, unbindExtensionSurface } = await import('./extension-bridge');

const place = (slide: number) => ({ type: 'link' as const, tab: 'main', path: '', query: { slide: String(slide) }, file: null });
const bind = (webContentsId: number, itemId: string) =>
  bindExtensionSurface({ webContentsId, extensionId: 'office', tabId: `slot-${webContentsId}`, tabKind: 'office.main', chatId: CHAT, itemId });
/** The places each page was handed, in the order they arrived. */
const placesOf = (id: number) => sent.filter((s) => s.id === id && s.event.type === 'link').map((s) => (s.event.query as { slide: string }).slide);

// Each case starts with what an earlier one left queued already expired (held 30 s): only the clock is faked.
beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }));
beforeEach(() => {
  vi.setSystemTime(Date.now() + 60_000);
  for (const id of [PAGE_A, PAGE_B, PAGE_OTHER]) unbindExtensionSurface(id);
  sent.length = 0;
});

describe('a pill’s place goes to a page of its file, in the order the places came', () => {
  it('control: one pill, its page binds — that page gets the place', async () => {
    deliverToOpeningPage('office', place(3), { chat: CHAT }, DECK_A);
    await bind(PAGE_A, DECK_A);
    expect(placesOf(PAGE_A)).toEqual(['3']);
  });

  it('pill A, then pill B, only B’s page binds: B is handed B’s place alone — A’s never lands on B', async () => {
    deliverToOpeningPage('office', place(3), { chat: CHAT }, DECK_A);
    deliverToOpeningPage('office', place(5), { chat: CHAT }, DECK_B);
    await bind(PAGE_B, DECK_B);
    expect(placesOf(PAGE_B)).toEqual(['5']);
  });

  it('pill A, then pill B, both pages bind: each takes its own', async () => {
    deliverToOpeningPage('office', place(3), { chat: CHAT }, DECK_A);
    deliverToOpeningPage('office', place(5), { chat: CHAT }, DECK_B);
    await bind(PAGE_A, DECK_A);
    await bind(PAGE_B, DECK_B);
    expect(placesOf(PAGE_A)).toEqual(['3']);
    expect(placesOf(PAGE_B)).toEqual(['5']);
  });

  it('the pill’s page never opened; another file of the chat opened within 30 s is not framed', async () => {
    deliverToOpeningPage('office', place(3), { chat: CHAT }, DECK_A);
    await bind(PAGE_OTHER, SHEET);
    expect(placesOf(PAGE_OTHER)).toEqual([]);
  });

  it('two pills of one file before its page binds: both, oldest first — the page keeps the last one clicked', async () => {
    deliverToOpeningPage('office', place(3), { chat: CHAT }, DECK_A);
    deliverToOpeningPage('office', place(7), { chat: CHAT }, DECK_A);
    await bind(PAGE_A, DECK_A);
    expect(placesOf(PAGE_A)).toEqual(['3', '7']);
  });

  it('a page moved to the pill’s file takes its place; moved elsewhere, it does not', async () => {
    await bind(PAGE_OTHER, SHEET);
    deliverToOpeningPage('office', place(4), { chat: CHAT }, DECK_A);
    await retargetExtensionSurface({ webContentsId: PAGE_OTHER, tabId: `slot-${PAGE_OTHER}`, chatId: CHAT, itemId: DECK_B });
    expect(placesOf(PAGE_OTHER)).toEqual([]);
    await retargetExtensionSurface({ webContentsId: PAGE_OTHER, tabId: `slot-${PAGE_OTHER}`, chatId: CHAT, itemId: DECK_A });
    expect(placesOf(PAGE_OTHER)).toEqual(['4']);
  });
});

describe('a link in a session’s chat to a working-copy file with a place: the page of that file takes it, as a pill’s', () => {
  const SESSION = 's-1';
  const office = { extensionId: 'office', tabKind: 'office.main', tabTitle: 'Office', app: { name: 'Office' }, onlyTab: true, suffix: '.pptx' };
  const bindFile = (webContentsId: number, filePath: string) =>
    bindExtensionSurface({ webContentsId, extensionId: 'office', sessionId: SESSION, tabId: `tab-${webContentsId}`, tabKind: 'office.main', filePath });
  const fileOf = (id: number) => sent.filter((s) => s.id === id && s.event.type === 'link').map((s) => (s.event as { file?: string }).file);

  it('the tab is still opening: the page that binds on that file gets the place, the file named by its path', async () => {
    await deliverToSessionFilePage(office, { slide: '3' }, SESSION, 'decks/a.pptx');
    await bindFile(PAGE_A, 'decks/a.pptx');
    expect(placesOf(PAGE_A)).toEqual(['3']);
    expect(fileOf(PAGE_A)).toEqual(['decks/a.pptx']);
  });

  it('the file is open already (a session shows a file in one tab): that page is told now', async () => {
    await bindFile(PAGE_A, 'decks/a.pptx');
    await deliverToSessionFilePage(office, { slide: '6' }, SESSION, 'decks/a.pptx');
    expect(placesOf(PAGE_A)).toEqual(['6']);
  });

  it('a page of another file of the session is not framed; moved to the link’s file, it takes the place', async () => {
    await bindFile(PAGE_OTHER, 'decks/b.pptx');
    await deliverToSessionFilePage(office, { slide: '2' }, SESSION, 'decks/a.pptx');
    expect(placesOf(PAGE_OTHER)).toEqual([]);
    await retargetExtensionSurface({ webContentsId: PAGE_OTHER, sessionId: SESSION, tabId: `tab-${PAGE_OTHER}`, filePath: 'decks/a.pptx' });
    expect(placesOf(PAGE_OTHER)).toEqual(['2']);
  });
});
