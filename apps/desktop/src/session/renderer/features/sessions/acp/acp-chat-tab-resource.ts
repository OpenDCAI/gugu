import type { TabResource } from '@renderer/features/tabs/core/tab-provider';
import { sessionRegistry } from '../stores/session-registry';
import { noteTranscriptShown } from './acp-chat-transcript-keep';
import type { AcpChatStore } from './acp-chat-store';

/**
 * Domain resource for a single open ACP-chat tab.
 *
 * Thin wrapper over AcpChatStore that implements TabResource.
 * The store's lifecycle is managed by AcpChatResourceManager (retain/release).
 * This resource simply exposes the store and bootstraps it on activate.
 */
export class AcpChatTabResource implements TabResource {
  readonly store: AcpChatStore;

  constructor(store: AcpChatStore) {
    this.store = store;
  }

  dispose(): void {
    // AcpChatResourceManager owns the store lifetime.
    // The manager disposes the store after grace when the last tab is closed.
  }

  onActivate(): void {
    // 先记「刚上屏」,再开场:排到最前的这一条不会被自己这次上屏放掉。
    noteTranscriptShown(this.store);
    // Lazy bootstrap: safe to call repeatedly (idempotent); reloads a released transcript.
    this.store.bootstrap();
    // A runtime-only side chat must not mutate even its persisted source conversation.
    if (this.store.isTransient) return;
    // Mirror SessionTabResource: clear the notification indicator when
    // the user opens this tab.
    const session = sessionRegistry
      .get(this.store.sessionId)
      ?.sessions.get(this.store.sessionId);
    if (session && !session.seen) session.markSeen();
  }

  rename(name: string): void {
    if (this.store.isTransient) return;
    void sessionRegistry
      .get(this.store.sessionId)
      ?.renameSession(this.store.sessionId, name);
  }
}
