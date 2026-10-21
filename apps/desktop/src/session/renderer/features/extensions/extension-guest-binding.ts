export interface ExtensionGuestTarget {
  tabId: string;
  sessionId?: string;
  chatId?: string;
  itemId?: string;
}

type Reply = { success: boolean; error?: string };
type Dispatch = (webContentsId: number, target: ExtensionGuestTarget) => Promise<Reply>;

/** A DOM webview may outlive its guest. Binding state belongs to the guest id,
 * and a previous guest's asynchronous reply must never mark its replacement bound. */
export class ExtensionGuestBinding {
  private guest: { webContentsId: number; bound: boolean; tail: Promise<unknown> } | null = null;

  constructor(private readonly dispatch: { bind: Dispatch; retarget: Dispatch }) {}

  ready(webContentsId: number): void {
    if (this.guest?.webContentsId === webContentsId) return;
    this.guest = { webContentsId, bound: false, tail: Promise.resolve() };
  }

  reset(): void {
    this.guest = null;
  }

  get boundWebContentsId(): number | null {
    return this.guest?.bound ? this.guest.webContentsId : null;
  }

  aim(target: ExtensionGuestTarget): Promise<(Reply & { webContentsId: number }) | null> {
    const guest = this.guest;
    if (!guest) return Promise.resolve(null);
    // The same guest's first bind and later moves must land in order. Other
    // pages have their own queue, so a slow page cannot hold up its neighbours.
    const work = guest.tail.then(async () => {
      if (this.guest !== guest) return null;
      const reply = await (guest.bound ? this.dispatch.retarget : this.dispatch.bind)(guest.webContentsId, target);
      if (this.guest !== guest) return null;
      if (reply.success) guest.bound = true;
      return { ...reply, webContentsId: guest.webContentsId };
    });
    guest.tail = work.catch(() => undefined);
    return work;
  }
}
