// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { APP_SLOT_EVENT, type AppSlotEventDetail } from '@shared/extensions/app-runtime-protocol';
import { listenForAppSlots } from './app-slot-events';
import { extensionViewStore, residentPageKey } from './extension-view-store';

/**
 * A slot outside the session page (the group's side panel) claims an App's resident page by window
 * event. Judged on the store the resident layer reads.
 */
const send = (detail: AppSlotEventDetail) => window.dispatchEvent(new CustomEvent(APP_SLOT_EVENT, { detail }));
const el = () => document.createElement('div');
/** The page of `kind` in a place (摩擦单 F48: one page per App per group / task). */
const claimOf = (kind: string, place: string) => extensionViewStore.claims.get(residentPageKey(kind, place));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('app slot events', () => {
  it('a claim puts the page in the slot, for the group and in no task; a release takes it back', () => {
    stop = listenForAppSlots();
    const element = el();
    send({ type: 'claim', slotId: 'group-panel', kind: 'workspace.main', chatId: 'chat-1', element });
    const claim = claimOf('workspace.main', 'chat:chat-1');
    expect(claim).toMatchObject({ tabId: 'group-panel', chatId: 'chat-1', element });
    expect(claim?.sessionId).toBeUndefined();
    send({ type: 'release', slotId: 'group-panel' });
    expect(claimOf('workspace.main', 'chat:chat-1')).toBeUndefined();
  });

  it('the same slot claiming again (it now shows another group) replaces its claim: the other group’s page, not this one moved', () => {
    stop = listenForAppSlots();
    const sessionTab = extensionViewStore.claim('vote.main', { sessionId: 't1', tabId: 'tab1', element: el() });
    send({ type: 'claim', slotId: 'panel', kind: 'vote.main', chatId: 'chat-1', element: el() });
    send({ type: 'claim', slotId: 'panel', kind: 'vote.main', chatId: 'chat-2', element: el() });
    expect(claimOf('vote.main', 'chat:chat-2')?.chatId).toBe('chat-2');
    expect(claimOf('vote.main', 'chat:chat-1')).toBeUndefined();
    // The session tab's page is its own, untouched by the panel.
    expect(claimOf('vote.main', 'app')?.token).toBe(sessionTab);
    send({ type: 'release', slotId: 'panel' });
    expect(claimOf('vote.main', 'chat:chat-2')).toBeUndefined();
    extensionViewStore.release('vote.main', sessionTab);
  });

  it('a file opened in the slot is a page of its own for that file; back (the slot claims the list again) lets it go', () => {
    stop = listenForAppSlots();
    send({ type: 'claim', slotId: 'panel', kind: 'workspace.main', chatId: 'chat-1', element: el() });
    send({ type: 'claim', slotId: 'panel', kind: 'workspace.main', chatId: 'chat-1', itemId: 'notes', element: el() });
    const pages = [...extensionViewStore.filePages.values()];
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: 'workspace.main', claim: { chatId: 'chat-1', itemId: 'notes' } });
    // Control: the App's own page is not handed the file.
    expect(claimOf('workspace.main', 'chat:chat-1')).toBeUndefined();
    send({ type: 'claim', slotId: 'panel', kind: 'workspace.main', chatId: 'chat-1', element: el() });
    expect(extensionViewStore.filePages.size).toBe(0);
    expect(claimOf('workspace.main', 'chat:chat-1')?.itemId).toBeUndefined();
  });

  it('a claim without an element is ignored; stopping the listener releases what it held', () => {
    stop = listenForAppSlots();
    send({ type: 'claim', slotId: 'bad', kind: 'x.main', element: null as unknown as HTMLElement });
    expect(claimOf('x.main', 'session:')).toBeUndefined();
    send({ type: 'claim', slotId: 'good', kind: 'y.main', element: el() });
    stop();
    stop = null;
    expect(claimOf('y.main', 'session:')).toBeUndefined();
  });
});
