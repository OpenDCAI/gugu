import type { Hold, Receipt, StageName } from '@gugu/core/local/session-life/types';

/** A projection of the host owner, never persisted or used as a runtime authority. */
export interface LifeView {
  readonly sessionId: string;
  readonly version: number;
  readonly kind: 'dormant' | 'starting' | 'ready' | 'stopping' | 'failed' | 'archived';
  readonly stage: { readonly at: StageName; readonly index: number; readonly total: 7; readonly since: number } | null;
  readonly pending: {
    readonly count: number;
    readonly items: readonly { seq: number; messageId: string; preview: string; state: Receipt['state'] }[];
  };
  readonly hold: Hold['reason'] | null;
  /** at = the failed startup stage; null = an effect fault outside any stage. */
  readonly failure: { readonly at: StageName | null; readonly message: string } | null;
  readonly lastExit: string | null;
}
