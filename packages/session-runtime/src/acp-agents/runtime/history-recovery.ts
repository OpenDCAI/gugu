/** Only the bridge's explicit receipt may continue a load with unknown history. */
export function historyUnknownReason(error: unknown, providerSessionId: string): string | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) return null;
  const data = error.data;
  if (typeof data !== 'object' || data === null) return null;
  if (!('kind' in data) || data.kind !== 'history_unknown'
    || !('sessionId' in data) || data.sessionId !== providerSessionId
    || !('reason' in data) || typeof data.reason !== 'string' || !data.reason.trim()) return null;
  return data.reason;
}
