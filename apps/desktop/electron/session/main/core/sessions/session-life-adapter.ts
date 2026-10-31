import type {
  ExitFact, Gen, Have, SerializedError, StageName, StageOut, Timing,
} from '@gugu/core/local/session-life/types';
import type { SessionMessage, SessionMessageDelivery } from '@shared/core/sessions/sessions';

/** Only references and transport details: the message body remains in messages.content. */
export interface PendingSource {
  readonly messageId: string;
  readonly chatId: string;
  readonly seq: number;
  readonly agentUserId: string;
  readonly forum?: { readonly postId: string; readonly seq: number };
}

export interface PendingRow {
  readonly seq: import('@gugu/core/local/session-life/types').Seq;
  readonly sessionId: string;
  readonly kind: 'ordinary' | 'session-direct' | 'inbox-batch';
  readonly state: 'queued' | 'dispatching' | 'accepted' | 'failed' | 'unknown';
  readonly message: SessionMessage & { readonly delivery?: SessionMessageDelivery };
  readonly sources: readonly PendingSource[];
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
