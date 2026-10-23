import { randomUUID } from 'node:crypto';
import type { SessionSummary } from '@gugu/session-core/acp';
import { activitySignal } from './signals';

/** Uses the runtime's existing metadata stream; it never opens a transcript or polls a session. */
export class SessionActivityObserver {
  private readonly models = new Map<string, string>();

  observe(previous: SessionSummary | undefined, next: SessionSummary): void {
    const base = { session_id: next.sessionId, occurred_at: null };
    // Foreground working/ready transitions already belong to the canonical agent status writer.
    const runtimeBoundary = ['starting', 'replaying', 'closed', 'lost'].includes(next.lifecycle)
      || (next.lifecycle === 'ready' && previous && ['starting', 'replaying'].includes(previous.lifecycle));
    if (previous && previous.lifecycle !== next.lifecycle && runtimeBoundary) {
      activitySignal({ ...base, event_id: randomUUID(), kind: 'session.lifecycle', lifecycle: next.lifecycle });
    }
    // Startup catalogs can precede the final model selection. Only a live runtime's selected model is evidence.
    if (!['ready', 'working', 'cancelling'].includes(next.lifecycle) || !next.modelId) return;
    const prior = this.models.get(next.sessionId);
    this.models.set(next.sessionId, next.modelId);
    if (prior !== undefined && prior !== next.modelId) {
      activitySignal({ ...base, event_id: randomUUID(), kind: 'session.model_changed',
        previous_model_id: prior, model_id: next.modelId });
    }
  }

  forget(sessionId: string): void { this.models.delete(sessionId); }
  dispose(): void { this.models.clear(); }
}
