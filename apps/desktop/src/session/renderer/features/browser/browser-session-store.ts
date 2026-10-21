import { action, computed, makeObservable, observable, toJS } from 'mobx';
import {
  BROWSER_DEFAULT_URL,
  BROWSER_TAB_URL_OPTIONS,
  browserPartitionForProfile,
  createBrowserSessionSnapshot,
  makeBrowserSessionIdentity,
  normalizeBrowserProfileSelection,
  normalizeBrowserUrl,
  normalizeBrowserZoomFactor,
  normalizeBrowserZoomSource,
  type BrowserLoadError,
  type BrowserProfile,
  type BrowserProfileSelection,
  type BrowserSessionRestoreInput,
  type BrowserSessionSnapshot,
} from '@shared/browser';

export type BrowserSessionCreateInput = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  browserId?: string;
  profileId?: BrowserProfileSelection;
  initialUrl?: string;
};

export type BrowserSessionUpdate = Partial<
  Pick<
    BrowserSessionSnapshot,
    'canGoBack' | 'canGoForward' | 'isLoading' | 'title' | 'zoomFactor' | 'zoomSource'
  >
> & {
  currentUrl?: string;
  faviconUrl?: string | null;
  loadError?: BrowserLoadError | null;
  /** `null` = 这一页的布局宽度作废(换页了,还没量新的)——与 faviconUrl / loadError 同一套清除约定。 */
  pageLayoutWidthPx?: number | null;
};

/**
 * #6264 页签实际加载的地址 → 地址栏该显示的地址。别的机器上的网页由 `gugu-preview://<id>/…` 供给,
 * 而人要开的是那台机器上的 `file:///…`:地址栏显示后者(remote-page-url.ts)。返回 null = 原样显示。
 */
export type BrowserUrlPresenter = (loadedUrl: string) => string | null;

export class BrowserSessionStore {
  readonly sessions = observable.map<string, BrowserSessionSnapshot>();
  /** 不进快照、不参与观察:它只决定写进来的地址怎么记,本身不是页签状态。 */
  private readonly presenters = new Map<string, BrowserUrlPresenter>();

  constructor() {
    makeObservable(this, {
      sessions: observable,
      activeSessions: computed,
      createSession: action,
      restoreSession: action,
      setSessionProfile: action,
      migrateProfileSessions: action,
      updateSession: action,
      removeSession: action,
      clear: action,
    });
  }

  get activeSessions(): BrowserSessionSnapshot[] {
    return Array.from(this.sessions.values());
  }

  createSession(input: BrowserSessionCreateInput): BrowserSessionSnapshot {
    const identity = makeBrowserSessionIdentity({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      browserId: input.browserId,
    });
    const snapshot = createBrowserSessionSnapshot({
      identity,
      profileId: input.profileId,
      currentUrl: input.initialUrl,
    });
    this.sessions.set(snapshot.browserId, snapshot);
    return snapshot;
  }

  restoreSession(
    snapshot: BrowserSessionRestoreInput,
    profiles?: readonly BrowserProfile[]
  ): BrowserSessionSnapshot {
    const normalized = normalizeBrowserUrl(snapshot.currentUrl, BROWSER_TAB_URL_OPTIONS);
    const profileId = normalizeBrowserProfileSelection(snapshot.profileId, profiles);
    const restored: BrowserSessionSnapshot = {
      ...snapshot,
      profileId,
      partition: browserPartitionForProfile(snapshot, profileId),
      currentUrl: normalized.ok ? normalized.url : BROWSER_DEFAULT_URL,
      zoomFactor: normalizeBrowserZoomFactor(snapshot.zoomFactor),
      zoomSource: normalizeBrowserZoomSource(
        snapshot.zoomSource,
        normalizeBrowserZoomFactor(snapshot.zoomFactor)
      ),
      // 页面还没加载,上次那个布局宽度描述的是另一次会话里的另一张页面 —— 恢复时一律作废,
      // 由 dom-ready 之后的实测重新填。
      pageLayoutWidthPx: undefined,
      isLoading: false,
      loadError: undefined,
      updatedAt: Date.now(),
    };
    this.sessions.set(restored.browserId, restored);
    return restored;
  }

