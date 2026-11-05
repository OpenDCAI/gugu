import { describe, expect, it } from 'vitest'
import { createUpdateState, createUpdateStateReceiver } from '../../../../apps/desktop/shared/update-state'
import { createUpdateChecks } from '../../../../apps/desktop/electron/update-check'

describe('#1342 host update revisions', () => {
  it('increments for every published state and preserves the revision of a captured reply', () => {
    const host = createUpdateState({ status: 'idle', percent: undefined as number | undefined })
    expect(host.current.revision).toBe(0)
    const reply = host.publish({ status: 'downloaded', percent: undefined })!
    expect(reply.revision).toBe(1)
    expect(host.publish({ status: 'downloading', percent: 12.3 })?.revision).toBe(2)
    expect(host.publish({ status: 'downloading', percent: 78.9 })?.revision).toBe(3)
    expect(reply).toEqual({ status: 'downloaded', percent: undefined, revision: 1 })
    expect(host.current.percent).toBe(78.9)
  })

  it('does not allocate a revision to a state the host does not publish', () => {
    const host = createUpdateState({ status: 'downloaded' })
    expect(host.publish({ status: 'not-available' })).toBeNull()
    expect(host.current).toEqual({ status: 'downloaded', revision: 0 })
  })

  it('accepts strictly higher revisions, including a live event before an older snapshot', () => {
    const receive = createUpdateStateReceiver()
    expect(receive({ revision: 0 })).toBe(true)
    expect(receive({ revision: 3 })).toBe(true)
    expect(receive({ revision: 1 })).toBe(false)
    expect(receive({ revision: 3 })).toBe(false)
    expect(receive({ revision: 4 })).toBe(true)
  })

  it.each([undefined, null, {}, { revision: -1 }, { revision: NaN }, { revision: '3' }])(
    'does not treat an unstamped or invalid state as newer: %s', (state) => {
      expect(createUpdateStateReceiver()(state)).toBe(false)
    },
  )
})

// The checks main wires into the updates:check RPC and the automatic timers (update-check.ts), with the feed
// offline. Unhandled rejections are observed on the real process, as a detached one would surface.
async function actualCheckOutcome(mode: 'automatic' | 'manual') {
  const offline = new Error('Network offline'), warnings: unknown[][] = [], unhandled: string[] = [], timers: Array<() => void> = []
  const originalState = { revision: 7, status: 'downloading', percent: 42 }
  const onUnhandled = (error: unknown) => { unhandled.push((error as Error).message) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const checks = createUpdateChecks({
      policy: () => ({ enabled: true as const }),
      blocked: () => { throw new Error('A failed query must not publish state') },
      query: () => Promise.reject(offline),
      current: () => originalState,
      warn: (...args) => { warnings.push(args) },
      automatic: true,
      setTimeout: (callback) => timers.push(callback), setInterval: (callback) => timers.push(callback),
    })
    let rejectedWithOriginalError = false
    let state: unknown = originalState
    if (mode === 'automatic') {
      checks.startAutomatic()
      for (const callback of timers) callback()
      await new Promise(setImmediate)
      await new Promise(setImmediate)
    } else {
      try { state = await checks.check() } catch (error) { rejectedWithOriginalError = error === offline }
    }
    return { timerCount: timers.length, warnings, unhandled, rejectedWithOriginalError, stateUnchanged: state === originalState }
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

describe('#1342 actual update check entry points', () => {
  it('both automatic timers warn on network failure without an unhandled rejection or state change', async () => {
    const outcome = await actualCheckOutcome('automatic')
    expect(outcome.timerCount).toBe(2)
    expect(outcome.warnings).toEqual([
      ['[updater] check failed:', 'Network offline'],
      ['[updater] check failed:', 'Network offline'],
    ])
    expect(outcome.unhandled).toEqual([])
    expect(outcome.stateUnchanged).toBe(true)
  })

  it('manual RPC still rejects with the original network error and preserves live progress', async () => {
    const outcome = await actualCheckOutcome('manual')
    expect(outcome.rejectedWithOriginalError).toBe(true)
    expect(outcome.warnings).toEqual([['[updater] check failed:', 'Network offline']])
    expect(outcome.unhandled).toEqual([])
    expect(outcome.stateUnchanged).toBe(true)
  })
})
