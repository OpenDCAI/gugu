import { describe, expect, it, vi } from 'vitest'
import { createErrorSummaryConsentStore, decodeErrorSummaryConsent } from '../../apps/desktop/shared/error-summary-consent'

function rig() {
  let scope: string | undefined = 'anonymous'
  let disk: unknown = null
  const save = vi.fn((value: unknown) => { disk = structuredClone(value) })
  const changed = vi.fn()
  const start = (eligible = true) => createErrorSummaryConsentStore({ eligible, read: () => disk, save, changed, withdraw: vi.fn(), scope: () => scope })
  return { start, save, changed, withdraw: vi.fn(), scope: (value: string | undefined) => { scope = value }, disk: () => disk }
}

describe('desktop error-summary consent', () => {
  it('asks only after an error and persists both refusal and acceptance across restart', () => {
    const r = rig()
    const store = r.start()
    expect(store.snapshot()).toEqual({ eligible: true, context: 'anonymous', decision: 'unknown', encountered: false })
    store.encounter()
    expect(r.start().snapshot().encountered).toBe(true)
    store.set('denied')
    const restarted = r.start()
    restarted.encounter()
    expect(restarted.snapshot()).toEqual({ eligible: true, context: 'anonymous', decision: 'denied', encountered: false })
    restarted.set('allowed')
    expect(r.start().snapshot().decision).toBe('allowed')
  })

  it('isolates accounts and signed-out consent and refuses undecided identity', () => {
    const r = rig()
    const store = r.start()
    store.set('allowed')
    r.scope('a'.repeat(64))
    expect(store.snapshot().decision).toBe('unknown')
    store.set('denied')
    expect(() => store.set('allowed', 'anonymous')).toThrow()
    r.scope('b'.repeat(64))
    expect(store.snapshot().decision).toBe('unknown')
    r.scope(undefined)
    expect(store.snapshot().eligible).toBe(false)
    expect(() => store.set('allowed')).toThrow()
    r.scope('anonymous')
    expect(store.snapshot().decision).toBe('allowed')
  })

  it('never treats an unsuccessful save as acceptance and blocks a failed withdrawal', () => {
    const r = rig()
    const store = r.start()
    r.save.mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => store.set('allowed')).toThrow()
    expect(store.snapshot().decision).toBe('unknown')
    store.set('allowed')
    r.save.mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => store.set('denied')).toThrow()
    expect(store.snapshot().decision).not.toBe('allowed')
    expect(r.changed).toHaveBeenCalled()
  })

  it('does not activate outside the pilot and ignores malformed or future consent data', () => {
    const r = rig()
    const store = r.start(false)
    store.encounter()
    expect(r.save).not.toHaveBeenCalled()
    expect(() => store.set('allowed')).toThrow()
    expect(decodeErrorSummaryConsent({ version: 2, decisions: { anonymous: 'allowed' } }).decisions).toEqual({})
    expect(decodeErrorSummaryConsent({ version: 1, decisions: { anonymous: true, token: 'allowed' }, encountered: { arbitrary: true } })).toEqual({ version: 1, decisions: {}, encountered: {} })
  })

  it('remembers only an encounter marker before identity is restored, never the error', () => {
    const r = rig()
    r.scope(undefined)
    r.start().encounter()
    r.scope('anonymous')
    const store = r.start()
    expect(store.snapshot().encountered).toBe(true)
    store.set('allowed')
    expect(store.snapshot().encountered).toBe(false)
    expect(JSON.stringify(r.disk())).not.toContain('message')
  })
})
