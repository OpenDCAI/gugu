import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App 页面里人点了一条咕咕自己的链接(linkTo 造的):preload 把它交给宿主(`openLink`),宿主按链接的结构认出它是咕咕的
 * 链接,再走链接从咕咕外面进来时的同一个打开器(openExtensionLink)。别的链接照旧拒;后台页没有这个动词。
 */

const PAGE = 7;
const BACKGROUND = 9;
const REHEARSAL = 11;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => (id === PAGE || id === BACKGROUND || id === REHEARSAL ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'chess',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => BACKGROUND }));
const granted = new Set<string>();
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => [...granted],
    hasCapability: (_id: string, wanted: string) => granted.has(wanted),
    get: () => ({ manifest: { name: 'Chess' } }),
  }),
}));
const opened: string[] = [];
let outcome: Record<string, unknown> = { kind: 'opened', extensionId: 'chess', tab: 'main' };
vi.mock('@main/core/extensions/extension-links', async (original) => ({
  ...(await original<typeof import('./extension-links')>()),
  currentLinkScheme: () => 'gugu-dev',
  openExtensionLink: async (url: string) => { opened.push(url); return outcome; },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const open = (sender: number, url: unknown) => handle({ sender: { id: sender, session: {} } }, { method: 'openLink', args: { url } });

const LINK = 'gugu-dev://ext/radar/radar?gugu.session=0d000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  opened.length = 0;
  outcome = { kind: 'opened', extensionId: 'chess', tab: 'main' };
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'chess', tabId: 'tab-1', tabKind: 'chess.main', chatId: '0b000000-0000-4000-8000-000000000016' });
});

describe('a link of gugu\'s own, clicked in an App page (openLink)', () => {
  it('opens through the one opener, the link as it was', async () => {
    expect(await open(PAGE, LINK)).toEqual({ ok: true, value: undefined });
    expect(opened).toEqual([LINK]);
  });

  it('any other link is refused and nothing is opened: by the link\'s structure, not its prefix', async () => {
    for (const url of ['https://example.com/', 'gugu-dev://chat/123', 'gugu://ext/radar/radar', 'gugu-dev://ext/', 'gugu-dev://ext-x/radar/radar', 42]) {
      const result = await open(PAGE, url) as { ok: boolean; code?: string };
      expect([url, result.ok, result.code]).toEqual([url, false, 'invalid']);
    }
    expect(opened).toEqual([]);
  });

  it('when the opener cannot open it, the page hears why', async () => {
    outcome = { kind: 'failed', reason: 'no-session', name: 'Radar' };
    expect(await open(PAGE, LINK)).toEqual({ ok: false, code: 'failed', message: 'That link did not open: no-session' });
  });

  it('a background page has no link to click: refused at the door', async () => {
    const result = await open(BACKGROUND, LINK) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(opened).toEqual([]);
  });
});
