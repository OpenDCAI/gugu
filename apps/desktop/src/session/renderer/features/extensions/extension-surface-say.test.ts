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

describe('each context reads only its own resident presentation', () => {
  it('a group page has its own title, badge and error, distinct from another tab in the same group', () => {
    const chatId = 'chat-say-1';
    extensionViewStore.claim('board.main', { tabId: 'panel-slot', chatId, element: el() });
    extensionSurfaceStore.say(null, 'panel-slot', { title: '  Board  ', badge: 3, error: 'boom' });
    const page = residentPageKey('board.main', residentPlace({ chatId, tabId: 'panel-slot' }));
    expect(extensionSurfaceStore.sharedState(page)).toEqual({ title: 'Board', badge: 3, error: 'boom' });
    extensionViewStore.claim('board.main', { tabId: 'other-slot', chatId, element: el() });
    expect(extensionSurfaceStore.said(null, 'other-slot').title).toBeNull();
    extensionSurfaceStore.say(null, 'other-slot', { title: 'Other' });
    expect(extensionSurfaceStore.said(null, 'panel-slot').title).toBe('Board');
    extensionSurfaceStore.say(null, 'panel-slot', { title: '   ' });
    expect(extensionSurfaceStore.said(null, 'panel-slot').title).toBeNull();
    expect(extensionSurfaceStore.said(null, 'other-slot').title).toBe('Other');
  });

  it('a file’s title can be reclaimed only in the same context; closing forgets its slot', () => {
    const chatId = 'chat-say-2';
    extensionViewStore.claim('board.main', { tabId: 'folder', chatId, element: el() });
    extensionViewStore.claim('board.main', { tabId: 'file', chatId, itemId: 'item-1', element: el() });
    extensionSurfaceStore.say(null, 'file', { title: 'plan.board' });
    expect(extensionSurfaceStore.said(null, 'folder').title).toBeNull();
    extensionSurfaceStore.forget(null, 'file');
    expect(extensionViewStore.pageOfSlot(null, 'file')).toBeNull();
    expect(extensionSurfaceStore.said(null, 'file').title).toBeNull();
    extensionViewStore.claim('board.main', { tabId: 'separate', chatId, itemId: 'item-1', element: el() });
    expect(extensionSurfaceStore.said(null, 'separate').title).toBeNull();
    extensionViewStore.claim('board.main', { tabId: 'file', chatId, itemId: 'item-1', element: el() });
    expect(extensionSurfaceStore.said(null, 'file').title).toBe('plan.board');
  });

  it('task slots are isolated and an unclaimed slot still uses its own raw presentation', () => {
    extensionViewStore.claim('board.main', { sessionId: 'task-say', tabId: 'tab-a', element: el() });
    extensionSurfaceStore.say('task-say', 'tab-a', { badge: 7 });
    const own = residentPageKey('board.main', residentPlace({ sessionId: 'task-say', tabId: 'tab-a' }));
    expect(extensionSurfaceStore.sharedState(own).badge).toBe(7);
    extensionSurfaceStore.say('task-say', 'unclaimed', { badge: 1 });
    expect(extensionSurfaceStore.state('task-say', 'unclaimed').badge).toBe(1);
    expect(extensionSurfaceStore.said('task-say', 'unclaimed').badge).toBe(1);
    expect(extensionSurfaceStore.said('task-say', 'tab-a').badge).toBe(7);
  });

  it('a newly claimed independent slot never reads an already-open tab’s title', () => {
    const chatId = 'chat-say-3';
    extensionViewStore.claim('board.main', { tabId: 'first', chatId, element: el() });
    extensionSurfaceStore.say(null, 'first', { title: 'Board' });
    const seen: (string | null)[] = [];
    const stop = autorun(() => seen.push(extensionSurfaceStore.said(null, 'late').title));
    extensionViewStore.claim('board.main', { tabId: 'late', chatId, element: el() });
    extensionSurfaceStore.say(null, 'late', { title: 'Own' });
    stop();
    expect(seen).toEqual([null, null, 'Own']);
    expect(extensionSurfaceStore.said(null, 'first').title).toBe('Board');
  });

  it('another task and another tab in the same task never inherit a badge', () => {
    extensionViewStore.claim('board.main', { sessionId: 'task-two', tabId: 'session-a-tab', element: el() });
    extensionSurfaceStore.say('task-two', 'session-a-tab', { badge: 5 });
    extensionViewStore.claim('board.main', { sessionId: 'task-two', tabId: 'session-b-tab', element: el() });
    extensionViewStore.claim('board.main', { sessionId: 'task-three', tabId: 'session-a-tab', element: el() });
    expect(extensionSurfaceStore.said('task-two', 'session-b-tab').badge).toBeNull();
    expect(extensionSurfaceStore.said('task-three', 'session-a-tab').badge).toBeNull();
    expect(extensionSurfaceStore.said('task-two', 'session-a-tab').badge).toBe(5);
  });
});
