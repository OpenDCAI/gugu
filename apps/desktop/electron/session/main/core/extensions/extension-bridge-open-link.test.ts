import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { openLinkWith } from '@shared/extensions/open-link';
import { parseGuguLink } from '@gugu/core/shared/ui/guguLink';

/**
 * App 页面里人点了一条咕咕自己的链接(linkTo 造的):preload 把它交给宿主(`openLink`),宿主按链接的结构认出它是咕咕的
 * 链接,再走链接从咕咕外面进来时的同一个打开器(openExtensionLink)。别的链接照旧拒;后台页没有这个动词。
 */

const PAGE = 7;
const BACKGROUND = 9;
const REHEARSAL = 11;
const CHAT = '0b000000-0000-4000-8000-000000000016';
const TOPIC = '0b000000-0000-4000-8000-000000000017';
const received: ExtensionHostEvent[] = [];
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: (_channel: string, event: ExtensionHostEvent) => { if (id === PAGE) received.push(event); } });

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
vi.mock('@main/core/extensions/gugu-links', async (original) => ({
  ...(await original<typeof import('./gugu-links')>()),
  currentLinkScheme: () => 'gugu-dev',
  openLink: async (url: string) => { opened.push(url); return parseGuguLink(url) ? outcome : { kind: 'not-gugu-link' }; },
}));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id === TOPIC ? CHAT : id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, deliverToExtension, registerExtensionBridge } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const open = (sender: number, url: unknown) => handle({ sender: { id: sender, session: {} } }, { method: 'openLink', args: { url } });

const LINK = 'gugu-dev://ext/radar/radar?gugu.session=0d000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  opened.length = 0;
  outcome = { kind: 'opened', extensionId: 'chess', tab: 'main' };
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'chess', tabId: 'tab-1', tabKind: 'chess.main', conversation: CHAT });
  received.length = 0;
});

describe('a link of gugu\'s own, clicked in an App page (openLink)', () => {
  it('delivers a topic link to the App already bound in its source chat', async () => {
    const manifest = parseExtensionManifest({
      id: 'chess', name: 'Chess', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      entry: 'main.html', contributes: { tabs: [{ name: 'main', title: 'Main' }] },
    });
    const openApp = vi.fn(async () => ({ chat: CHAT }));
    const event: ExtensionHostEvent = { type: 'link', tab: 'main', path: 'game/7', query: { move: 'e4' }, file: null };
    await expect(openLinkWith({
      installed: () => [{ manifest }], isEnabled: () => true, locale: () => 'en',
      sessionProject: async () => null, agentSession: async () => null, reveal: async () => {}, openApp, deliver: deliverToExtension,
      resourceChat: async (id) => id === TOPIC ? CHAT : id, openResource: async () => {}, bringUp: async () => {},
    }, `gugu-dev://ext/chess/main/game/7?move=e4&gugu.chat=${TOPIC}`))
      .resolves.toMatchObject({ kind: 'opened', target: { kind: 'app', extensionId: 'chess', tab: 'main', place: { chat: CHAT } } });
    expect(received.filter((entry) => entry.type === 'link')).toEqual([event]);
    expect(openApp).toHaveBeenCalledWith('chess', 'main', CHAT);
  });

  it('opens through the one opener, the link as it was', async () => {
    expect(await open(PAGE, LINK)).toEqual({ ok: true, value: undefined });
    expect(opened).toEqual([LINK]);
  });

  it('any other link is refused and nothing is opened: by the link\'s structure, not its prefix', async () => {
    for (const url of ['https://example.com/', 'gugu-dev://chat/123', 'gugu-dev://ext/', 'gugu-dev://ext-x/radar/radar', 42]) {
      const result = await open(PAGE, url) as { ok: boolean; code?: string };
      expect([url, result.ok, result.code]).toEqual([url, false, 'invalid']);
    }
    expect(opened).toEqual(['https://example.com/', 'gugu-dev://chat/123', 'gugu-dev://ext/', 'gugu-dev://ext-x/radar/radar', '']);
  });

  it('accepts all resource kinds through that same opener, independently of channel', async () => {
    for (const url of [`gugu-chat://${CHAT}`, `gugu-file://${CHAT}#slide=3`, `gugu-beta://chat/${CHAT}`, 'gugu://session/s1', 'gugu://project/p1', 'gugu://ext/chess/main']) {
      expect(await open(PAGE, url)).toEqual({ ok: true, value: undefined });
      expect(opened.at(-1)).toBe(url);
    }
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
