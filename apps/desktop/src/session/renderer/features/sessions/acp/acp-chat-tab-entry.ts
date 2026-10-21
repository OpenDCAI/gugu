import { action, makeObservable, observable } from 'mobx';

/**
 * Observable entry for a single ACP-chat tab.
 * Owned by PaneStore; its identity fields are persisted via acpChatTabProvider.
 */
export class AcpChatTabEntry {
  readonly kind = 'acp-chat' as const;
  readonly tabId: string;
  sessionId: string;
  isPreview: boolean;

  constructor(sessionId: string, isPreview: boolean, tabId?: string) {
    this.tabId = tabId ?? crypto.randomUUID();
    this.sessionId = sessionId;
    this.isPreview = isPreview;
    makeObservable(this, {
      sessionId: observable,
      isPreview: observable,
      pin: action,
    });
  }

  pin(): void {
    this.isPreview = false;
  }
}
