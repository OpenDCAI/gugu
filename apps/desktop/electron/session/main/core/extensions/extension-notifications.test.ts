import { describe, expect, it, vi } from 'vitest';
import type { AppPlace } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import {
  createExtensionNotifier,
  refusalReason,
  EXTENSION_NOTIFICATIONS_PER_MINUTE,
  type ExtensionNotifierDeps,
} from './extension-notifications';

// Chats are named by their id (编号 18: placeOf refuses anything else).
const C1 = '0c4a7e10-0000-4000-8000-0000000000c1';

/**
 * #6387 Extension banners borrow gugu's one reminder channel: they obey the person's
 * notification settings, always say which extension is talking, and a click brings what the
 * banner names on screen (`open`, 真源原则 13 — never where the page that posted it is) and tells
 * the extension which banner it was.
 */

const manifest = parseExtensionManifest({
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
  entry: 'main.html',
  permissions: { capabilities: ['notifications'] },
  contributes: { tabs: [{ name: 'main', title: 'Main' }, { name: 'inbox', title: 'Inbox' }] },
});

let nextWindow = 1_000_000;

function setup(overrides: Partial<ExtensionNotifierDeps> = {}) {
  const shown: { title: string; body: string; silent: boolean; onClick: () => void; closed: boolean }[] = [];
  const delivered: { event: ExtensionHostEvent; opened: AppPlace | 'own' | null }[] = [];
  // 点击的处理以把点击交给扩展收尾(打开失败也照样交):交出第一条就是点击处理完了。
  const firstDelivery = Promise.withResolvers<void>();
  let now = nextWindow += 120_000;
  const deps: ExtensionNotifierDeps = {
    manifestOf: () => manifest,
    locale: () => 'en-US',
    notificationSettings: async () => ({ enabled: true, sound: true }),
    show: (banner) => {
      const entry = { ...banner, closed: false };
      shown.push(entry);
      return { close: () => { entry.closed = true; }, shown: Promise.resolve() };
    },
    focusApp: vi.fn(),
    open: vi.fn(async () => {}),
    deliver: (_id, event, opened) => {
      delivered.push({ event, opened });
      firstDelivery.resolve();
    },
    onError: vi.fn(),
    now: () => now,
    ...overrides,
  };
  return {
    notifier: createExtensionNotifier(deps),
    deps,
    shown,
    delivered,
    clickHandled: firstDelivery.promise,
    advance: (ms: number) => { now += ms; },
  };
}

