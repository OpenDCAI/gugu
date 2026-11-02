import type { AppWhere, PreparedChatFile } from '@shared/extensions/app-runtime-protocol';

/** Where a page is aimed (`AppWhere`), in which tab, for which file. */
export interface ExtensionGuestTarget extends AppWhere {
  opening?: PreparedChatFile;
  tabId: string;
  itemId?: string;
}

type Reply = { success: boolean; error?: string };
type Dispatch = (webContentsId: number, target: ExtensionGuestTarget) => Promise<Reply>;

/** A DOM webview may outlive its guest. Binding state belongs to the guest id,
 * and a previous guest's asynchronous reply must never mark its replacement bound. */
export class ExtensionGuestBinding {
  private guest: { webContentsId: number; target: ExtensionGuestTarget | null; tail: Promise<unknown> } | null = null;

  constructor(private readonly dispatch: { bind: Dispatch; retarget: Dispatch }) {}

  ready(webContentsId: number): void {
    if (this.guest?.webContentsId === webContentsId) return;
    this.guest = { webContentsId, target: null, tail: Promise.resolve() };
  }

  reset(): void {
    this.guest = null;
  }

  get boundWebContentsId(): number | null {
    return this.guest?.target ? this.guest.webContentsId : null;
  }

  aim(target: ExtensionGuestTarget): Promise<(Reply & { webContentsId: number }) | null> {
    const guest = this.guest;
    if (!guest) return Promise.resolve(null);
    // The same guest's first bind and later moves must land in order. Other
    // pages have their own queue, so a slow page cannot hold up its neighbours.
    const work = guest.tail.then(async () => {
      if (this.guest !== guest) return null;
      const previous = guest.target;
      if (previous && previous.tabId === target.tabId && previous.workspace === target.workspace && previous.conversation === target.conversation && previous.itemId === target.itemId) {
        return { success: true, webContentsId: guest.webContentsId };
      }
      const reply = await (previous ? this.dispatch.retarget : this.dispatch.bind)(guest.webContentsId, target);
      if (this.guest !== guest) return null;
      if (reply.success) guest.target = { tabId: target.tabId, workspace: target.workspace, conversation: target.conversation, itemId: target.itemId };
      return { ...reply, webContentsId: guest.webContentsId };
    });
    guest.tail = work.catch(() => undefined);
    return work;
  }
}
