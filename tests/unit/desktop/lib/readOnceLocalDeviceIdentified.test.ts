import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalDeviceUnidentifiedError,
  readOnceLocalDeviceIdentified,
} from '../../../../apps/desktop/src/lib/localDeviceIdentity'

function identityAnnouncer() {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    announce: () => { for (const listener of [...listeners]) listener() },
    get listening() { return listeners.size },
  }
}

afterEach(() => { vi.useRealTimers() })

// #627: readers that only ask "is that device online?" in the first seconds after start wait for this computer to be
// identified instead of failing the action that asked.
describe('readOnceLocalDeviceIdentified', () => {
  it('returns the first read when this computer is already identified', async () => {
    const announcer = identityAnnouncer()
    await expect(readOnceLocalDeviceIdentified(async () => 'rows', announcer.subscribe)).resolves.toBe('rows')
    expect(announcer.listening).toBe(0)
  })

  it('waits for the identification and reads again', async () => {
    const announcer = identityAnnouncer()
    let identified = false
    const read = vi.fn(async () => { if (!identified) throw new LocalDeviceUnidentifiedError(); return 'rows' })
    const result = readOnceLocalDeviceIdentified(read, announcer.subscribe)
    await vi.waitFor(() => expect(announcer.listening).toBe(1))
    identified = true
    announcer.announce()
    await expect(result).resolves.toBe('rows')
    expect(announcer.listening).toBe(0)
  })

  it('does not miss an identification that lands before it subscribes', async () => {
    const announcer = identityAnnouncer()
    let reads = 0
    const read = async () => { reads += 1; if (reads === 1) throw new LocalDeviceUnidentifiedError(); return 'rows' }
    await expect(readOnceLocalDeviceIdentified(read, announcer.subscribe)).resolves.toBe('rows')
    expect(announcer.listening).toBe(0)
  })

  it('gives up with the unidentified error itself when nobody identifies this computer in time', async () => {
    vi.useFakeTimers()
    const announcer = identityAnnouncer()
    const result = readOnceLocalDeviceIdentified(async () => { throw new LocalDeviceUnidentifiedError() }, announcer.subscribe, 1_000)
    const settled = expect(result).rejects.toBeInstanceOf(LocalDeviceUnidentifiedError)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
    expect(announcer.listening).toBe(0)
  })

  it('passes any other failure straight through', async () => {
    const announcer = identityAnnouncer()
    await expect(readOnceLocalDeviceIdentified(async () => { throw new Error('network down') }, announcer.subscribe)).rejects.toThrow('network down')
    expect(announcer.listening).toBe(0)
  })
})
