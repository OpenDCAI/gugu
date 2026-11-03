import { describe, expect, it } from 'vitest'
import { createUpdateState, createUpdateStateReceiver } from '../../../../apps/desktop/shared/update-state'

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
