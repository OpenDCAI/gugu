import { APP_SLOT_EVENT, type AppSlotEventDetail } from '@shared/extensions/app-runtime-protocol';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { extensionViewStore } from './extension-view-store';

/**
 * Slots that live outside the session page claim an App's resident page through a window event —
 * the group's side panel first (L3 step 4), later the dock. They are drawn by another React root
 * (the shell), so they cannot reach this store directly; the event carries the slot's element,
 * which is a node of the same document.
 *
 * A slot claims while it is on screen and releases when it goes; the page moves to the top claim
 * (extension-view-store's stack) and back when the slot releases. A slot in a group is in no task:
 * its claim has a `chatId` and no `sessionId`, and that is what the page's context says. A claim with
 * an `itemId` (a file opened with the App) gets a new page made for that file instead (the store's
 * `filePages`, 摩擦单 F3).
 */
export function listenForAppSlots(): () => void {
  const held = new Map<string, { kind: string; token: number }>();
  const release = (slotId: string) => {
    const claim = held.get(slotId);
    if (!claim) return;
    held.delete(slotId);
    extensionViewStore.release(claim.kind, claim.token);
  };
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent<AppSlotEventDetail>).detail;
    if (!detail || typeof detail.slotId !== 'string' || !detail.slotId) return;
    if (detail.type === 'release') {
      release(detail.slotId);
      return;
    }
    if (detail.type === 'command') {
      // A toolbar / menu entry on the slot's header: to the page drawing that slot now (摩擦单 F13).
      const claim = held.get(detail.slotId);
      const webContentsId = claim ? extensionViewStore.surfaceFor(claim.token) : null;
      if (webContentsId === null) {
        log.warn('App slot command ignored: that slot has no running page', { slotId: detail.slotId });
        return;
      }
      void rpc.extensions
        .invokeCommand({ webContentsId, commandId: detail.commandId })
        .then((result) => {
          if (!result.success) log.warn('App slot command refused:', result.error);
        })
        .catch((error: unknown) => log.warn('App slot command failed:', error));
      return;
    }
    if (detail.type !== 'claim') return;
    if (typeof detail.kind !== 'string' || !(detail.element instanceof HTMLElement)) {
      log.warn('App slot claim ignored: it needs a tab kind and an element', { slotId: detail.slotId });
      return;
    }
    // The same slot claiming again (it now shows another group, another App) replaces its claim.
    release(detail.slotId);
    const token = extensionViewStore.claim(detail.kind, {
      tabId: detail.slotId,
      element: detail.element,
      ...(typeof detail.chatId === 'string' && detail.chatId ? { chatId: detail.chatId } : {}),
      ...(typeof detail.itemId === 'string' && detail.itemId ? { itemId: detail.itemId } : {}),
    });
    held.set(detail.slotId, { kind: detail.kind, token });
  };
  window.addEventListener(APP_SLOT_EVENT, onEvent);
  return () => {
    window.removeEventListener(APP_SLOT_EVENT, onEvent);
    for (const slotId of [...held.keys()]) release(slotId);
  };
}
