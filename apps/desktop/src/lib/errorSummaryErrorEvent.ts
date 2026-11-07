import { sanitizeErrorLocation } from '../../shared/error-summary'

/** Bind browser getters once; event-owned replacements never run. */
export function createErrorSummaryErrorEventReader() {
  const getters = new Map<string, NonNullable<PropertyDescriptor['get']>>()
  if (typeof ErrorEvent !== 'undefined') {
    const sample = new ErrorEvent('error')
    for (const key of ['isTrusted', 'error', 'filename', 'lineno', 'colno']) {
      for (let object: object | null = sample; object; object = Object.getPrototypeOf(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (!descriptor) continue
        if (descriptor.get) getters.set(key, descriptor.get)
        break
      }
    }
  }
  return (event: unknown): { error: unknown; locations: string[] } | null => {
    try {
      if (getters.get('isTrusted')?.call(event) !== true) return null
      const file: unknown = getters.get('filename')?.call(event)
      const line: unknown = getters.get('lineno')?.call(event)
      const column: unknown = getters.get('colno')?.call(event)
      const locations: string[] = []
      // Published renderer bundles only. No user sourceURL, account path, query,
      // external script or full home path may become an outgoing location.
      const bundle = typeof file === 'string' ? file.match(/^(?:gugu-app:\/\/app\/|file:\/\/\/[^?#\r\n]*\/dist\/)(assets\/[A-Za-z0-9_-]+\.js)$/) : null
      if (bundle && typeof line === 'number' && Number.isInteger(line) && line > 0 && typeof column === 'number' && Number.isInteger(column) && column > 0) {
        const safe = sanitizeErrorLocation(`dist/${bundle[1]}:${line}:${column}`)
        if (safe) locations.push(safe)
      }
      return { error: getters.get('error')?.call(event), locations }
    } catch { return null }
  }
}
