import { sanitizeErrorLocation } from './error-summary'

const ErrorConstructor = Error
let nativeGetter: PropertyDescriptor['get']
const captured = new WeakMap<object, string[]>()

/** Runtime boundary: call only after consent. Never parse an existing stack string. */
export function errorSummaryStackLocations(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const cached = captured.get(error)
  if (cached) return [...cached]
  // Resolve the intrinsic lazily, after the caller's consent gate. No getter runs.
  nativeGetter ??= Object.getOwnPropertyDescriptor(new ErrorConstructor(), 'stack')?.get
  const stack = Object.getOwnPropertyDescriptor(error, 'stack')
  if (!nativeGetter || stack?.get !== nativeGetter) return []
  const previous = Object.getOwnPropertyDescriptor(ErrorConstructor, 'prepareStackTrace')
  if (previous && !previous.configurable && !previous.writable) return []
  let locations: string[] | undefined
  let installed = false
  try {
    const formatter = (input: unknown, frames: NodeJS.CallSite[]) => {
      if (input !== error) return 'Error'
      locations = []
      for (const frame of frames.slice(0, 32)) {
        const file = frame.getFileName(), line = frame.getLineNumber(), column = frame.getColumnNumber()
        const safe = sanitizeErrorLocation(`${file}:${line}:${column}`)
        if (safe && !locations.includes(safe)) locations.push(safe)
      }
      // V8 caches this controlled string on the Error. No message/name/functions.
      return `Error\n${locations.map(location => `    at ${location}`).join('\n')}`
    }
    Object.defineProperty(ErrorConstructor, 'prepareStackTrace', previous ? { value: formatter } : { value: formatter, configurable: true, writable: true })
    installed = true
    // Synchronous window only: no await, foreign formatter or error-field access.
    nativeGetter.call(error)
  } catch { return [] } finally {
    if (installed) {
      if (previous) Object.defineProperty(ErrorConstructor, 'prepareStackTrace', previous)
      else Reflect.deleteProperty(ErrorConstructor, 'prepareStackTrace')
    }
  }
  // A previously formatted/cached stack did not invoke our formatter: untrusted.
  if (!locations) return []
  captured.set(error, locations)
  return [...locations]
}
