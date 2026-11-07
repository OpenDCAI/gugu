import { describe, expect, it, vi } from 'vitest'
import { errorSummaryFromError, redactErrorSummaryValue, sanitizeErrorLocation, sanitizeErrorSummary } from '../../apps/desktop/shared/error-summary'
import { errorSummaryDestination, errorSummaryRequest } from '../../apps/desktop/shared/error-summary-transport'
import { createErrorSummaryReporter, type ReportingContext } from '../../apps/desktop/shared/error-summary-reporter'

const time = '2026-11-06T15:00:00.000Z'
const summary = { type: 'TypeError', locations: ['apps/desktop/src/App.tsx:12:3'], version: '0.3.2-beta.1', system: 'darwin', time }

describe('outgoing error-summary allowlist', () => {
  it('drops every field outside the allowlist, including nested user content and logs', () => {
    expect(sanitizeErrorSummary({ ...summary, message: 'private chat', user: { email: 'someone@example.test' }, token: 'private', screenshot: 'data:image/png', memory: new Uint8Array([1]), breadcrumbs: ['private'], request: { body: 'private' }, extra: { token: 'private' } })).toEqual(summary)
  })

  it.each(['sk-testSuperSecretKey123456789', 'ghp_abcdefghijklmnopqrstuvwxyz123456', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature1234', 'Bearer abcdefghijklmnop', 'a'.repeat(40), 'aabbccddeeff00112233445566778899', 'someone@example.test', '+86 138 1234 5678', '+1 (415) 555-0123'])('rejects secret-shaped or personal values even in allowed fields: %s', value => {
    expect(redactErrorSummaryValue(value)).toBeNull()
    const result = sanitizeErrorSummary({ ...summary, type: value, version: value, system: value, locations: [value] })!
    expect(JSON.stringify(result)).not.toContain(value)
    expect(result).toEqual({ ...summary, type: 'Error', locations: [], version: 'unknown', system: 'unknown' })
  })

  it('removes user-home path segments on macOS, Linux and Windows', () => {
    for (const path of ['/Users/alice/work/gugu/apps/desktop/src/App.tsx:12:3', '/home/alice/gugu/apps/desktop/src/App.tsx:12:3', 'C:\\Users\\alice\\work\\gugu\\apps\\desktop\\src\\App.tsx:12:3']) {
      expect(sanitizeErrorLocation(path)).toBe('apps/desktop/src/App.tsx:12:3')
      expect(redactErrorSummaryValue(path)).not.toContain('alice')
    }
  })

  it('keeps positions from application-owned dev and packaged runtime paths', () => {
    expect(sanitizeErrorLocation('http://localhost:18537/src/App.tsx:12:3')).toBe('apps/desktop/src/App.tsx:12:3')
    expect(sanitizeErrorLocation('/Users/alice/client/apps/desktop/dist-electron/main.js:12:3')).toBe('apps/desktop/dist-electron/main.js:12:3')
    expect(sanitizeErrorLocation('file:///Applications/Gugu.app/Contents/Resources/app.asar/dist/assets/main-abcd.js:12:3')).toBe('dist/assets/main-abcd.js:12:3')
    expect(sanitizeErrorLocation('gugu-app://app/assets/main-abcd.js:12:3')).toBe('dist/assets/main-abcd.js:12:3')
    expect(sanitizeErrorLocation('gugu-app://app/src/accounts/alice/account-1234.ts:12:3')).toBeNull()
    expect(sanitizeErrorLocation('gugu-app://app/assets/main-abcd.js?private=alice:12:3')).toBeNull()
  })

  it('drops third-party URLs, arbitrary files, traversal, query credentials and first-line error messages', () => {
    for (const path of ['https://evil.test/apps/desktop/src/App.tsx:1:2', '/Users/alice/Documents/private.js:1:2', 'apps/desktop/src/../../private.js:1:2', 'apps/desktop/src/App.tsx?token=sk-verySecret123456789:1:2']) expect(sanitizeErrorLocation(path)).toBeNull()
    const error = new TypeError('private message someone@example.test')
    Object.defineProperty(error, 'stack', { value: 'TypeError: private message someone@example.test\n    at privateFunction (/Users/alice/work/gugu/apps/desktop/src/App.tsx:12:3)\n    at external (https://evil.test/page.js:1:2)' })
    expect(errorSummaryFromError(error, summary, undefined, summary.locations)).toEqual(summary)
    expect(errorSummaryFromError(error, summary)?.locations).toEqual([])
  })

  it('ignores accessors without executing them and rejects invalid time', () => {
    const getter = vi.fn(() => 'private')
    const input = { ...summary }
    Object.defineProperty(input, 'type', { get: getter })
    expect(sanitizeErrorSummary(input)?.type).toBe('Error')
    expect(getter).not.toHaveBeenCalled()
    expect(sanitizeErrorSummary({ ...summary, time: 'someone@example.test' })).toBeNull()
  })

  it.each([new URIError('private'), new EvalError('private'), new AggregateError([new Error('private')], 'private')])('preserves the standard error category without its message or nested errors: %s', error => {
    const result = errorSummaryFromError(error, summary)!
    expect(result.type).toBe(error.constructor.name)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(result).not.toHaveProperty('errors')
  })

  it('does not invoke custom stack accessors or accept locations from metadata', () => {
    const getter = vi.fn(() => 'private stack')
    const error = new Error('private')
    Object.defineProperty(error, 'stack', { get: getter })
    expect(errorSummaryFromError(error, summary)).toEqual({ ...summary, type: 'Error', locations: [] })
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not treat multiline message content as code locations', () => {
    const privatePath = 'apps/desktop/src/accounts/alice/account-1234.ts:12:3'
    const message = `private problem\n    at account (${privatePath})\nprivate continuation`
    const error = new TypeError(message)
    Object.defineProperty(error, 'stack', { value: `TypeError: ${message}\n    at runtime (apps/desktop/src/App.tsx:12:3)`, configurable: true })
    expect(errorSummaryFromError(error, summary)).toEqual({ ...summary, locations: [] })
    expect(JSON.stringify(errorSummaryFromError(error, summary))).not.toContain('alice')
  })

  it('never invokes native stack formatting through tampered name or message accessors', () => {
    const error = new Error('private')
    const name = vi.fn(() => 'Error')
    const message = vi.fn(() => 'private')
    Object.defineProperty(error, 'name', { get: name })
    Object.defineProperty(error, 'message', { get: message })
    const result = errorSummaryFromError(error, summary)
    expect(result?.locations).toEqual([])
    expect(name).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()
  })

  it.each(['missing', 'different', 'accessor'])('drops data stacks with an unverified %s message header', kind => {
    const error = new TypeError('private message')
    const getter = vi.fn(() => 'private message')
    if (kind === 'missing') Reflect.deleteProperty(error, 'message')
    if (kind === 'accessor') Object.defineProperty(error, 'message', { get: getter })
    Object.defineProperty(error, 'stack', { value: 'TypeError: other message\n    at account (apps/desktop/src/accounts/alice/account-1234.ts:12:3)' })
    expect(errorSummaryFromError(error, summary)?.locations).toEqual([])
    expect(getter).not.toHaveBeenCalled()
  })

  it('never uses multiline names or CRLF messages as locations', () => {
    const error = new TypeError('private\r\n    at account (apps/desktop/src/accounts/alice/account-1234.ts:12:3)')
    const name = 'TypeError\n    at account (apps/desktop/src/accounts/bob/account-5678.ts:12:3)'
    Object.defineProperty(error, 'name', { value: name })
    Object.defineProperty(error, 'stack', { value: `${name}: ${error.message}\n    at runtime (apps/desktop/src/App.tsx:12:3)` })
    expect(errorSummaryFromError(error, summary)).toEqual({ ...summary, locations: [] })
  })

  it('does not call Error.prepareStackTrace for a native stack accessor', () => {
    const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
    const prepare = vi.fn(() => 'private formatted stack')
    const error = new Error('private')
    let result
    try {
      Object.defineProperty(Error, 'prepareStackTrace', { value: prepare, configurable: true, writable: true })
      result = errorSummaryFromError(error, summary)
    } finally {
      if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous)
      else Reflect.deleteProperty(Error, 'prepareStackTrace')
    }
    expect(result?.locations).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })

  it('constructs exactly the versioned JSON contract with no SDK event or user context', () => {
    const body = errorSummaryRequest({ ...summary, message: 'private', user: { id: 'private' }, event_id: 'private' })!
    expect(JSON.parse(body)).toEqual({ schemaVersion: 1, summary })
    expect(body).not.toContain('private')
    expect(errorSummaryRequest({ ...summary, version: 'unknown' })).toBeNull()
    expect(errorSummaryRequest({ ...summary, system: 'unknown' })).toBeNull()
  })

  it('disables absent/invalid endpoints and rejects DSN or SDK authentication', () => {
    for (const endpoint of ['', ' ', 'bad', 'http://errors.example.test/v1/beta-errors', 'https://public@errors.example.test/v1/beta-errors', 'https://public:secret@errors.example.test/v1/beta-errors', 'https://errors.example.test/api/1/envelope/', 'https://errors.example.test/v1/beta-errors?token=private']) expect(errorSummaryDestination(endpoint)).toBeNull()
    expect(errorSummaryDestination('https://errors.example.test/v1/beta-errors')).toEqual({ url: 'https://errors.example.test/v1/beta-errors' })
  })
})