  setSessionProfile(
    browserId: string,
    profileId: BrowserProfileSelection,
    profiles?: readonly BrowserProfile[]
  ): BrowserSessionSnapshot | null {
    const existing = this.sessions.get(browserId);
    if (!existing) return null;
    const normalized = normalizeBrowserProfileSelection(profileId, profiles);
    if (normalized === existing.profileId) return existing;
    const next: BrowserSessionSnapshot = {
      ...existing,
      profileId: normalized,
      partition: browserPartitionForProfile(existing, normalized),
      isLoading: false,
      loadError: undefined,
      updatedAt: Date.now(),
    };
    this.sessions.set(browserId, next);
    return next;
  }

  migrateProfileSessions(
    fromProfileId: BrowserProfileSelection,
    toProfileId: BrowserProfileSelection,
    profiles: readonly BrowserProfile[]
  ): void {
    const profileId = normalizeBrowserProfileSelection(toProfileId, profiles);
    for (const [browserId, session] of this.sessions) {
      if (session.profileId !== fromProfileId) continue;
      this.sessions.set(browserId, {
        ...session,
        profileId,
        partition: browserPartitionForProfile(session, profileId),
        isLoading: false,
        loadError: undefined,
        updatedAt: Date.now(),
      });
    }
  }

  /** 装上 / 撤掉这个页签的地址呈现(#6264,见 BrowserUrlPresenter)。之后写进来的每个地址都先过它。 */
  setUrlPresenter(browserId: string, presenter: BrowserUrlPresenter | null): void {
    if (presenter) this.presenters.set(browserId, presenter);
    else this.presenters.delete(browserId);
  }

  private present(browserId: string, url: string): string {
    return this.presenters.get(browserId)?.(url) ?? url;
  }

  updateSession(browserId: string, update: BrowserSessionUpdate): BrowserSessionSnapshot | null {
    const existing = this.sessions.get(browserId);
    if (!existing) return null;

    const normalized =
      update.currentUrl === undefined
        ? undefined
        : normalizeBrowserUrl(this.present(browserId, update.currentUrl), BROWSER_TAB_URL_OPTIONS);
    const loadError =
      update.loadError?.url !== undefined
        ? { ...update.loadError, url: this.present(browserId, update.loadError.url) }
        : update.loadError;
    const next: BrowserSessionSnapshot = {
      ...existing,
      ...update,
      currentUrl:
        normalized === undefined
          ? existing.currentUrl
          : normalized.ok
            ? normalized.url
            : existing.currentUrl,
      zoomFactor:
        update.zoomFactor === undefined
          ? existing.zoomFactor
          : normalizeBrowserZoomFactor(update.zoomFactor),
      pageLayoutWidthPx:
        update.pageLayoutWidthPx === null
          ? undefined
          : (update.pageLayoutWidthPx ?? existing.pageLayoutWidthPx),
      faviconUrl:
        update.faviconUrl === null ? undefined : (update.faviconUrl ?? existing.faviconUrl),
      loadError: loadError === null ? undefined : (loadError ?? existing.loadError),
      updatedAt: Date.now(),
    };
    this.sessions.set(browserId, next);
    return next;
  }

  getSession(browserId: string): BrowserSessionSnapshot | undefined {
    return this.sessions.get(browserId);
  }

  getSnapshot(browserId: string): BrowserSessionSnapshot | undefined {
    const snapshot = this.sessions.get(browserId);
    return snapshot ? toJS(snapshot) : undefined;
  }

  removeSession(browserId: string): void {
    this.sessions.delete(browserId);
    this.presenters.delete(browserId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const browserSessionStore = new BrowserSessionStore();
