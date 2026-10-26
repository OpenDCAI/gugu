const FALLBACK_TIME_ZONE = 'UTC';

export interface OwnerTimeZoneContext {
  time_zone: string;
  source_device_id: string | null;
  source_last_seen_at: string | null;
  read_at: string;
  status: 'device' | 'cached' | 'unknown';
}
const KEY = Symbol.for('gugu.account.owner-time-zone');
type ContextGlobal = typeof globalThis & { [KEY]?: OwnerTimeZoneContext };

export function setOwnerTimeZoneContext(context: OwnerTimeZoneContext | null): void {
  if (context) (globalThis as ContextGlobal)[KEY] = { ...context };
  else delete (globalThis as ContextGlobal)[KEY];
}
export function getOwnerTimeZoneContext(): OwnerTimeZoneContext | null {
  const context = (globalThis as ContextGlobal)[KEY];
  return context ? { ...context } : null;
}

export function getLocalTimeZone(): string {
  return getOwnerTimeZoneContext()?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
}
