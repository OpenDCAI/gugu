import { action, makeObservable, observable } from 'mobx';
import type { PeekTarget } from '@shared/extensions/app-runtime-protocol';
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs';
import { openAttachmentImage } from '@/lib/attachmentBytes';

const key = (sessionId: string | null, tabId: string) => `${sessionId ?? ''}\u0000${tabId}`;

/**
 * G1 What is open beside an App's page (`files.openWith(file, { peek: true })`, `showSession(id, { peek: true })`), by the
 * slot that page is drawn in — a session's tab, the dock, a chat's panel (`sessionId` null), a phone's frame: the slot draws
 * it (`AppPeekSlot`), and the page is left as it is. One at a time: a new one takes the place of the last.
 */
class PeekStore {
  private readonly peeks = observable.map<string, PeekTarget>({}, { deep: false });

  constructor() {
    makeObservable(this, { open: action, close: action });
  }

  of(sessionId: string | null, tabId: string): PeekTarget | null {
    return this.peeks.get(key(sessionId, tabId)) ?? null;
  }

  open(sessionId: string | null, tabId: string, target: PeekTarget): void {
    if (target.kind === 'chat' && target.detail.choice.kind === 'none' && isRenderableImage(target.detail.name, target.detail.file.contentType)) {
      const { detail } = target;
      openAttachmentImage({ kind: 'item', itemId: detail.itemId, version: detail.file.version }, detail.name, { chatId: detail.chatId });
      return;
    }
    this.peeks.set(key(sessionId, tabId), target);
  }

  close(sessionId: string | null, tabId: string): void {
    this.peeks.delete(key(sessionId, tabId));
  }
}

export const peekStore = new PeekStore();
