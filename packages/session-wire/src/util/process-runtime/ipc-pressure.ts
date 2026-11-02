const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;

/** Byte accounting does not stringify entire messages or retain another serialized copy. */
export function messageBytes(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength + 8;
  if (ArrayBuffer.isView(value)) return value.byteLength + 16;
  if (value === null || typeof value !== 'object') return 8;
  let bytes = 16;
  for (const [key, child] of Object.entries(value)) bytes += key.length * 2 + messageBytes(child);
  return bytes;
}

/** Pressure must reach producers; merely respecting Node's boolean without pausing input still grows a JS queue. */
export function createIpcPressureSender(
  send: (message: unknown, callback: (error: Error | null) => void) => boolean,
  onError: (error: Error) => void,
  onPressure: (paused: boolean) => void,
  highWaterBytes = HIGH_WATER_BYTES,
  maxBytes = MAX_IN_FLIGHT_BYTES,
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
      if (pendingBytes + bytes > maxBytes)
        throw new Error('IPC byte budget exceeded: output producer did not pause');
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
