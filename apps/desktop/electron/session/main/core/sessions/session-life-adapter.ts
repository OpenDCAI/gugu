import type {
  ExitFact, Gen, Have, SerializedError, StageName, StageOut, Timing,
} from '@gugu/core/local/session-life/types';
import type { SessionMessage, SessionMessageDelivery } from '@shared/core/sessions/sessions';
import type { AgentInboxSource } from '@gugu/core/local/agent/agentInboxReader';

/** One inbox row an inbox-batch settles: marked read (with what acceptance records) when the agent accepts the batch. */
export type PendingSource = AgentInboxSource & { readonly agentUserId: string };

/** How a row is written for the agent: a fact of the row itself, set at enqueue. */
export type PendingTurn =
  | Readonly<{ kind: 'prompt'; origin?: 'manual' | 'typed' | 'communication'; hiddenContext?: string }>
  // The first turn of a chat-page / dispatched task: its gugu message lands in the capabilities stage and the
  // row's text is rendered through renderFirstTurn at dispatch.
  | Readonly<{ kind: 'chat-page-first-turn' }>;

export interface PendingRow {
  readonly seq: import('@gugu/core/local/session-life/types').Seq;
  readonly sessionId: string;
  readonly kind: 'ordinary' | 'session-direct' | 'inbox-batch';
  readonly state: 'queued' | 'dispatching' | 'accepted' | 'failed' | 'unknown';
  /** Why a failed row failed (its receipt's cause); null otherwise. */
  readonly failure: SerializedError | null;
  readonly message: SessionMessage & { readonly delivery?: SessionMessageDelivery };
  readonly sources: readonly PendingSource[];
  readonly turn: PendingTurn;
}

export interface LegAdapter {
  readonly leg: 'acp' | 'claude-tui' | 'codex' | 'pty';
  readonly timing: Timing;
  run<K extends StageName>(at: K, have: Have<K>, ctx: { gen: Gen; signal: AbortSignal }): Promise<StageOut[K]>;
  dispatch(have: StageOut, row: PendingRow, ctx: { gen: Gen; signal: AbortSignal }): Promise<
    | { result: 'accepted'; nativeReceiptId: string | null }
    | { result: 'rejected-before-admission'; cause: SerializedError }
  >;
  teardown(have: Partial<StageOut>, ctx: { gen: Gen | null }): Promise<void>;
  onExit(have: Pick<StageOut, 'process'>, cb: (exit: ExitFact) => void): () => void;
}
