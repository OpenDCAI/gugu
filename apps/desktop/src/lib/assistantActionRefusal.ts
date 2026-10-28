/** A rejected operation cannot recover by polling the same endpoint. Preserve its own explanation. */
export function isAssistantActionRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return error instanceof TypeError || typeof code === 'string' && [
    'server_outdated', 'client_outdated', 'forbidden', 'unauthorized',
    'plan_required', 'membership_expired', 'credits_exhausted',
    'version_match_failed', 'version_match_unavailable', 'connection_prepare_timeout',
  ].includes(code)
}
