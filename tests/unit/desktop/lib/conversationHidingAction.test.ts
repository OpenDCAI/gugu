import { describe, expect, it, vi } from 'vitest'
import { runConversationHidingAction } from '../../../../apps/desktop/src/lib/conversationHidingAction'
import { conversationCanHide, conversationRowMenu } from '../../../../apps/desktop/src/session/shared/conversation-row-menu'

describe('shared personal hiding action', () => {
  it('allows every conversation kind without group authority and labels the personal action', () => {
    for (const kind of ['dm', 'ai', 'group', 'topic']) expect(conversationCanHide(kind)).toBe(true)
    expect(conversationCanHide(null)).toBe(false)
    expect(conversationRowMenu({ kind: 'chat', personalHiding: true, canDelete: true, hasUnread: false }).at(-1)?.label).toBe('removeFromList')
  })
  it('only hides when Agent removal is unchecked', async () => {
    const hide = vi.fn().mockResolvedValue(undefined)
    await runConversationHidingAction({ hide, removalFailed: vi.fn() })
    expect(hide).toHaveBeenCalledTimes(1)
  })
  it('keeps a successful hide after removal fails; retry only removes the Agent', async () => {
    const hide = vi.fn().mockResolvedValue(undefined)
    const removeAgent = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const removalFailed = vi.fn()
    await runConversationHidingAction({ hide, removeAgent, removalFailed })
    expect(removalFailed).toHaveBeenCalledTimes(1)
    await removalFailed.mock.calls[0][1]()
    expect(hide).toHaveBeenCalledTimes(1)
    expect(removeAgent).toHaveBeenCalledTimes(2)
  })
  it('does not remove the Agent when hiding fails or the account changes', async () => {
    const removeAgent = vi.fn()
    await expect(runConversationHidingAction({ hide: vi.fn().mockRejectedValue(new Error('hide failed')), removeAgent, removalFailed: vi.fn() })).rejects.toThrow('hide failed')
    await runConversationHidingAction({ hide: vi.fn().mockResolvedValue(undefined), removeAgent, isCurrent: () => false, removalFailed: vi.fn() })
    expect(removeAgent).not.toHaveBeenCalled()
  })
})
