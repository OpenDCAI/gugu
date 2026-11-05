import { expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { messageActionItems, messageSelectionActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'
import { MessageSquare, Reply } from '../../../../apps/desktop/src/lib/icons'
// Opt-in contract for the follow-up rollout; production defaults are covered separately.
vi.mock('../../../../apps/desktop/src/lib/messageQuoteRollout', () => ({ SELECTED_MESSAGE_QUOTES_ENABLED: true }))
const t = ((key: string) => key) as TFunction<'messaging'>
it('keeps the existing capabilities, with Reply quoting the range that is already selected', () => {
  const whole = vi.fn(), selected = vi.fn(), keep = vi.fn()
  const target = { isRetracted: false, content: 'Alpha Beta', onReply: whole, onQuoteSelection: selected, onCopy: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), onSelect: vi.fn(), onOpenTopic: vi.fn(), onKeep: keep }
  const old = messageActionItems({ ...target, onQuoteSelection: undefined }, t)
  const native = messageSelectionActionItems(target, t)
  expect(native.map(item => [item.key, item.disabled])).toEqual(old.map(item => [item.key, item.disabled]))
  native.find(item => item.key === 'reply')!.onSelect!()
  expect(selected).toHaveBeenCalledOnce(); expect(whole).not.toHaveBeenCalled()
  native.find(item => item.key === 'keep-temporary')!.onSelect!()
  native.find(item => item.key === 'keep-permanent')!.onSelect!()
  expect(keep.mock.calls).toEqual([['temporary'], ['permanent']])
})
it('retains deletion for received messages and does not invent missing capabilities', () => {
  const items = messageSelectionActionItems({ isRetracted: true, content: 'Alpha', onDelete: vi.fn() }, t)
  expect(items.map(item => item.key)).toEqual(['delete'])
  expect(items[0].disabled).toBeUndefined()
})
it('offers the existing reaction picker from a selected message and respects retraction', () => {
  const onShowReactions = vi.fn()
  const target = { isRetracted: false, content: 'Beta', onShowReactions }
  const action = messageSelectionActionItems(target, t).find(item => item.key === 'react')
  expect(action?.label).toBe('message.actions.react')
  action!.onSelect!()
  expect(onShowReactions).toHaveBeenCalledOnce()
  expect(messageSelectionActionItems({ ...target, isRetracted: true }, t).find(item => item.key === 'react')?.disabled).toBe(true)
})
it('marks Open a topic with the topic icon, not the Reply arrow', () => {
  const items = messageActionItems({ isRetracted: false, content: 'Alpha', onReply: vi.fn(), onOpenTopic: vi.fn() }, t)
  expect(items.find(item => item.key === 'reply')?.icon).toBe(Reply)
  expect(items.find(item => item.key === 'openTopic')?.icon).toBe(MessageSquare)
})
