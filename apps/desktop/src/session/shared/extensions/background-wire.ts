/** JSON transports (Chromium's host binding) carry the same binary bridge values as IPC. */
export function backgroundWire(value: unknown, encode: boolean): unknown {
  if (encode && value instanceof ArrayBuffer) return { guguBackgroundBytes: [...new Uint8Array(value)] };
  if (Array.isArray(value)) return value.map((item) => backgroundWire(item, encode));
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (!encode && Object.keys(row).length === 1 && Array.isArray(row.guguBackgroundBytes)) {
      return Uint8Array.from(row.guguBackgroundBytes as number[]).buffer;
    }
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, backgroundWire(item, encode)]));
  }
  return value;
}
