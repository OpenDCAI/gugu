import { describe, expect, it, vi } from 'vitest'
import { messageActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'

const t = ((key: string) => key) as never

describe('临时 / 一直保留 in a message\'s actions', () => {
  it('offers both for the sender\'s own attachment and hands back which one was picked', () => {
    const onKeep = vi.fn()
    const items = messageActionItems({ isRetracted: false, content: null, onKeep }, t)
    expect(items.map((item) => item.key)).toEqual(expect.arrayContaining(['keep-temporary', 'keep-permanent']))
    items.find((item) => item.key === 'keep-temporary')!.onSelect!()
    items.find((item) => item.key === 'keep-permanent')!.onSelect!()
    expect(onKeep.mock.calls).toEqual([['temporary'], ['permanent']])
  })
  it('offers neither without a handler (someone else\'s message, or no cloud copy)', () => {
    expect(messageActionItems({ isRetracted: false, content: null }, t).some((item) => item.key.startsWith('keep-'))).toBe(false)
  })
})
