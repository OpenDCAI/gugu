import type { Hold, Receipt, SerializedError, StageName } from '@gugu/core/local/session-life/types';
import type { AgentStatus } from '@gugu/core/shared/agentStatus';

/** A start the ACP runtime refused: the failure cause carries its AcpRuntimeError as JSON `data`. */
export const ACP_START_FAILED = 'AcpStartFailed';

/** A projection of the host owner, never persisted or used as a runtime authority. */
export interface LifeView {
  readonly sessionId: string;
  readonly version: number;
  readonly kind: 'dormant' | 'starting' | 'ready' | 'stopping' | 'failed' | 'archived';
  readonly stage: { readonly at: StageName; readonly index: number; readonly total: 7; readonly since: number } | null;
  readonly pending: {
    readonly count: number;
    /** kind: who wrote the row (the person's own input is ordinary / session-direct; inbox-batch is the agent's mail). */
    readonly items: readonly { seq: number; messageId: string; preview: string; text: string; kind: 'ordinary' | 'session-direct' | 'inbox-batch'; sentAt: number; state: Receipt['state']; failure: string | null }[];
  };
  readonly hold: Hold['reason'] | null;
  /** at = the failed startup stage; null = an effect fault outside any stage. cause = what the leg reported. */
  readonly failure: { readonly at: StageName | null; readonly message: string; readonly cause: SerializedError } | null;
  readonly lastExit: string | null;
  /** Only for an attempt started by a reconfigure: did it continue the provider session or start a new one. */
  readonly nativeSession: 'preserved' | 'replaced' | null;
}

/** What the agent status feed carries of a session's LifeView (the chat-page pill). */
export type LifeStatus = Pick<LifeView, 'kind' | 'stage'>;

/**
 * The one composition of a session-life session's status (session_get, session_peers, the pill): its lifecycle answers
 * first (archived, starting, failed), otherwise the activity the status writer recorded.
 */
export function displayStatus(life: Pick<LifeView, 'kind'>, activity: AgentStatus | null): AgentStatus | 'starting' | 'archived' | null {
  switch (life.kind) {
    case 'archived': return 'archived';
    case 'starting': return 'starting';
    case 'failed': return 'error';
    case 'dormant': case 'ready': case 'stopping': return activity;
  }
}
