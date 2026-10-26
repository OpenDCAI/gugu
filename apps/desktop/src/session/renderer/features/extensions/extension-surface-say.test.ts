// @vitest-environment jsdom
import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';
import { extensionSurfaceStore, extensionTabTitle } from './extension-surface-store';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';

/**
 * L11 复核 11: what a page says about itself reaches the store one way, whoever carried it — main's relay for a task's
 * tab or a group's slot (`sessionId` null), the phone's host for its frame — and is kept by one rule: under the resident page
 * the slot draws (every slot of that page reads it there), else under the slot. The slot reads it by the same rule.
 */
const el = () => document.createElement('div');

describe('object titles shared by every tab host', () => {
  it('keeps the file name first and the App semantic title in its hint and tooltip', () => {
    const surface = { title: 'Attention Is All You Need', badge: null, error: null };
    expect(extensionTabTitle(surface, 'Reader', { name: 'paper.pdf', path: 'papers/paper.pdf', hint: 'papers' })).toEqual({
      label: 'paper.pdf', hint: 'papers · Attention Is All You Need', tooltip: 'papers/paper.pdf · Attention Is All You Need',
    });
  });

  it('does not repeat the reported file name and uses the App title only for its own page', () => {
    const surface = { title: 'audit-notes.md', badge: null, error: null };
    expect(extensionTabTitle(surface, 'Files', { name: 'audit-notes', path: 'audit-notes.md' })).toEqual({
      label: 'audit-notes', hint: undefined, tooltip: 'audit-notes.md',
    });
    expect(extensionTabTitle(surface, 'Files').label).toBe('audit-notes.md');
    expect(extensionTabTitle({ ...surface, title: null }, 'Files').label).toBe('Files');
  });

  it('reacts to this file page only, including while another file is shown', () => {
    extensionSurfaceStore.say(null, 'title-file-a', { title: 'First semantic title' });
    extensionSurfaceStore.say(null, 'title-file-b', { title: 'Second semantic title' });
    const read = () => extensionTabTitle(extensionSurfaceStore.said(null, 'title-file-a'), 'Viewer', { name: 'first', path: 'first.md' });
    expect(read().hint).toBe('First semantic title');
    extensionSurfaceStore.say(null, 'title-file-b', { title: 'Changed elsewhere' });
    expect(read().hint).toBe('First semantic title');
    extensionSurfaceStore.say(null, 'title-file-a', { title: 'Changed here' });
    expect(read()).toEqual({ label: 'first', hint: 'Changed here', tooltip: 'first.md · Changed here' });
    extensionSurfaceStore.forget(null, 'title-file-a');
    extensionSurfaceStore.forget(null, 'title-file-b');
  });
});

describe('what a page says about itself: one rule to keep it and to read it', () => {
  it('a group’s page: kept under the group’s page, read the same by every slot that draws it', () => {
    const chatId = 'chat-say-1';
    extensionViewStore.claim('board.main', { tabId: 'panel-slot', chatId, element: el() });
    extensionSurfaceStore.say(null, 'panel-slot', { title: '  Board  ', badge: 3, error: 'boom' });
    const page = residentPageKey('board.main', residentPlace({ chatId }));
    expect(extensionSurfaceStore.sharedState(page)).toEqual({ title: 'Board', badge: 3, error: 'boom' });
    expect(extensionSurfaceStore.said(null, 'panel-slot')).toEqual({ title: 'Board', badge: 3, error: 'boom' });
    // Another slot of the same group drawing the same page (a second window, the topic's split) reads the same.
    extensionViewStore.claim('board.main', { tabId: 'other-slot', chatId, element: el() });
    expect(extensionSurfaceStore.said(null, 'other-slot').title).toBe('Board');
    // A blank title gives the manifest's back.
    extensionSurfaceStore.say(null, 'other-slot', { title: '   ' });
    expect(extensionSurfaceStore.said(null, 'panel-slot').title).toBeNull();
  });

  it('a file has its own resident presentation; closing forgets its slot, while another slot reads the live page', () => {
    const chatId = 'chat-say-2';
    extensionViewStore.claim('board.main', { tabId: 'slot-2', chatId, element: el() });
    extensionViewStore.claim('board.main', { tabId: 'slot-2#1', chatId, itemId: 'item-1', element: el() });
    extensionSurfaceStore.say(null, 'slot-2#1', { title: 'plan.board' });
    expect(extensionSurfaceStore.said(null, 'slot-2#1').title).toBe('plan.board');
    expect(extensionSurfaceStore.sharedState(residentPageKey('board.main', residentPlace({ chatId }))).title).toBeNull();
    expect(extensionSurfaceStore.said(null, 'slot-2').title).toBeNull();
    extensionSurfaceStore.forget(null, 'slot-2#1');
    expect(extensionViewStore.pageOfSlot(null, 'slot-2#1')).toBeNull();
    expect(extensionSurfaceStore.said(null, 'slot-2#1').title).toBeNull();
    extensionViewStore.claim('board.main', { tabId: 'slot-2#2', chatId, itemId: 'item-1', element: el() });
    expect(extensionSurfaceStore.said(null, 'slot-2#2').title).toBe('plan.board');
  });

  it('control — a task’s tab, the way it always went: its resident page by page, a tab that is no page’s by the tab', () => {
    extensionViewStore.claim('board.main', { sessionId: 'task-say', tabId: 'tab-a', element: el() });
    extensionSurfaceStore.say('task-say', 'tab-a', { badge: 7 });
    expect(extensionSurfaceStore.sharedState(residentPageKey('board.main', residentPlace({}))).badge).toBe(7);
    extensionSurfaceStore.say('task-say', 'tab-file', { badge: 1 });
    expect(extensionSurfaceStore.state('task-say', 'tab-file').badge).toBe(1);
    expect(extensionSurfaceStore.said('task-say', 'tab-file').badge).toBe(1);
  });

  it('a reader follows its slot: before the claim lands it reads the slot, once it lands the page', () => {
    const chatId = 'chat-say-3';
    extensionViewStore.claim('board.main', { tabId: 'first', chatId, element: el() });
    extensionSurfaceStore.say(null, 'first', { title: 'Board' });
    const seen: (string | null)[] = [];
    const stop = autorun(() => seen.push(extensionSurfaceStore.said(null, 'late').title));
    extensionViewStore.claim('board.main', { tabId: 'late', chatId, element: el() });
    stop();
    expect(seen).toEqual([null, 'Board']);
  });

  it('a slot is a page’s only once claimed: a task’s App tab in another session, never active here, has no page yet', () => {
    // A task's resident tab is claimed only while it is the active tab (ExtensionSharedSlot). The page said 5 through the
    // session where it is active; the same App's tab in another session of that task, not opened since, reads its own slot.
    extensionViewStore.claim('board.main', { sessionId: 'task-two', tabId: 'session-a-tab', element: el() });
    extensionSurfaceStore.say('task-two', 'session-a-tab', { badge: 5 });
    expect(extensionSurfaceStore.said('task-two', 'session-b-tab').badge).toBeNull();
    // That tab's chip therefore names its page itself (extension-tab-provider): the App's one page outside groups (#7052).
    expect(extensionSurfaceStore.sharedState(residentPageKey('board.main', residentPlace({}))).badge).toBe(5);
  });
});
