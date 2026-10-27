/** A native prompt addressed an id that its provider no longer owns. Not a failed model turn. */
export function providerRejectedMissingSession(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown; data?: { details?: unknown } };
  return e.code === -32002 || (e.code === -32603 && e.message === 'Internal error'
    && e.data?.details === 'Session not found');
}
