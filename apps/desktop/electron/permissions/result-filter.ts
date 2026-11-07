const secretKey = /^(?:password|passwd|secret|access_token|refresh_token|api_key|authorization|cookie|set-cookie|private_key)$/i

/** Best-effort known text/field filtering. This is not an image, DOM, file-byte or semantic DLP boundary. */
export function filterPermissionResult(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value
    for (const secret of knownSecrets) if (secret) text = text.split(secret).join('[redacted]')
    text = text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g, '[redacted]')
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return JSON.stringify(filterPermissionResult(parsed, knownSecrets))
    } catch { /* Ordinary text, not structured tool output. */ }
    return text
  }
  if (Array.isArray(value)) return value.map(item => filterPermissionResult(item, knownSecrets))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // Never transform binary/base64 data as though it were text. The owning App must protect observations separately.
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
      secretKey.test(key) ? '[redacted]' : key === 'data' && ['image', 'audio'].includes(String(record.type))
        ? item : filterPermissionResult(item, knownSecrets)]))
  }
  return value
}
