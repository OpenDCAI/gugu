// A row that may have been replaced (owner 10-28): an offline row, and an online one of the same host name and kind that
// came later and was seen later, on another machine. Two machines may share a name: a hint only, never a removal.
import { describe, expect, test } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { supersededBy } from '../../../../apps/desktop/src/lib/deviceSuperseded'

const server = (id: string, more: Partial<Device> = {}): Device => ({
  device_id: id, label: id, hostname: 'di-host', platform: 'linux', status: 'online', is_online: true,
  last_seen_at: '2026-10-28T12:00:00Z', created_at: '2026-10-28T10:00:00Z', machine_id: `m-${id}`,
  capabilities: { terminals: [], runtimes: [], host_kind: 'server' } as Device['capabilities'], ...more,
})
const off = (more: Partial<Device> = {}): Partial<Device> => ({ status: 'offline', is_online: false, last_seen_at: '2026-10-27T09:00:00Z', ...more })
const of = (devices: Device[]) => Object.fromEntries([...supersededBy(devices)].map(([id, by]) => [id, by.device_id]))

describe('a row that may have been replaced', () => {
  test('the old home offline, the new one online, same host name and kind, the new one later: marked', () => {
    expect(of([server('old', off({ created_at: '2026-09-01T00:00:00Z' })), server('new')])).toEqual({ old: 'new' })
  })

  test('the host name is the same whatever its case or spaces', () => {
    expect(of([server('old', off({ hostname: ' DI-Host ', created_at: '2026-09-01T00:00:00Z' })), server('new')])).toEqual({ old: 'new' })
  })

  test('not when the online one appeared first: a long-running machine now off, and a newer one that only shares its name, are two', () => {
    expect(of([server('old', off({ created_at: '2026-10-28T11:00:00Z' })), server('new', { created_at: '2026-10-01T00:00:00Z' })])).toEqual({})
  })

  test('not when the online one was not seen later, nor for both online, nor for the same machine', () => {
    expect(of([server('old', off({ created_at: '2026-09-01T00:00:00Z', last_seen_at: '2026-10-28T13:00:00Z' })), server('new')])).toEqual({})
    expect(of([server('a', { created_at: '2026-09-01T00:00:00Z' }), server('b')]), 'both online').toEqual({})
    expect(of([server('old', off({ created_at: '2026-09-01T00:00:00Z', machine_id: 'm-new' })), server('new')]), 'one machine, two configurations').toEqual({})
  })

  test('not across kinds: a desktop and a server on one computer share a host name', () => {
    const desktop = server('desk', { capabilities: { terminals: [], runtimes: [] } as Device['capabilities'] })
    expect(of([server('srv', off({ created_at: '2026-09-01T00:00:00Z' })), desktop])).toEqual({})
    expect(of([{ ...desktop, ...off({ created_at: '2026-09-01T00:00:00Z' }) } as Device, server('srv')])).toEqual({})
  })

  test('without when it appeared (an old cache, a stub) nothing is said; with several newer, the newest', () => {
    expect(of([server('old', off({ created_at: undefined })), server('new')])).toEqual({})
    expect(of([server('old', off({ created_at: '2026-09-01T00:00:00Z' })), server('mid', { created_at: '2026-10-01T00:00:00Z' }), server('new')])).toEqual({ old: 'new' })
  })
})
