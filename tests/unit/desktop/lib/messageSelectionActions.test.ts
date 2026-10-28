import { expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { messageActionItems, messageSelectionActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'
const t = ((key: string) => key) as TFunction<'messaging'>
it('keeps the existing capabilities, with Reply quoting the range that is already selected', () => {
  const whole = vi.fn(), selected = vi.fn()
  const target = { isRetracted: false, content: 'Alpha Beta', onReply: whole, onQuoteSelection: selected, onCopy: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), onSelect: vi.fn(), onOpenTopic: vi.fn() }
  const old = messageActionItems({ ...target, onQuoteSelection: undefined }, t)
  const native = messageSelectionActionItems(target, t)
  expect(native.map(item => [item.key, item.disabled])).toEqual(old.map(item => [item.key, item.disabled]))
  native.find(item => item.key === 'reply')!.onSelect!()
  expect(selected).toHaveBeenCalledOnce(); expect(whole).not.toHaveBeenCalled()
})
it('retains deletion for received messages and does not invent missing capabilities', () => {
  const items = messageSelectionActionItems({ isRetracted: true, content: 'Alpha', onDelete: vi.fn() }, t)
  expect(items.map(item => item.key)).toEqual(['delete'])
  expect(items[0].disabled).toBeUndefined()
})
