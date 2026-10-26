/** Public categories only: SQL messages, paths and provider diagnostics stay in
 * logs. Both clients use the same localized explanation for a cloud read. */
export function assistantPanelFailure(error: unknown, t: (key: string, values?: Record<string, unknown>) => string): string {
  const detail = error as { code?: string; domain?: string; resourceKey?: string }
  const code = detail?.code
  const key = code === 'read-timeout' ? 'readTimedOut' : code === 'preparation-timeout' ? 'preparationFailed'
    : code === 'unprepared' ? 'unprepared' : code === 'stale' ? 'stale'
    : code === 'application-failed' ? 'applicationFailed'
      : code === '40001' || code === 'exists' ? 'changed'
        : ['42501','signed-out','account-changed'].includes(code ?? '') ? 'accessFailed'
          : code === 'missing-home' || code === 'missing-identity' ? 'identityFailed'
            : code === 'invalid-path' || code === '22023' ? 'invalidResource'
              : code === '54000' ? 'tooLarge' : 'collectionFailed'
  return t(`machine.${key}`,{ resource: detail?.resourceKey ?? '',domain: detail?.domain ? t(`resourceKinds.${detail.domain}`) : '' })
}
