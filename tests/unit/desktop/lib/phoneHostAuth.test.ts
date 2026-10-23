import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import { createPhoneHostAuthGate } from '../../../../apps/desktop/src/lib/phoneHostAuthGate'

const native = vi.hoisted(() => ({ authSession: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true }, registerPlugin: () => native }))
import { phoneHostGetSession, phoneHostRefreshSession, phoneHostSignOut } from '../../../../apps/desktop/src/lib/phoneHostAuth'

describe('Android host refresh authority', () => {
  it('waits for an in-flight renderer operation before transferring ownership', async () => {
    const ordered = createPhoneHostAuthGate()
    const events: string[] = []
    let finish!: () => void
    const first = ordered(async () => { events.push('refresh'); await new Promise<void>((resolve) => { finish = resolve }); events.push('persisted') })
    const second = ordered(async () => { events.push('configure') })
    await vi.waitFor(() => expect(events).toEqual(['refresh']))
    finish()
    await Promise.all([first, second])
    expect(events).toEqual(['refresh', 'persisted', 'configure'])
  })

  it('a failed operation does not strand the ownership gate', async () => {
    const ordered = createPhoneHostAuthGate()
    await expect(ordered(async () => { throw new Error('offline') })).rejects.toThrow('offline')
    await expect(ordered(async () => 'ready')).resolves.toBe('ready')
  })

  it('uses the host session on boot and never asks the SDK to refresh it', async () => {
    const session = { access_token: 'new', refresh_token: 'rotated', user: { id: 'owner' } } as Session
    native.authSession.mockResolvedValueOnce({ available: true, session })
    const fallback = vi.fn()
    await expect(phoneHostGetSession(fallback)).resolves.toEqual({ data: { session }, error: null })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not fall back to a competing refresher when an active host fails', async () => {
    native.authSession.mockRejectedValueOnce(new Error('host offline'))
    const fallback = vi.fn()
    await expect(phoneHostRefreshSession('old', fallback)).rejects.toThrow('host offline')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back only when no native host owns the session', async () => {
    native.authSession.mockResolvedValueOnce({ available: false, session: null })
    const fallback = vi.fn(async () => ({ data: { session: null }, error: null }))
    await phoneHostGetSession(fallback)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('returns the actual rotated session revoked by sign-out for exact storage cleanup', async () => {
    const session = { access_token: 'latest', refresh_token: 'latest-rotation', user: { id: 'owner' } } as Session
    native.authSession.mockResolvedValueOnce({ available: true, session, signedOut: true })
    const fallback = vi.fn()
    await expect(phoneHostSignOut(fallback)).resolves.toEqual({ error: null, signedOutSession: session })
    expect(fallback).not.toHaveBeenCalled()
  })
})
