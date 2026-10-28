// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extensionViewStore, RESIDENT_PAGES_KEPT, residentPageKey, residentPlace } from './extension-view-store';

/**
 * 常驻页的落点登记:页住在根层,格只是它此刻落在哪里。判的是登记本身不会把页弄丢或弄错 ——
 * 页跟着它那个地方最新的认领方走,过期的释放不许误伤后来者;群里的页一生只属于那个群(摩擦单 F48),
 * 群以外只有一张(#7052)。
 */
const el = () => document.createElement('div');
/** 群以外(会话里、App 的整页)只有一张(#7052):它此刻的认领方。 */
const inSession = (kind: string, _sessionId: string) => extensionViewStore.claims.get(residentPageKey(kind, residentPlace({})));
const inChat = (kind: string, chatId: string) => extensionViewStore.claims.get(residentPageKey(kind, residentPlace({ chatId })));
const pagesOf = (kind: string) => [...extensionViewStore.residentPages.values()].filter((page) => page.kind === kind);
/** The layer bound the page drawing this claim (it says so once `bindSurface` answers). */
const bound = (token: number) => {
  extensionViewStore.setSurface(token, 100 + token);
  return token;
};

describe('常驻页的落点登记', () => {
  it('keeps a host page alive when moving away, without inventing a guest webContents', () => {
    const kind = 'tool-app.settings';
    const token = extensionViewStore.claim(kind, { tabId: 'host-page', element: el() });
    extensionViewStore.setHostPageReady(token);
    expect(extensionViewStore.surfaceFor(token)).toBeNull();
    const first = pagesOf(kind)[0];
    extensionViewStore.release(kind, token);
    expect(pagesOf(kind)).toEqual([first]);
    extensionViewStore.claim(kind, { sessionId: 'next', tabId: 'next-slot', element: el() });
    expect(pagesOf(kind)).toEqual([first]);
    extensionViewStore.forgetOpened(kind);
  });
  it('认领后查得到,释放后查不到', () => {
    const token = extensionViewStore.claim('ext.a', { sessionId: 't1', tabId: 'tab1', element: el() });
    expect(inSession('ext.a', 't1')?.sessionId).toBe('t1');
    extensionViewStore.release('ext.a', token);
    expect(inSession('ext.a', 't1')).toBeUndefined();
  });

  it('同一个任务里换一格(分屏同类两格):页指向新格;旧格晚到的释放不会把新格顶掉', () => {
    const old = extensionViewStore.claim('ext.b', { sessionId: 't1', tabId: 'tab1', element: el() });
    extensionViewStore.claim('ext.b', { sessionId: 't1', tabId: 'tab2', element: el() });
    expect(inSession('ext.b', 't1')?.tabId).toBe('tab2');
    // React 里旧格的卸载效应可能在新格挂上之后才跑 —— 它只能释放自己那一次认领。
    extensionViewStore.release('ext.b', old);
    expect(inSession('ext.b', 't1')?.tabId).toBe('tab2');
  });

  it('认领是栈:后来的一格释放后,页还给同一个地方还挂着的前一格', () => {
    const below = extensionViewStore.claim('ext.g', { chatId: 'chat-g', tabId: 'panel-1', element: el() });
    const top = extensionViewStore.claim('ext.g', { chatId: 'chat-g', tabId: 'panel-2', element: el() });
    expect(inChat('ext.g', 'chat-g')?.token).toBe(top);
    extensionViewStore.release('ext.g', top);
    expect(inChat('ext.g', 'chat-g')?.token).toBe(below);
    // 对照:最后一格也释放了,页才真的没有落点。
    extensionViewStore.release('ext.g', below);
    expect(inChat('ext.g', 'chat-g')).toBeUndefined();
  });

  it('页有人要才建:没认领过就没有页;认领过就留着,关掉扩展才忘(摩擦单 F3)', () => {
    expect(pagesOf('ext.lazy')).toHaveLength(0);
    const token = bound(extensionViewStore.claim('ext.lazy', { sessionId: 'tl', tabId: 'entry', element: el() }));
    expect(pagesOf('ext.lazy')).toHaveLength(1);
    extensionViewStore.release('ext.lazy', token);
    // 对照:释放了页还在(藏起来活着),只有扩展关掉 / 卸载才忘。
    expect(pagesOf('ext.lazy')).toHaveLength(1);
    extensionViewStore.forgetOpened('ext.lazy');
    expect(pagesOf('ext.lazy')).toHaveLength(0);
  });

  it('keeps each file’s own page across release and reclaim, separate from the folder and other files', () => {
    const shared = extensionViewStore.claim('ext.vote', { tabId: 'panel', chatId: 'chat-1', element: el() });
    const target = { tabId: 'file-tab', chatId: 'chat-1', itemId: 'item-1', element: el() };
    const first = bound(extensionViewStore.claim('ext.vote', target));
    const second = bound(extensionViewStore.claim('ext.vote', { ...target, itemId: 'item-2' }));
    const key = residentPageKey('ext.vote', residentPlace(target));
    const page = extensionViewStore.residentPages.get(key);
    expect(page?.itemId).toBe('item-1');
    expect(inChat('ext.vote', 'chat-1')?.token).toBe(shared);
    expect(inChat('ext.vote', 'chat-1')?.itemId).toBeUndefined();
    extensionViewStore.release('ext.vote', first);
    expect(extensionViewStore.residentPages.get(key)).toBe(page);
    const again = extensionViewStore.claim('ext.vote', { ...target, tabId: 'reopened-tab' });
    expect(extensionViewStore.residentPages.get(key)).toBe(page);
    expect(extensionViewStore.claims.get(key)?.token).toBe(again);
    // A late release of the previous slot cannot remove the new claim.
    extensionViewStore.release('ext.vote', first);
    expect(extensionViewStore.claims.get(key)?.token).toBe(again);
    expect(pagesOf('ext.vote')).toHaveLength(3);
    expect(residentPlace({ ...target, chatId: 'chat-2' })).not.toBe(residentPlace(target));
    extensionViewStore.release('ext.vote', again);
    extensionViewStore.release('ext.vote', second);
    extensionViewStore.release('ext.vote', shared);
    extensionViewStore.forgetOpened('ext.vote');
    expect(pagesOf('ext.vote')).toHaveLength(0);
  });

  it('applies the existing idle-page limit to ten different files and drops an unbound file page', () => {
    const kind = 'many-files.main';
    const target = { tabId: 'file', chatId: 'chat', element: el() };
    const unbound = extensionViewStore.claim(kind, { ...target, itemId: 'never-ready' });
    extensionViewStore.release(kind, unbound);
    expect(pagesOf(kind)).toHaveLength(0);
    const shown = bound(extensionViewStore.claim(kind, { ...target, itemId: 'shown' }));
    for (let index = 0; index < 10; index++) {
      extensionViewStore.release(kind, bound(extensionViewStore.claim(kind, { ...target, itemId: `file-${index}` })));
    }
    expect(pagesOf(kind).map((page) => page.itemId).sort()).toEqual(['file-7', 'file-8', 'file-9', 'shown']);
    extensionViewStore.release(kind, shown);
    expect(pagesOf(kind).map((page) => page.itemId).sort()).toEqual(['file-7', 'file-8', 'file-9']);
    extensionViewStore.forgetIdle(kind);
    expect(pagesOf(kind)).toHaveLength(0);
  });

  it('落点登记不随认领释放而清:格切到后台时页说的话仍记到它名下,关掉那一格才忘', () => {
    const token = extensionViewStore.claim('ext.f', { sessionId: 't1', tabId: 'tab1', element: el() });
    extensionViewStore.release('ext.f', token);
    expect(extensionViewStore.pageOfSlot('t1', 'tab1')).toBe(residentPageKey('ext.f', 'app'));
    extensionViewStore.forgetSlot('t1', 'tab1');
    expect(extensionViewStore.pageOfSlot('t1', 'tab1')).toBeNull();
  });
});

