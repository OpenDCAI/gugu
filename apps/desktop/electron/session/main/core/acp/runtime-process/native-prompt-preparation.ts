import type { AcpRuntimeApiContract } from '@gugu/session-core/acp';
import type { ContractClient } from '@gugu/session-wire/api';
import { prepareSessionAdmission, type SessionAdmissionPreparation } from '@main/core/sessions/session-admission-preparation';

type RuntimeClient = Pick<ContractClient<AcpRuntimeApiContract>,
  'nativePromptPreparationRequested' | 'nativePromptPreparationSettled' | 'enableNativePromptPreparation' | 'resolveNativePromptPreparation'>;
type Log = { warn(message: string, detail?: Record<string, unknown>): void };

/**
 * The host side of native prompt preparation (#881). SessionCell runs in the ACP runtime process, where
 * the assistant panel's preparation is not installed: answer each provider request from here, and confirm
 * or release the prepared notice only when the runtime reports whether that request was sent.
 */
export async function connectNativePromptPreparation(client: RuntimeClient, log: Log): Promise<() => void> {
  const prepared = new Map<string, SessionAdmissionPreparation>();
  const release = (preparation: SessionAdmissionPreparation | undefined) =>
    void preparation?.rejected?.().catch((error: unknown) => log.warn('Native prompt preparation release failed', { error: String(error) }));
  async function answer(sessionId: string, requestId: string) {
    let preparation: SessionAdmissionPreparation | undefined;
    try {
      preparation = await prepareSessionAdmission(sessionId, '');
      prepared.set(requestId, preparation);
      const { ok } = await client.resolveNativePromptPreparation({ requestId, available: true, text: preparation.text,
        ...(preparation.beforeText ? { beforeText: preparation.beforeText } : {}) });
      if (!ok) {
        prepared.delete(requestId); release(preparation);
        log.warn('Native prompt preparation answered after the turn was sent; the notice stays for the next turn', { sessionId });
      }
    } catch (error) {
      prepared.delete(requestId);
      release(preparation);
      log.warn('Native prompt preparation unavailable for this turn', { sessionId, error: String(error) });
      await client.resolveNativePromptPreparation({ requestId, available: false }).catch(() => undefined);
    }
  }
  const stopRequested = await client.nativePromptPreparationRequested.subscribe(undefined, {
    onEvent: ({ sessionId, requestId }) => { void answer(sessionId, requestId); },
  });
  const stopSettled = await client.nativePromptPreparationSettled.subscribe(undefined, {
    onEvent: ({ requestId, accepted }) => {
      const preparation = prepared.get(requestId);
      prepared.delete(requestId);
      if (!preparation) return;
      if (!accepted) return release(preparation);
      void preparation.accepted().catch((error: unknown) => log.warn('Native prompt preparation checkpoint failed', { error: String(error) }));
    },
  });
  await client.enableNativePromptPreparation({});
  return () => {
    stopRequested();
    stopSettled();
    for (const preparation of prepared.values()) release(preparation);
    prepared.clear();
  };
}
