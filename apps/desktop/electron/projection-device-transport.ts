import type { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import type { DeviceRpcPipeHandlers } from '@gugu/core/cloud/deviceRpcRequester';
import { openCloudDeviceRpcPipe } from './device-rpc-requester';

type Auth = { userId: string; accessToken: string };
const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  if (signal.aborted) abort();
});
/** SDK channel(topic) deduplicates by name. A page's pipe must not share that mutable channel with another requester. */
export async function openProjectionDevicePipe(input: {
  auth(): Promise<Auth | null>;
  createClient(token: () => Promise<string | null>): ReturnType<typeof createGuguSupabaseClient>;
  report?(error: unknown): void;
}, deviceId: string, asker: string, handlers: DeviceRpcPipeHandlers, signal = new AbortController().signal) {
  signal.throwIfAborted();
  const auth = await abortable(input.auth(), signal);
  signal.throwIfAborted();
  if (!auth?.userId || !auth.accessToken) throw new Error('Projection viewer is not signed in');
  const owner = auth.userId;
  const current = async () => {
    signal.throwIfAborted();
    const value = await abortable(input.auth(), signal);
    signal.throwIfAborted();
    if (!value?.accessToken || value.userId !== owner) throw new Error('Projection viewer account changed');
    return value;
  };
  const client = input.createClient(async () => (await current()).accessToken);
  let released = false;
  const release = () => { if (!released) { released = true; client.realtime.disconnect(); } };
  signal.addEventListener('abort', release, { once: true });
  try {
    const opening = openCloudDeviceRpcPipe({ supabase: client, deviceId, asker, userId: async () => (await current()).userId, ...handlers });
    void opening.then(pipe => { if (signal.aborted) pipe.close(); }, () => { /* The same rejection is awaited below. */ }).catch(error => {
      try {
        if (input.report) input.report(error);
        else process.stderr.write(`Projection late pipe cleanup failed: ${String(error).slice(0, 1000)}\n`);
      } catch { process.stderr.write('Projection late pipe cleanup reporter failed\n'); }
    });
    const pipe = await abortable(opening, signal);
    signal.throwIfAborted();
    return { ...pipe, close() { try { pipe.close(); } finally { release(); } } };
  } catch (error) { release(); throw error; }
  finally { signal.removeEventListener('abort', release); }
}
