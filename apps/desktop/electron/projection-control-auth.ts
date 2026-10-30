import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_CONTROL_BYTES = 16 * 1024;
const mac = (key: string, binding: string, source: string, data: string) => createHmac('sha256', Buffer.from(key, 'base64url'))
  .update(JSON.stringify([binding, source, data])).digest('base64url');
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);

/** Keys and this signer live in main; a guest receives only an individual signed packet. */
export function projectionControlSigner(key: string, binding: string, source: string, assertCurrent: () => void) {
  if (!validKey(key)) throw new Error('Invalid projection control key');
  return (data: string): string => {
    assertCurrent();
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_CONTROL_BYTES) throw new Error('Projection control is too large');
    const wire = JSON.stringify({ binding, data, mac: mac(key, binding, source, data) });
    if (Buffer.byteLength(wire) > MAX_CONTROL_BYTES) throw new Error('Projection signed control is too large');
    return wire;
  };
}

export function projectionControlKey(): string { return randomBytes(32).toString('base64url'); }

export function verifyProjectionControl(key: string, binding: string, source: string, wire: string): string {
  if (typeof wire !== 'string' || Buffer.byteLength(wire) > MAX_CONTROL_BYTES) throw new Error('Invalid projection control envelope');
  const packet = JSON.parse(wire);
  if (!packet || Array.isArray(packet) || Object.keys(packet).length !== 3 || packet.binding !== binding
    || typeof packet.data !== 'string' || !validKey(packet.mac)) throw new Error('Invalid projection control envelope');
  const expected = mac(key, binding, source, packet.data);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(packet.mac))) throw new Error('Projection control authentication failed');
  return packet.data;
}
