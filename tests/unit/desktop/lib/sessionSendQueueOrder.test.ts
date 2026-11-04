import { expect, it } from 'vitest'
import { sessionSendQueueOrder } from '@/lib/sessionSendQueueOrder'

it('preserves both owners and their execution slots while allowing same-owner drag ordering', () => {
  const current = ['old-a', 'old-b', 'held-a', 'held-b']
  const local = new Set(['held-a', 'held-b'])
  expect(sessionSendQueueOrder(current, local, ['old-b', 'old-a', 'held-a', 'held-b']))
    .toEqual({ host: ['old-b', 'old-a'], local: ['held-a', 'held-b'] })
  expect(sessionSendQueueOrder(current, local, ['old-a', 'old-b', 'held-b', 'held-a']))
    .toEqual({ host: ['old-a', 'old-b'], local: ['held-b', 'held-a'] })
  expect(sessionSendQueueOrder(current, local, ['old-a', 'held-a', 'old-b', 'held-b'])).toBeNull()
  expect(sessionSendQueueOrder(current, local, ['old-a', 'old-b', 'held-a', 'held-a'])).toBeNull()
})

it('retains the normal all-local and legacy-only queue operations', () => {
  expect(sessionSendQueueOrder(['a', 'b'], new Set(['a', 'b']), ['b', 'a'])).toEqual({ local: ['b', 'a'], host: [] })
  expect(sessionSendQueueOrder(['a', 'b'], new Set(), ['b', 'a'])).toEqual({ local: [], host: ['b', 'a'] })
})
