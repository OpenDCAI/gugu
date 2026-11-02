import { useEffect, useRef } from 'react';
import { useConversationSessionSummary } from '@/hooks/useConversationSessionSummary';
import { rendererLogger } from '@/lib/log';
import { machineRpc } from '@/mobile/agent-watch/sessionpage-rpc';
import { writeCachedNativeRecord } from '@/mobile/agent-watch/timeline-cache';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { machineUnavailableLabel } from '../machine-unavailable-label';

const log = rendererLogger('session/native-tail');
// Match the existing native cache's JSON size limit; its writer owns storage and eviction.
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
type Flight = { pending?: () => boolean; done: Promise<void> };
// Only unfinished requests live here, including across a page unmount/remount.
const flights = new Map<string, Flight>();

/** Save the host's last page as-is, through the same RPC and writer as the phone. */
export function rememberNativeTail(deviceId: string, sessionId: string, available: () => boolean): Promise<void> {
  const key = JSON.stringify([deviceId, sessionId]);
  const known = flights.get(key);
  if (known) { known.pending = available; return known.done; }
  const flight: Flight = { done: Promise.resolve() };
  flights.set(key, flight);
  flight.done = (async () => {
    let requested: (() => boolean) | undefined = available;
    try {
      while (requested) {
        flight.pending = undefined;
        if (!requested()) break;
        try {
          const read = (limit?: number) => machineRpc(deviceId).sessionTimeline.sessionNativeRecord({
            conversationId: sessionId, tail: true, ...(limit === undefined ? {} : { limit }),
          });
          let result = await read();
          if (!result.ok) throw new Error(result.error.message);
          if (JSON.stringify(result.value).length > MAX_ENTRY_BYTES) {
            if (!requested()) break;
            result = await read(20);
            if (!result.ok) throw new Error(result.error.message);
            if (JSON.stringify(result.value).length > MAX_ENTRY_BYTES) {
              log.warn({ deviceId, sessionId }, 'Native tail exceeds the cache limit at 20 turns');
              break;
            }
          }
          writeCachedNativeRecord({ deviceId, sessionId }, result.value);
        } catch (error) {
          log.warn({ deviceId, sessionId, error: String(error) }, 'Native tail could not be remembered');
          break; // A failed read is not retried, including a queued request.
        }
        requested = flight.pending;
      }
    } finally { flights.delete(key); }
  })();
  return flight.done;
}

/** One hook in the live conversation panel shared by the main page, peek and screen blocks. */
export function useRememberNativeTail(projectId: string | undefined, sessionId: string | undefined, generating: boolean, shown: boolean) {
  const deviceId = projectId ? machineRegistry.machineOf(projectId) : null;
  const summary = useConversationSessionSummary(sessionId, deviceId);
  const ready = Boolean(shown && deviceId && projectId && sessionId
    && (summary?.nativeInputVersion === 1 || summary?.nativeInputVersion === 2)
    && !machineUnavailableLabel(projectId));
  const previous = useRef<{ deviceId: string | null; sessionId: string | undefined; ready: boolean; generating: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const last = previous.current;
    previous.current = { deviceId, sessionId, ready, generating };
    const same = last?.deviceId === deviceId && last.sessionId === sessionId;
    if (!ready || !same) clearTimeout(timer.current);
    if (!ready || !deviceId || !sessionId) return;
    const available = () => previous.current?.ready === true
      && previous.current.deviceId === deviceId && previous.current.sessionId === sessionId
      && !machineUnavailableLabel(projectId!);
    const save = () => { void rememberNativeTail(deviceId, sessionId, available); };
    if (!same || !last?.ready) save();
    else if (last.generating && !generating) {
      clearTimeout(timer.current);
      timer.current = setTimeout(save, 1500);
    }
  }, [deviceId, projectId, sessionId, ready, generating]);
  useEffect(() => () => { previous.current = null; clearTimeout(timer.current); }, []);
}
