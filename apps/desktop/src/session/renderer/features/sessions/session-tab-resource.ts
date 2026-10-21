import { computed, makeObservable, reaction } from 'mobx';
import type { TabHandle, TabResource } from '@renderer/features/tabs/core/tab-provider';
import type { SessionStore } from './page-sessions-store';
import type { SessionStartupFailure } from './stores/session-startup-failures';
import { sessionRegistry } from './stores/session-registry';

/** A tab keeps its identity while its conversation registry is loading. */
export class SessionTabResource implements TabResource {
  private readonly stopWatching: () => void;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    handle: TabHandle
  ) {
    makeObservable(this, { store: computed, loadFailure: computed });
    this.stopWatching = reaction(
      () => this.isKnownMissing(),
      (missing) => {
        if (!missing) return;
        // initialize runs before the pane installs this resource. Recheck after
        // that boundary; loading/error states must never close the tab.
        queueMicrotask(() => {
          if (!this.disposed && this.isKnownMissing()) void handle.close();
        });
      },
      { fireImmediately: true }
    );
  }

  get store(): SessionStore | undefined {
    return sessionRegistry.get(this.sessionId)?.sessions.get(this.sessionId);
  }

  get loadFailure(): SessionStartupFailure | null {
    const list = sessionRegistry.get(this.sessionId)?.list;
    return list?.error ? {
      sessionId: this.sessionId,
      message: list.error,
      retrying: list.loading,
      // ACP 腿的列表加载失败不经版本判定(#6341 只接 PTY 腿的 hydrate 拒绝)。
      runtimeUpgrade: null,
    } : null;
  }

  retryLoad(): void {
    void sessionRegistry.get(this.sessionId)?.list.load();
  }

  private isKnownMissing(): boolean {
    const registry = sessionRegistry.get(this.sessionId);
    if (!registry || registry.sessions.has(this.sessionId)) return false;
    return registry.list.data !== null && !registry.list.loading && !registry.list.error;
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
    this.store?.markSeen();
  }

  onActivate(): void {
    const store = this.store;
    if (store && !store.seen) store.markSeen();
  }

  rename(name: string): void {
    if (this.store) {
      void sessionRegistry.get(this.sessionId)?.renameSession(this.sessionId, name);
    }
  }
}
