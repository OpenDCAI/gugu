// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { extensionViewStore as store, RESIDENT_PAGES_KEPT, residentPageKey, residentPlace, type ExtensionViewClaim } from './extension-view-store';

const used = new Set<string>();
const el = () => document.createElement('div');
const take = (kind: string, target: Omit<ExtensionViewClaim, 'token' | 'element'>) => {
  used.add(kind);
  return store.claim(kind, { ...target, element: el() });
};
const bind = (token: number) => { store.setSurface(token, 100 + token); return token; };
const key = (kind: string, target: Parameters<typeof residentPlace>[0]) => residentPageKey(kind, residentPlace(target));
const pages = (kind: string) => [...store.residentPages.values()].filter((page) => page.kind === kind);
afterEach(() => { for (const kind of used) store.forgetOpened(kind); used.clear(); });

describe('each App navigation context owns its resident pages', () => {
  it('does no work until claimed; an unbound release drops its page and ignores a late bind', () => {
    expect(pages('lazy.main')).toEqual([]);
    const token = take('lazy.main', { sessionId: 's', tabId: 'a' });
    expect(pages('lazy.main')).toHaveLength(1);
    store.release('lazy.main', token);
    expect(pages('lazy.main')).toEqual([]);
    store.setSurface(token, 7);
    expect(store.surfaceFor(token)).toBeNull();
  });

  it('keeps a bound hidden page, but only the same context reuses it', () => {
    const target = { sessionId: 's', tabId: 'a' };
    store.release('page.main', bind(take('page.main', target)));
    const original = pages('page.main')[0];
    const back = take('page.main', target);
    expect(pages('page.main')).toEqual([original]);
    const second = take('page.main', { ...target, tabId: 'b' });
    expect(pages('page.main')).toHaveLength(2);
    expect(store.claims.get(key('page.main', target))?.token).toBe(back);
    expect(store.claims.get(key('page.main', { ...target, tabId: 'b' }))?.token).toBe(second);
  });

  it('a stale release cannot take the newer claim of the same context', () => {
    const target = { sessionId: 's', tabId: 'a' };
    const old = take('claims.main', target);
    const current = take('claims.main', target);
    store.release('claims.main', old);
    expect(store.claims.get(key('claims.main', target))?.token).toBe(current);
    store.release('claims.main', current);
    expect(store.claims.has(key('claims.main', target))).toBe(false);
  });

  it('releasing the top claim restores only the same context’s underlying mount', () => {
    const target = { chatId: 'g', tabId: 'a' };
    const below = take('stack.main', target);
    const top = take('stack.main', target);
    const other = take('stack.main', { ...target, tabId: 'b' });
    store.release('stack.main', top);
    expect(store.claims.get(key('stack.main', target))?.token).toBe(below);
    expect(store.claims.get(key('stack.main', { ...target, tabId: 'b' }))?.token).toBe(other);
  });

  it('keeps a ready host page without a guest webContents, separately from another host context', () => {
    const token = take('host.settings', { tabId: 'a' });
    store.setHostPageReady(token);
    expect(store.surfaceFor(token)).toBeNull();
    store.release('host.settings', token);
    const first = pages('host.settings')[0];
    take('host.settings', { tabId: 'b' });
    expect(pages('host.settings')).toHaveLength(2);
    expect(pages('host.settings')).toContain(first);
  });

  it('a file history page can be reclaimed without sharing another tab’s file or folder', () => {
    const folder = { chatId: 'g', tabId: 'a' };
    const file = { ...folder, itemId: 'f1' };
    const token = bind(take('files.main', file));
    const first = store.residentPages.get(key('files.main', file));
    store.release('files.main', token);
    const back = take('files.main', file);
    take('files.main', folder);
    take('files.main', { ...file, itemId: 'f2' });
    const separate = { ...file, tabId: 'b' };
    take('files.main', separate);
    expect(store.residentPages.get(key('files.main', file))).toBe(first);
    expect(store.claims.get(key('files.main', file))?.token).toBe(back);
    expect(key('files.main', separate)).not.toBe(key('files.main', file));
    expect(pages('files.main')).toHaveLength(4);
  });

  it('closing one slot forgets only its mapping; a hidden slot still has its own presentation key', () => {
    const target = { sessionId: 's', tabId: 'a' };
    const token = bind(take('title.main', target));
    const other = bind(take('title.main', { ...target, tabId: 'b' }));
    store.release('title.main', token);
    expect(store.pageOfSlot('s', 'a')).toBe(key('title.main', target));
    store.forgetSlot('s', 'a');
    expect(store.pageOfSlot('s', 'a')).toBeNull();
    expect(store.surfaceFor(other)).not.toBeNull();
  });

  it('closing a tab drops every page it held, shown or in its history; another tab keeps its own', () => {
    const tab = { sessionId: 's', tabId: 'closing' };
    store.release('close.folder', bind(take('close.folder', tab)));
    const file = bind(take('close.folder', { ...tab, itemId: 'f1' }));
    const kept = bind(take('close.folder', { sessionId: 's', tabId: 'other' }));
    expect(pages('close.folder')).toHaveLength(3);
    store.closeSlot('s', 'closing');
    expect(pages('close.folder').map((page) => page.key)).toEqual([key('close.folder', { sessionId: 's', tabId: 'other' })]);
    expect(store.pageOfSlot('s', 'closing')).toBeNull();
    store.release('close.folder', file);
    expect(pages('close.folder')).toHaveLength(1);
    expect(store.surfaceFor(kept)).not.toBeNull();
  });

  it.each([false, true])('separates task contexts with perSession=%s, and keeps groups and the dock distinct', (perSession) => {
    const a = bind(take('isolated.main', { sessionId: 'a', tabId: 'tab', perSession }));
    const b = bind(take('isolated.main', { sessionId: 'b', tabId: 'tab', perSession }));
    const g = bind(take('isolated.main', { chatId: 'g', tabId: 'tab' }));
    take('isolated.main', { tabId: 'dock' });
    expect(new Set(pages('isolated.main').map((page) => page.place)).size).toBe(4);
    expect(store.surfaceFor(a)).not.toBe(store.surfaceFor(b));
    expect(store.surfaceFor(a)).not.toBe(store.surfaceFor(g));
    expect(store.pageOfSlot('a', 'tab')).not.toBe(store.pageOfSlot('b', 'tab'));
  });

  it('keeps at most the existing idle-page limit while never evicting a shown context', () => {
    const shown = bind(take('idle.main', { chatId: 'shown', tabId: 'page' }));
    for (const id of ['1', '2', '3', '4', '5']) store.release('idle.main', bind(take('idle.main', { chatId: id, tabId: 'page' })));
    expect(pages('idle.main').map((page) => page.place).sort()).toEqual(['chat:3:tab:page', 'chat:4:tab:page', 'chat:5:tab:page', 'chat:shown:tab:page']);
    store.release('idle.main', shown);
    expect(pages('idle.main')).toHaveLength(RESIDENT_PAGES_KEPT);
    store.forgetIdle('idle.main');
    expect(pages('idle.main')).toEqual([]);
  });
});
