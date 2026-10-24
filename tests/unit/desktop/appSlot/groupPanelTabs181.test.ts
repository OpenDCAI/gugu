// gugu-dev#181 第 ⑥ 步:群右栏从「一个槽」变成「开着的一串 + 正看着的那一枚」。右栏(GroupAppSlot)照旧只画正看着的那一枚 ——
// opened() 的意思没变,对话页、手机看起来和以前一样;块的页签条按 tabs() 列出开着的几枚。
import { describe, expect, it, vi } from 'vitest'
import { groupSlotMemory, type OpenedWith } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'

const board: OpenedWith = { kind: 'kanban.board', title: 'Board', opening: 1 }
const deck: OpenedWith = { kind: 'slides.main', itemId: 'deck', typedName: 'deck.pptx', title: 'deck.pptx', opening: 2 }

describe('leaving an object tab', () => {
  const file = (id: string): OpenedWith => ({ kind: 'workspace.main', itemId: id, title: `${id}.md`, opening: Number(id) })

  it('Back removes the file and returns to the folder in one notification', () => {
    const item = file('101')
    groupSlotMemory.setOpened('exit-folder', item)
    const changed = vi.fn()
    const off = groupSlotMemory.subscribe(changed)
    groupSlotMemory.close('exit-folder', item)
    off()
    expect(groupSlotMemory.tabs('exit-folder')).toEqual([null])
    expect(groupSlotMemory.opened('exit-folder')).toBeNull()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps the App source after switching tabs and does not revive a source closed by the user', () => {
    const app: OpenedWith = { kind: 'board.main', title: 'Board', opening: 102 }
    const first = file('103')
    const second = file('104')
    groupSlotMemory.setOpened('exit-source', app)
    groupSlotMemory.setOpened('exit-source', first)
    groupSlotMemory.setOpened('exit-source', second)
    groupSlotMemory.activate('exit-source', app)
    groupSlotMemory.activate('exit-source', second)
    groupSlotMemory.close('exit-source', second)
    expect(groupSlotMemory.opened('exit-source')).toBe(first)
    groupSlotMemory.close('exit-source', app)
    groupSlotMemory.close('exit-source', first)
    expect(groupSlotMemory.tabs('exit-source')).toEqual([null])
  })

  it('reopening the same file retains its source rather than adding itself to the trail', () => {
    const first = file('105')
    groupSlotMemory.setOpened('exit-reopen', first)
    const again = { ...first, opening: 106 }
    groupSlotMemory.setOpened('exit-reopen', again)
    expect(again.trail).toEqual([])
    groupSlotMemory.close('exit-reopen', again)
    expect(groupSlotMemory.tabs('exit-reopen')).toEqual([null])
  })

  it('Close removes a message file before closing the panel and restoring the message', () => {
    const order: string[] = []
    const item = { ...file('107'), restore: () => {
      expect(groupSlotMemory.tabs('exit-message')).not.toContain(item)
      order.push('message')
    } }
    groupSlotMemory.setOpened('exit-message', item)
    groupSlotMemory.close('exit-message', item, () => order.push('panel'))
    expect(order).toEqual(['panel', 'message'])
  })

  it('closing one preview leaves another item open and does not close the whole panel', () => {
    const preview = { ...file('108'), kind: null }
    const other = file('109')
    groupSlotMemory.setOpened('exit-preview', other)
    groupSlotMemory.setOpened('exit-preview', preview)
    const closePanel = vi.fn()
    groupSlotMemory.close('exit-preview', preview, closePanel)
    expect(groupSlotMemory.opened('exit-preview')).toBe(other)
    expect(groupSlotMemory.tabs('exit-preview')).toEqual([null, other])
    expect(closePanel).not.toHaveBeenCalled()
  })

  it('closing an inactive App opened over the chat keeps the current object visible', () => {
    const source: OpenedWith = { kind: 'board.main', title: 'Board', opening: 110, fromChat: true }
    const shown = file('111')
    groupSlotMemory.setOpened('exit-inactive-source', source)
    groupSlotMemory.setOpened('exit-inactive-source', shown)
    const closePanel = vi.fn()
    groupSlotMemory.close('exit-inactive-source', source, closePanel)
    expect(groupSlotMemory.opened('exit-inactive-source')).toBe(shown)
    expect(closePanel).not.toHaveBeenCalled()
  })
})