describe('extension notifications (#6387)', () => {
  it('shows the banner under the extension\'s installed name', async () => {
    const { notifier, shown } = setup();
    await notifier.notify({ extensionId: 'notes', request: { title: 'Saved', body: '3 notes' } });
    expect(shown[0]).toMatchObject({ title: 'Notes · Saved', body: '3 notes', silent: false });
  });

  it('names the App in the interface language, as its manifest localizes it', async () => {
    const { notifier, shown } = setup({ manifestOf: () => ({ ...manifest, localized: { 'zh-CN': { name: '笔记' } } }), locale: () => 'zh-CN' });
    await notifier.notify({ extensionId: 'notes', request: { title: '已保存' } });
    expect(shown[0]).toMatchObject({ title: '笔记 · 已保存' });
  });

  it('answers only after the system does — a refused banner is not reported as shown', async () => {
    // 实机读数(#6387):开发版没拿到通知权限,系统拒了横幅,notify 却回了 shown。
    const refused = new Error(refusalReason('未能完成操作。（UNErrorDomain错误1。）'));
    const { notifier } = setup({ show: () => ({ close: () => {}, shown: Promise.reject(refused) }) });
    await expect(notifier.notify({ extensionId: 'notes', request: { title: 'Saved', body: 'x' } })).rejects.toThrow(
      /does not allow gugu to show notifications/,
    );
  });

  it('refuses out loud when the person turned notifications off', async () => {
    const { notifier, shown } = setup({ notificationSettings: async () => ({ enabled: false, sound: true }) });
    await expect(notifier.notify({ extensionId: 'notes', request: { title: 'x' } }))
      .rejects.toThrow('system notifications are turned off in gugu settings');
    expect(shown).toHaveLength(0);
  });

  it('keeps App banners silent when sound is off', async () => {
    const { notifier, shown } = setup({ notificationSettings: async () => ({ enabled: true, sound: false }) });
    await notifier.notify({ extensionId: 'notes', request: { title: 'Please review' } });
    expect(shown[0]).toMatchObject({ silent: true });
  });

  it('rejects malformed requests instead of showing half a banner — what a click opens said how', async () => {
    const { notifier } = setup();
    const notify = (request: Record<string, unknown>) => notifier.notify({ extensionId: 'notes', request });
    await expect(notify({})).rejects.toThrow('notify needs a title');
    await expect(notify({ title: 'x'.repeat(121) })).rejects.toThrow(/title is longer/);
    await expect(notify({ title: 'x', data: { big: 'y'.repeat(9000) } })).rejects.toThrow(/data is larger/);
    await expect(notify({ title: 'x', open: { session: 's1', tab: 'nope' } })).rejects.toThrow('this App has no tab named: nope');
    await expect(notify({ title: 'x', open: { session: 's1', chat: C1 } })).rejects.toThrow('open names one place');
    await expect(notify({ title: 'x', open: {} })).rejects.toThrow('open names one place');
    await expect(notify({ title: 'x', open: { chat: C1, tab: 'inbox' } })).rejects.toThrow('tab is for a session');
    await expect(notify({ title: 'x', open: { file: 'a.md' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('stops a page posting in a loop, and lets it post again a minute later', async () => {
    const { notifier, advance } = setup();
    const post = () => notifier.notify({ extensionId: 'notes', request: { title: 'tick' } });
    for (let i = 0; i < EXTENSION_NOTIFICATIONS_PER_MINUTE; i += 1) await post();
    await expect(post()).rejects.toThrow(/too many banners/);
    advance(60_001);
    await expect(post()).resolves.toEqual({ shown: true });
  });

  it('replaces a banner that carries the same tag instead of stacking a second one', async () => {
    const { notifier, shown } = setup();
    await notifier.notify({ extensionId: 'notes', request: { title: '1 new', tag: 'inbox' } });
    await notifier.notify({ extensionId: 'notes', request: { title: '2 new', tag: 'inbox' } });
    expect(shown.map((b) => b.closed)).toEqual([true, false]);
  });

  // Control (the parent commit a770f2e40d): a tab that posted opened itself; the background page's banner opened the tab
  // it named in the session on screen — where the page was, or where the person happened to be, decided.
  it('{ session, tab }: that tab in that session, then the tag and data back to the pages there', async () => {
    const { notifier, shown, deps, delivered, clickHandled } = setup();
    await notifier.notify({ extensionId: 'notes', request: { title: 'Done', tag: 'job', data: { id: 42 }, open: { session: 's1', tab: 'inbox' } } });
    shown[0]!.onClick();
    await clickHandled;
    expect(deps.focusApp).toHaveBeenCalled();
    expect(deps.open).toHaveBeenCalledWith({ session: 's1', tabKind: 'notes.inbox' });
    expect(delivered).toEqual([{ event: { type: 'notificationClicked', tag: 'job', data: { id: 42 } }, opened: { session: 's1' } }]);
  });

  it('{ session } alone opens its first tab; { chat } the App in that chat\'s panel; { file } where it lives', async () => {
    const session = setup();
    await session.notifier.notify({ extensionId: 'notes', request: { title: 'x', open: { session: 's1' } } });
    session.shown[0]!.onClick();
    await session.clickHandled;
    expect(session.deps.open).toHaveBeenCalledWith({ session: 's1', tabKind: 'notes.main' });

    const chat = setup();
    await chat.notifier.notify({ extensionId: 'notes', request: { title: 'x', open: { chat: C1 } } });
    chat.shown[0]!.onClick();
    await chat.clickHandled;
    expect(chat.deps.open).toHaveBeenCalledWith({ chat: C1, extensionId: 'notes' });
    expect(chat.delivered).toEqual([{ event: { type: 'notificationClicked' }, opened: { chat: C1 } }]);

    const file = setup();
    await file.notifier.notify({ extensionId: 'notes', request: { title: 'x', open: { file: { chat: C1, id: 'i1', name: 'a.md' } } } });
    file.shown[0]!.onClick();
    await file.clickHandled;
    expect(file.deps.open).toHaveBeenCalledWith({ file: { chat: C1, id: 'i1' } });
    // The file opens in whatever opens it: only the background page is told.
    expect(file.delivered).toEqual([{ event: { type: 'notificationClicked' }, opened: null }]);
  });

  // 125 (10-06 01:45): one rule for a click naming no place — the App's own page, as a link's.
  it('naming nothing: the App\'s own page opens, and is told', async () => {
    const { notifier, shown, deps, delivered, clickHandled } = setup();
    await notifier.notify({ extensionId: 'notes', request: { title: 'x' } });
    shown[0]!.onClick();
    await clickHandled;
    expect(deps.focusApp).toHaveBeenCalled();
    expect(deps.open).toHaveBeenCalledWith({ own: 'notes' });
    expect(delivered).toEqual([{ event: { type: 'notificationClicked' }, opened: 'own' }]);
  });

  it('still tells the extension about the click when what it names could not be opened', async () => {
    const { notifier, shown, delivered, deps, clickHandled } = setup({ open: vi.fn(async () => { throw new Error('pane gone'); }) });
    await notifier.notify({ extensionId: 'notes', request: { title: 'x', open: { session: 's1' } } });
    shown[0]!.onClick();
    await clickHandled;
    expect(deps.onError).toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
  });
});
