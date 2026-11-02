const HIGH_WATER_BYTES = 8 * 1024 * 1024;

function stringBytes(value: string): number {
  let bytes = Buffer.byteLength(value) + 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92) bytes++;
    else if (code < 32) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i++;
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 3;
  }
  return bytes;
}

/** Byte accounting does not stringify entire messages or retain another serialized copy. */
export function messageBytes(value: unknown): number {
  if (typeof value === 'string') return stringBytes(value);
  if (ArrayBuffer.isView(value)) return value.byteLength * 6 + 32;
  if (value === null || typeof value !== 'object') return 8;
  let bytes = 16;
  for (const [key, child] of Object.entries(value)) bytes += stringBytes(key) + messageBytes(child) + 2;
  return bytes;
}

/** This is an output pressure threshold, not a universal RPC message-size limit.
 * Histories and image replies have no 32 MiB contract limit and must not crash the worker.
 * Pressure must reach producers; merely respecting Node's boolean without pausing input still grows a JS queue. */
export function createIpcPressureSender(
  send: (message: unknown, callback: (error: Error | null) => void) => boolean,
  onError: (error: Error) => void,
  onPressure: (paused: boolean) => void,
  highWaterBytes = HIGH_WATER_BYTES,
) {
  let pendingBytes = 0;
  let paused = false;
  const pressure = (next: boolean) => {
    if (paused === next) return;
    paused = next;
    onPressure(next);
  };
  return {
    get pendingBytes() {
      return pendingBytes;
    },
    send(message: unknown): void {
      const bytes = messageBytes(message);
      pendingBytes += bytes;
      let completed = false;
      const done = (error: Error | null) => {
        if (completed) return;
        completed = true;
        pendingBytes -= bytes;
        if (pendingBytes <= highWaterBytes / 2) pressure(false);
        if (error) onError(error);
      };
      try {
        if (pendingBytes >= highWaterBytes) pressure(true);
        const writable = send(message, done);
        if (!writable && !completed) pressure(true);
      } catch (error) {
        done(null);
        throw error;
      }
    },
  };
}
