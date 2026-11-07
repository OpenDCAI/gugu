/** Outgoing data contract. Never spread an Error, SDK event or diagnostics object. */
export interface ErrorSummary {
  type: string
  locations: string[]
  version: string
  system: string
  time: string
}

const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'ReactRenderError', 'RendererProcessGone', 'HandledError'])
const SYSTEMS = new Set(['darwin', 'win32', 'linux'])
const SECRET = /(?:\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs]|AKIA|ASIA)[-_]?[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b[A-Fa-f0-9]{24,}\b|[A-Za-z0-9_+-]{32,}={0,2})/i
const EMAIL = /[^\s/@]+@[^\s/@]+\.[^\s/@]+/
const PHONE = /(?:\+?\d[\d ().-]{7,}\d)/

/** A second pass checks values, including values under otherwise allowed keys. */
export function redactErrorSummaryValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || SECRET.test(value) || EMAIL.test(value) || PHONE.test(value)) return null
  return value.replace(/((?:\/|\\)(?:Users|home|Documents and Settings)(?:\/|\\))[^/\\\s]+/gi, '$1[redacted]')
}

function own(input: object, key: string): unknown {
  // Do not execute accessors on arbitrary input while handling an error.
  return Object.getOwnPropertyDescriptor(input, key)?.value
}

export function sanitizeErrorLocation(value: unknown): string | null {
  const safe = redactErrorSummaryValue(value)
  if (!safe) return null
  const appBundle = safe.match(/^gugu-app:\/\/app\/(assets\/[A-Za-z0-9_-]+\.js)(?::([1-9]\d{0,6}):([1-9]\d{0,6}))?$/)
  if (appBundle) return `dist/${appBundle[1]}${appBundle[2] ? `:${appBundle[2]}:${appBundle[3]}` : ''}`
  const slashes = safe.replace(/\\/g, '/')
  const position = slashes.match(/:(\d+):(\d+)$/)
  const withoutPosition = position ? slashes.slice(0, position.index) : slashes
  const normalized = withoutPosition.split(/[?#]/, 1)[0] + (position ? `:${position[1]}:${position[2]}` : '')
  // Dev source roots and packaged application bundles only; no third-party URL/file.
  if (/^[a-z]+:\/\//i.test(normalized) && !/^file:\/\//i.test(normalized) && !/^https?:\/\/(?:localhost|127\.0\.0\.1):\d+\//.test(normalized)) return null
  const devSource = normalized.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/src\/([A-Za-z0-9_./-]+\.(?:[cm]?js|tsx?))(?::([1-9]\d{0,6}))?(?::([1-9]\d{0,6}))?$/)
  if (devSource && !devSource[1].split('/').some(part => part === '..' || part === '.')) return `apps/desktop/src/${devSource[1]}${devSource[2] ? `:${devSource[2]}` : ''}${devSource[3] ? `:${devSource[3]}` : ''}`
  const source = normalized.match(/(?:^|\/)((?:apps\/desktop\/(?:src|electron|shared|dist-electron)|packages\/[a-z][a-z0-9-]*\/src)\/[A-Za-z0-9_./-]+\.(?:[cm]?js|tsx?))(?::([1-9]\d{0,6}))?(?::([1-9]\d{0,6}))?$/)
  const bundle = normalized.match(/(?:^|\/(?:app\.asar|dist)\/)((?:dist\/)?(?:assets\/[A-Za-z0-9_-]+\.js|apps\/desktop\/dist-electron\/[A-Za-z0-9_./-]+\.js))(?::([1-9]\d{0,6}))?(?::([1-9]\d{0,6}))?$/)
  const match = source ?? bundle
  if (!match || match[1].split('/').some(part => part === '..' || part === '.')) return null
  return `${match[1]}${match[2] ? `:${match[2]}` : ''}${match[3] ? `:${match[3]}` : ''}`
}

export function sanitizeErrorSummary(input: unknown): ErrorSummary | null {
  if (!input || typeof input !== 'object') return null
  const time = own(input, 'time')
  if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time))) return null
  const rawType = redactErrorSummaryValue(own(input, 'type'))
  const rawVersion = redactErrorSummaryValue(own(input, 'version'))
  const rawSystem = redactErrorSummaryValue(own(input, 'system'))
  const rawLocations = own(input, 'locations')
  const locations: string[] = []
  if (Array.isArray(rawLocations) && rawLocations.length <= 32) {
    for (let index = 0; index < rawLocations.length; index++) {
      const safe = sanitizeErrorLocation(own(rawLocations, String(index)))
      if (safe && !locations.includes(safe)) locations.push(safe)
    }
  }
  return {
    type: rawType && ERROR_TYPES.has(rawType) ? rawType : 'Error',
    locations,
    version: rawVersion && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:beta|alpha|rc)[.-]?\d{1,5})?$/.test(rawVersion) ? rawVersion : 'unknown',
    system: rawSystem && SYSTEMS.has(rawSystem) ? rawSystem : 'unknown',
    time,
  }
}

export function errorSummaryFromError(error: unknown, metadata: Pick<ErrorSummary, 'version' | 'system' | 'time'>, type?: string, locations: readonly string[] = []): ErrorSummary | null {
  const value = error && typeof error === 'object' ? error : null
  const name = value ? own(value, 'name') : undefined
  // Standard Error names live on prototypes, but no inherited name/getter is read.
  const standardName = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof ReferenceError ? 'ReferenceError' : error instanceof SyntaxError ? 'SyntaxError' : error instanceof URIError ? 'URIError' : error instanceof EvalError ? 'EvalError' : error instanceof AggregateError ? 'AggregateError' : error instanceof Error ? 'Error' : undefined
  // Locations come from the separate consent-gated runtime boundary, never text
  // in an error message, an arbitrary stack string or extra metadata fields.
  return sanitizeErrorSummary({ type: type ?? standardName ?? name, locations, version: own(metadata, 'version'), system: own(metadata, 'system'), time: own(metadata, 'time') })
}
