import type { StoredSettledTurn, TurnSettlement } from '@shared/core/sessions/sessionEvents';

/** Subscribe while the handle is alive; closed then waits on facts, not the order of live-model updates. */
export function observeClosedTurnHistory(input: {
  sessionId: string;
  reference: () => string | undefined;
  subscribe: (accept: (receipt: TurnSettlement) => void) => () => void;
  read: (referenceId: string) => Promise<StoredSettledTurn | null>;
  apply: (row: StoredSettledTurn) => void;
  failed: (error: unknown) => void;
}) {
  let disposed = false;
  let current: (() => boolean) | null = null;
  let referenceId: string | undefined;
  let receipt: TurnSettlement | null = null;
  let reading = false;
  let dirty = false;
  const alive = () => !disposed && current?.() === true;
  const failedReceipt = () => receipt?.referenceId === referenceId && receipt.status === 'failed' ? receipt.reason : null;
  const read = async () => {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (dirty && alive() && referenceId) {
        dirty = false;
        const failure = failedReceipt();
        if (failure !== null) {
          input.failed(new Error(failure));
          continue;
        }
        try {
          const row = await input.read(referenceId);
          if (!alive() || failedReceipt() !== null) continue;
          if (row?.turn.referenceId === referenceId && row.turn.outcome) input.apply(row);
          else if (receipt?.referenceId === referenceId && receipt.status === 'persisted') {
            input.failed(new Error('The saved terminal turn could not be read by its immutable origin.'));
          }
        } catch (error) { if (alive()) input.failed(error); }
      }
    } finally { reading = false; }
  };
  const unsubscribe = input.subscribe(next => {
    if (next.sessionId !== input.sessionId || next.referenceId !== (referenceId ?? input.reference())) return;
    receipt = next;
    if (alive()) void read();
  });
  const dispose = () => { disposed = true; unsubscribe(); };
  return {
    dispose,
    close: (isCurrent: () => boolean) => {
      current = isCurrent;
      referenceId = input.reference();
      if (!referenceId) { dispose(); return; }
      void read();
    },
  };
}