describe('the group panel keeps what is open and shows one of it', () => {
  it('opening another keeps the one shown before as a tab; the panel shows only the newest', () => {
    groupSlotMemory.setForm('tabs-1', 'side')
    expect(groupSlotMemory.tabs('tabs-1'), 'nothing opened yet: the folder alone').toEqual([null])
    groupSlotMemory.setOpened('tabs-1', board)
    groupSlotMemory.setOpened('tabs-1', deck)
    expect(groupSlotMemory.opened('tabs-1')).toBe(deck)
    expect(groupSlotMemory.tabs('tabs-1')).toEqual([null, board, deck])
    // Back to the folder (the panel's 「返回」 at the end of its trail): what it shows is the folder, as before.
    groupSlotMemory.setOpened('tabs-1', null)
    expect(groupSlotMemory.opened('tabs-1')).toBeNull()
    expect(groupSlotMemory.tabs('tabs-1')).toEqual([null, board, deck])
  })

  it('the same App page opened again is the same tab, opened anew', () => {
    groupSlotMemory.setForm('tabs-2', 'side')
    groupSlotMemory.setOpened('tabs-2', board)
    const again = { ...board, opening: 9 }
    groupSlotMemory.setOpened('tabs-2', again)
    expect(groupSlotMemory.tabs('tabs-2')).toEqual([null, again])
    expect(groupSlotMemory.opened('tabs-2')).toBe(again)
  })

  it('a tab picked is what the panel shows', () => {
    groupSlotMemory.setForm('tabs-3', 'side')
    groupSlotMemory.setOpened('tabs-3', board)
    groupSlotMemory.setOpened('tabs-3', deck)
    groupSlotMemory.activate('tabs-3', board)
    expect(groupSlotMemory.opened('tabs-3')).toBe(board)
    groupSlotMemory.activate('tabs-3', null)
    expect(groupSlotMemory.opened('tabs-3')).toBeNull()
  })

  it('closing the shown tab shows its neighbour; closing the last closes the panel', () => {
    groupSlotMemory.setForm('tabs-4', 'full')
    groupSlotMemory.setOpened('tabs-4', board)
    groupSlotMemory.setOpened('tabs-4', deck)
    groupSlotMemory.close('tabs-4', deck)
    expect(groupSlotMemory.opened('tabs-4')).toBe(board)
    groupSlotMemory.close('tabs-4', null)
    expect(groupSlotMemory.tabs('tabs-4')).toEqual([board])
    expect(groupSlotMemory.form('tabs-4')).toBe('full')
    groupSlotMemory.close('tabs-4', board)
    expect(groupSlotMemory.tabs('tabs-4')).toEqual([])
    expect(groupSlotMemory.form('tabs-4')).toBe('closed')
    expect(groupSlotMemory.opened('tabs-4')).toBeNull()
  })

  it('a panel that never came up lists no tabs; the folder picked from「+」opens it and stays a tab', () => {
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([])
    groupSlotMemory.activate('tabs-5', null)
    expect(groupSlotMemory.form('tabs-5')).toBe('side')
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([null])
    groupSlotMemory.setForm('tabs-5', 'closed')
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([null])
  })

  it('a panel that came up on the folder alone keeps the folder as a tab when it gives way', () => {
    groupSlotMemory.setForm('tabs-8', 'side')
    groupSlotMemory.noteShown('tabs-8')
    groupSlotMemory.setForm('tabs-8', 'closed')
    expect(groupSlotMemory.tabs('tabs-8')).toEqual([null])
    groupSlotMemory.close('tabs-8', null)
    expect(groupSlotMemory.tabs('tabs-8'), 'its × lets it go').toEqual([])
  })

  it('the right side giving way (#1312: a topic, the chat alone) keeps what the panel has open as tabs', () => {
    groupSlotMemory.setForm('tabs-6', 'side')
    groupSlotMemory.setOpened('tabs-6', board)
    groupSlotMemory.setForm('tabs-6', 'closed')
    expect(groupSlotMemory.tabs('tabs-6'), 'not shown, still open').toEqual([null, board])
    expect(groupSlotMemory.opened('tabs-6'), 'and it comes back on the one it showed').toBe(board)
  })

  it('the topic beside the group stays a tab while the panel has the right side; only its × lets it go', () => {
    groupSlotMemory.showTopic('tabs-7', { chatId: 'topic-a', name: 'A' })
    expect(groupSlotMemory.topic('tabs-7')).toEqual({ chatId: 'topic-a', name: 'A', shown: true })
    groupSlotMemory.setOpened('tabs-7', board)
    groupSlotMemory.showTopic('tabs-7', null)
    expect(groupSlotMemory.topic('tabs-7'), 'the panel came up: the topic is a tab, not shown').toEqual({ chatId: 'topic-a', name: 'A', shown: false })
    expect(groupSlotMemory.tabs('tabs-7'), 'its things too').toEqual([null, board])
    groupSlotMemory.showTopic('tabs-7', { chatId: 'topic-b', name: 'B' })
    expect(groupSlotMemory.topic('tabs-7'), 'another topic opened beside the group takes its place').toEqual({ chatId: 'topic-b', name: 'B', shown: true })
    groupSlotMemory.closeTopic('topic-b')
    expect(groupSlotMemory.topic('tabs-7')).toBeNull()
    expect(groupSlotMemory.tabs('tabs-7'), 'the panel\'s tabs stay').toEqual([null, board])
  })
})