describe('群里的页一生只属于那个群(摩擦单 F48);群以外只有一张(#7052)', () => {
  it('群 X 开过工作区,再去群 Y:Y 是另一张页;每张页的认领方从来只是它自己的群;回到 X 还是 X 那张', () => {
    const inX = bound(extensionViewStore.claim('ws.main', { tabId: 'panel', chatId: 'chat-x', element: el() }));
    extensionViewStore.release('ws.main', inX);
    const inY = bound(extensionViewStore.claim('ws.main', { tabId: 'panel', chatId: 'chat-y', element: el() }));
    // Control (before F48): one page for the App, its claim moved to chat-y — the page's chatId changed under it.
    expect(pagesOf('ws.main').map((page) => page.place).sort()).toEqual(['chat:chat-x', 'chat:chat-y']);
    expect(inChat('ws.main', 'chat-y')?.chatId).toBe('chat-y');
    expect(inChat('ws.main', 'chat-x')).toBeUndefined(); // X's page is alive, hidden, still X's
    extensionViewStore.release('ws.main', inY);
    const backInX = extensionViewStore.claim('ws.main', { tabId: 'panel', chatId: 'chat-x', element: el() });
    expect(inChat('ws.main', 'chat-x')?.token).toBe(backInX);
    expect(pagesOf('ws.main')).toHaveLength(2); // the same two pages: X's was kept, not rebuilt
    extensionViewStore.release('ws.main', backInX);
  });

  // #7052 一个 App 只有一份、放在哪就在哪:群以外只有一张页,挪到另一条会话(或它的整页)是这同一张跟过去,不重建。
  it('群以外只有一张:从一条会话挪到另一条、挪去它的整页,都是同一张页', () => {
    const t1 = bound(extensionViewStore.claim('task.app', { sessionId: 't1', tabId: 'tab', element: el() }));
    extensionViewStore.release('task.app', t1);
    const t2 = extensionViewStore.claim('task.app', { sessionId: 't2', tabId: 'tab', element: el() });
    expect(inSession('task.app', 't2')).toMatchObject({ token: t2, sessionId: 't2' });
    expect(pagesOf('task.app').map((page) => page.place)).toEqual(['app']);
    extensionViewStore.release('task.app', t2);
    const page = extensionViewStore.claim('task.app', { tabId: 'dock', element: el() });
    expect(pagesOf('task.app')).toHaveLength(1);
    extensionViewStore.release('task.app', page);
  });

  it(`没人看的页每个 App 最多留 ${RESIDENT_PAGES_KEPT} 张,多了销毁最久没用的;正被看着的从不销毁`, () => {
    const shown = bound(extensionViewStore.claim('many.main', { tabId: 'panel-a', chatId: 'chat-shown', element: el() }));
    const visited = ['c1', 'c2', 'c3', 'c4', 'c5'];
    for (const chatId of visited) {
      extensionViewStore.release('many.main', bound(extensionViewStore.claim('many.main', { tabId: 'panel', chatId, element: el() })));
    }
    const places = pagesOf('many.main').map((page) => page.place);
    // The newest three idle ones and the one on screen.
    expect(places.sort()).toEqual(['chat:c3', 'chat:c4', 'chat:c5', 'chat:chat-shown']);
    extensionViewStore.release('many.main', shown);
    // chat-shown was claimed first: once nobody shows it, it is the oldest idle page, and goes.
    expect(pagesOf('many.main').map((page) => page.place).sort()).toEqual(['chat:c3', 'chat:c4', 'chat:c5']);
  });

  it('#7317 a tab declared one per task: each task its own page, kept for that task; undeclared, still the one page', () => {
    const a = bound(extensionViewStore.claim('cu.screen', { sessionId: 'task-a', perSession: true, tabId: 'tab-a', element: el() }));
    const b = extensionViewStore.claim('cu.screen', { sessionId: 'task-b', perSession: true, tabId: 'tab-b', element: el() });
    // Side by side: both on screen at once, each in its own task.
    expect(pagesOf('cu.screen').map((page) => page.place).sort()).toEqual(['session:task-a', 'session:task-b']);
    expect(extensionViewStore.claims.get(residentPageKey('cu.screen', 'session:task-a'))?.token).toBe(a);
    expect(extensionViewStore.claims.get(residentPageKey('cu.screen', 'session:task-b'))?.token).toBe(b);
    // Another slot in task A (a split) still draws task A's page, never task B's.
    const split = extensionViewStore.claim('cu.screen', { sessionId: 'task-a', perSession: true, tabId: 'tab-a2', element: el() });
    expect(extensionViewStore.pageOfSlot('task-a', 'tab-a2')).toBe(residentPageKey('cu.screen', 'session:task-a'));
    // Out of any task (its full page), it is the place every App page has there.
    const full = extensionViewStore.claim('cu.screen', { perSession: true, tabId: 'full', element: el() });
    expect(extensionViewStore.pageOfSlot(null, 'full')).toBe(residentPageKey('cu.screen', 'app'));
    // Control: the same two claims without the declaration share the App's one page.
    const x = extensionViewStore.claim('one.page', { sessionId: 'task-a', tabId: 'tab-a', element: el() });
    const y = extensionViewStore.claim('one.page', { sessionId: 'task-b', tabId: 'tab-b', element: el() });
    expect(pagesOf('one.page').map((page) => page.place)).toEqual(['app']);
    for (const token of [a, b, split, full]) extensionViewStore.release('cu.screen', token);
    for (const token of [x, y]) extensionViewStore.release('one.page', token);
    extensionViewStore.forgetOpened('cu.screen');
    extensionViewStore.forgetOpened('one.page');
  });

  it('let go before it was ever bound (the panel went straight on to a file, 摩擦单 F10): the page goes, and the next claim builds one afresh', () => {
    // The list's claim, then the file's: the list page was never ready, so never bound.
    const list = extensionViewStore.claim('ws.straight', { tabId: 'panel', chatId: 'chat-s', element: el() });
    extensionViewStore.release('ws.straight', list);
    expect(pagesOf('ws.straight')).toHaveLength(0);
    // Its bind answering late changes nothing: that claim is gone.
    extensionViewStore.setSurface(list, 7);
    expect(extensionViewStore.surfaceFor(list)).toBeNull();
    // Control: bound once, then let go — kept, hidden, as before.
    const again = bound(extensionViewStore.claim('ws.straight', { tabId: 'panel', chatId: 'chat-s', element: el() }));
    extensionViewStore.release('ws.straight', again);
    expect(pagesOf('ws.straight').map((page) => page.place)).toEqual(['chat:chat-s']);
    // A second slot still claiming it when the first lets go: kept, whatever its binding.
    const a = extensionViewStore.claim('ws.two', { tabId: 'panel-a', chatId: 'chat-t', element: el() });
    const b = extensionViewStore.claim('ws.two', { tabId: 'panel-b', chatId: 'chat-t', element: el() });
    extensionViewStore.release('ws.two', b);
    expect(pagesOf('ws.two')).toHaveLength(1);
    extensionViewStore.release('ws.two', a);
    expect(pagesOf('ws.two')).toHaveLength(0);
  });
});
