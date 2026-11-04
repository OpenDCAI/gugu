import type { StoredSettledTurn, TurnSettlement } from '@shared/core/sessions/sessionEvents';

/** Subscribe while the handle is alive; closed then waits on facts, not the order of live-model updates. */
export function observeClosedTurnHistory(input: {
  sessionId: string;
  turn: () => { id: string; referenceId?: string } | null;
  subscribe: (accept: (receipt: TurnSettlement) => void) => () => void;
  read: (referenceId: string, originTurnId: string) => Promise<StoredSettledTurn | null>;
  apply: (row: StoredSettledTurn) => void;
  failed: (error: unknown) => void;
}) {
  let disposed = false;
  let current: (() => boolean) | null = null;
  let referenceId: string | undefined;
  let originTurnId: string | undefined;
  let receipt: TurnSettlement | null = null;
  let reading = false;
  let dirty = false;
  const alive = () => !disposed && current?.() === true;
  const failedReceipt = () => {
    const next = receipt;
    return next && next.referenceId === referenceId && next.status === 'failed' ? next.cause : null;
  };
  const read = async () => {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (dirty && alive() && referenceId && originTurnId) {
        dirty = false;
        const failure = failedReceipt();
        if (failure !== null) {
          input.failed(failure);
          continue;
        }
        try {
          const row = await input.read(referenceId, originTurnId);
          if (!alive() || failedReceipt() !== null) continue;
          if (row?.originTurnId === originTurnId && row.turn.referenceId === referenceId && row.turn.outcome) input.apply(row);
          else if (receipt?.referenceId === referenceId && receipt.status === 'persisted') {
            input.failed(new Error('The saved conversation entry could not be loaded.'));
          }
        } catch (error) { if (alive() && failedReceipt() === null) input.failed(error); }
      }
    } finally { reading = false; }
  };
  const unsubscribe = input.subscribe(next => {
    if (next.sessionId !== input.sessionId || next.referenceId !== (referenceId ?? input.turn()?.referenceId)) return;
    receipt = next;
    if (alive()) void read();
  });
  const dispose = () => { disposed = true; unsubscribe(); };
  return {
    dispose,
    close: (isCurrent: () => boolean) => {
      current = isCurrent;
      const turn = input.turn();
      if (!turn) { dispose(); return; }
      referenceId = turn.referenceId;
      originTurnId = turn.id;
      if (!referenceId) {
        if (alive()) input.failed(new Error('The closing turn has no stable history reference.'));
        dispose(); return;
      }
      void read();
    },
  };
}
