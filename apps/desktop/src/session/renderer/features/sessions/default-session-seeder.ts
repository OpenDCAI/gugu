import { reaction, runInAction } from 'mobx';
import type { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { sessionRegistry } from './stores/session-registry';

/**
 * Seeds the one automatic default conversation tab for a fresh task.
 *
 * - Suppressed when restored tab state already existed (`markConsumed(true)`).
 * - Starts only after the owning workspace is provisioned, so opening the tab
 *   cannot race the main-process task provider registration.
 * - Handles both conversations that already exist at start and conversations
 *   that arrive later, then self-disposes after consuming the default.
 */
export class DefaultSessionSeeder {
  private _consumed = false;
  private _enabled = false;
  private _sessionDisposer: () => void;
  private _tabDisposer: () => void;

  constructor(
    private readonly sessionId: string,
    private readonly paneLayout: PaneLayoutStore
  ) {
    this._sessionDisposer = reaction(
      () => sessionRegistry.get(this.sessionId)?.sessions.size ?? 0,
      (size) => {
        if (!this._enabled || size === 0) return;
        this.seed();
        if (this._consumed) this._sessionDisposer();
      }
    );
    this._tabDisposer = reaction(
      () => this.paneLayout.groups.some(({ pane }) => pane.tabOrder.length > 0),
      (hasTabs) => {
        if (hasTabs) this._consumed = true;
      }
    );
  }

  /** Call with the return value of paneLayout.hydrate() to suppress seeding when tabs were restored. */
  markConsumed(consumed: boolean): void {
    this._consumed = consumed;
  }

  start(): void {
    if (this._enabled) return;
    this._enabled = true;
    this.seed();
    if (this._consumed) this._sessionDisposer();
  }

  stop(): void {
    this._enabled = false;
  }

  /** Opens this session's chat tab for a fresh view, exactly once. */
  private seed(): void {
    if (!this._enabled || this._consumed) return;
    const sessions = sessionRegistry.get(this.sessionId);
    if (!sessions || sessions.sessions.size === 0) return;

    this._consumed = true;
    if (this.paneLayout.focusedPane.tabOrder.length !== 0) return;

    const store = sessions.sessions.get(this.sessionId);
    if (!store) return;
    const sessionId = this.sessionId;
    runInAction(() => {
      if (store.data.runtime === 'acp') {
        this.paneLayout.open('acp-chat', { sessionId }, { preview: false });
      } else {
        this.paneLayout.open('session', { sessionId }, { preview: false });
      }
    });
  }

  dispose(): void {
    this.stop();
    this._sessionDisposer();
    this._tabDisposer();
  }
}
