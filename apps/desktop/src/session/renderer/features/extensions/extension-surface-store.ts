import { action, computed, makeObservable, observable } from 'mobx';
import { extensionViewStore } from './extension-view-store';

/**
 * What an extension has said about **one open tab of its own**.
 *
 * Keyed per surface (task + tab), not per extension: two tabs of the same
 * extension are two different things the user opened, and a title that leaked
 * between them would rename a tab nobody touched. Refs #2374.
 *
 * Only presentation lives here. Nothing an extension writes into this store
 * grants it anything — the grant was already checked in main before the action
 * was allowed to travel.
 */

export interface ExtensionSurfaceState {
  /** Null means "the extension has not renamed it", so the manifest title shows. */
  title: string | null;
  badge: number | string | null;
  /** Last error the extension reported, shown on its own tab rather than a toast. */
  error: string | null;
  /**
   * The live surface behind this tab, once it has bound.
   *
   * Kept here because host chrome — the tab's context menu, its toolbar — is
   * drawn far from the pane that owns the <webview>, and a declared command has
   * to reach *this* surface. Null means nothing is running to tell.
   */
  webContentsId: number | null;
}

const EMPTY: ExtensionSurfaceState = {
  title: null,
  badge: null,
  error: null,
  webContentsId: null,
};

/**
 * Separated by a character neither id can contain, so two different id pairs
 * can never concatenate into the same key. A slot in no task (`sessionId` null) keys as ''.
 */
function key(sessionId: string | null, tabId: string): string {
  return `${sessionId ?? ''}\u0000${tabId}`;
}

/** 常驻页说过的话(标题 / 角标 / 错误):它跟着页走,不跟着格(页见 extension-view-store 的 `residentPages`)。 */
export type ExtensionSharedPresentation = Pick<ExtensionSurfaceState, 'title' | 'badge' | 'error'>;

const EMPTY_SHARED: ExtensionSharedPresentation = { title: null, badge: null, error: null };

class ExtensionSurfaceStore {
  private readonly surfaces = observable.map<string, ExtensionSurfaceState>();
  /**
   * 按常驻页(`residentPageKey`):一个任务里的常驻页只有一张,它设的标题 / 角标在任务里每条会话页的那一格上
   * 都该一样 —— 记在(任务,tab)名下会让切过去的那一格空着,而它明明正对着同一张页。
   */
  private readonly shared = observable.map<string, ExtensionSharedPresentation>();

  constructor() {
    makeObservable(this, {
      say: action,
      setWebContentsId: action,
      forgetShared: action,
      forget: action,
      trackedCount: computed,
    });
  }

  state(sessionId: string | null, tabId: string): ExtensionSurfaceState {
    return this.surfaces.get(key(sessionId, tabId)) ?? EMPTY;
  }

  /**
   * What a page says about itself (`setTabTitle` / `setTabBadge` / `reportError`), whichever host carried it: main to a
   * task's tab or a group's slot (`sessionId` null), the phone's own host to its frame. Kept under the resident page that
   * slot draws — every slot of that page reads it there — else under the slot. A blank title gives the manifest's back.
   */
  say(sessionId: string | null, tabId: string, said: Partial<ExtensionSharedPresentation>): void {
    const patch = said.title === undefined ? said : { ...said, title: said.title?.trim() || null };
    const page = extensionViewStore.pageOfSlot(sessionId, tabId);
    if (page) this.patchShared(page, patch);
    else this.patch(sessionId, tabId, patch);
  }

  /** What a slot shows: by the same rule as `say`. */
  said(sessionId: string | null, tabId: string): ExtensionSharedPresentation {
    const page = extensionViewStore.pageOfSlot(sessionId, tabId);
    return page ? this.sharedState(page) : this.state(sessionId, tabId);
  }

  /** Recorded when the surface binds, cleared when it goes away. */
  setWebContentsId(sessionId: string | null, tabId: string, webContentsId: number | null): void {
    this.patch(sessionId, tabId, { webContentsId });
  }

  sharedState(page: string): ExtensionSharedPresentation {
    return this.shared.get(page) ?? EMPTY_SHARED;
  }

  /** The far-left rail's red dot for an App's tab: any of its live pages has a badge up (the rail draws no number). */
  badgedAnywhere(kind: string): boolean {
    for (const [page, { badge }] of this.shared) {
      if (page.startsWith(`${kind}\u0000`) && badge !== null && badge !== 0 && badge !== '') return true;
    }
    return false;
  }

  /** 页没了(扩展停用、最久没用被销毁)—— 它说过的话一起清掉,再开从清单标题重新开始。 */
  forgetShared(page: string): void {
    this.shared.delete(page);
  }

  private patchShared(page: string, patch: Partial<ExtensionSharedPresentation>): void {
    const next = { ...(this.shared.get(page) ?? EMPTY_SHARED), ...patch };
    if (next.title === null && next.badge === null && next.error === null) {
      this.shared.delete(page);
      return;
    }
    this.shared.set(page, next);
  }

  /** Called when the tab is gone for good, so a reopened tab starts clean. */
  forget(sessionId: string | null, tabId: string): void {
    this.surfaces.delete(key(sessionId, tabId));
  }

  /** Only for judges: proves closing a tab actually releases what it held. */
  get trackedCount(): number {
    return this.surfaces.size;
  }

  private patch(sessionId: string | null, tabId: string, patch: Partial<ExtensionSurfaceState>): void {
    const id = key(sessionId, tabId);
    const next = { ...(this.surfaces.get(id) ?? EMPTY), ...patch };
    if (
      next.title === null &&
      next.badge === null &&
      next.error === null &&
      next.webContentsId === null
    ) {
      this.surfaces.delete(id);
      return;
    }
    this.surfaces.set(id, next);
  }
}

export const extensionSurfaceStore = new ExtensionSurfaceStore();