function reporterRig(configured = true) {
  let context: ReportingContext = { eligible: true, allowed: true, scope: 'account-a' }
  let disk: unknown = []
  const send = vi.fn(async (_summary: unknown, _signal: AbortSignal) => {})
  const read = vi.fn(() => disk)
  const save = vi.fn((rows: unknown) => { disk = structuredClone(rows) })
  const start = () => createErrorSummaryReporter({ configured, context: () => context, read, save, send, now: () => Date.parse(time) })
  return { start, send, read, save, context: (next: Partial<ReportingContext>) => { context = { ...context, ...next } }, seed: (value: unknown) => { disk = value } }
}

describe('consent and retry boundary', () => {
  it('makes zero requests or queue reads/writes when no endpoint is configured', () => {
    const r = reporterRig(false)
    const reporter = r.start()
    reporter.start()
    reporter.report(summary)
    expect(r.send).not.toHaveBeenCalled()
    expect(r.read).not.toHaveBeenCalled()
    expect(r.save).not.toHaveBeenCalled()
  })

  it.each([{ allowed: false }, { eligible: false }, { scope: undefined }])('does not retain pre-consent or ineligible errors: %j', context => {
    const r = reporterRig()
    r.context(context)
    const reporter = r.start()
    reporter.report(summary)
    r.context({ eligible: true, allowed: true, scope: 'account-a' })
    expect(reporter.pending()).toEqual([])
    expect(r.send).not.toHaveBeenCalled()
    expect(r.save).not.toHaveBeenCalled()
  })

  it('persists only sanitized data before networking and sanitizes again on restart', async () => {
    const r = reporterRig()
    r.send.mockRejectedValueOnce(new Error('offline'))
    const reporter = r.start()
    reporter.report({ ...summary, private: 'secret' })
    await reporter.flush()
    expect(r.save.mock.calls[0][0]).toEqual([{ scope: 'account-a', summary }])
    r.seed([{ scope: 'account-a', summary: { ...summary, private: 'secret' } }])
    r.start().start()
    await Promise.resolve()
    expect(r.send.mock.calls.at(-1)?.[0]).toEqual(summary)
    expect(JSON.stringify(r.save.mock.calls)).not.toContain('secret')
  })

  it('aborts pending work on withdrawal and does not resurrect it after completion', async () => {
    const r = reporterRig()
    let finish!: () => void
    r.send.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const reporter = r.start()
    reporter.report(summary)
    const signal = r.send.mock.calls[0][1]
    r.context({ allowed: false })
    reporter.changed()
    expect(signal.aborted).toBe(true)
    expect(reporter.pending()).toEqual([])
    finish()
    await Promise.resolve()
    expect(reporter.pending()).toEqual([])
  })

  it('does not send another account or expired events and deduplicates repeated failures', async () => {
    const r = reporterRig()
    r.seed([{ scope: 'other-account', summary }, { scope: 'account-a', summary: { ...summary, time: '2026-10-01T15:00:00.000Z' } }])
    const reporter = r.start()
    reporter.start()
    expect(r.send).not.toHaveBeenCalled()
    reporter.report(summary)
    reporter.report(summary)
    await reporter.flush()
    expect(r.send).toHaveBeenCalledTimes(1)
  })

  it('does not send when sanitized persistence fails', () => {
    const r = reporterRig()
    r.save.mockImplementationOnce(() => { throw new Error('disk full') })
    const reporter = r.start()
    reporter.report(summary)
    expect(r.send).not.toHaveBeenCalled()
    expect(reporter.pending()).toEqual([])
  })
})
