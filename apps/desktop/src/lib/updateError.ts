export type UpdateErrorReason =
  | { code: 'unknown' }
  | { code: 'packageNotFound' }
  | { code: 'integrity' }
  | { code: 'network' }
  | { code: 'server'; status: string }
  | { code: 'raw'; message: string }

// Keep updater diagnostics language-neutral below the UI boundary. Unknown errors retain a
// bounded copy of the original message so localization never turns a failure into silence.
export function classifyUpdateError(message: string): UpdateErrorReason {
  const raw = (message ?? '').trim()
  if (!raw) return { code: 'unknown' }
  const m = raw.toLowerCase()

  if (/\b404\b|not found|does not exist|cannot find|no such file/.test(m)) {
    return { code: 'packageNotFound' }
  }
  if (/sha512|checksum|hash mismatch|integrity|校验/.test(m)) {
    return { code: 'integrity' }
  }
  if (
    /net::|enotfound|etimedout|econnrefused|econnreset|eai_again|getaddrinfo|socket hang up|network|timed?\s?out|\bdns\b/.test(
      m,
    )
  ) {
    return { code: 'network' }
  }
  const status = m.match(/\b(4\d\d|5\d\d)\b/)
  if (status) return { code: 'server', status: status[1] }

  return { code: 'raw', message: raw.length > 120 ? `${raw.slice(0, 117)}…` : raw }
}
