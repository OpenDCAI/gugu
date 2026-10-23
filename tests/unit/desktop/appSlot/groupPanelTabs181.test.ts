// gugu-dev#181 第 ⑥ 步:群右栏从「一个槽」变成「开着的一串 + 正看着的那一枚」。右栏(GroupAppSlot)照旧只画正看着的那一枚 ——
// opened() 的意思没变,对话页、手机看起来和以前一样;块的页签条按 tabs() 列出开着的几枚。
import { describe, expect, it } from 'vitest'
import { groupSlotMemory, type OpenedWith } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'

const board: OpenedWith = { kind: 'kanban.board', title: 'Board', opening: 1 }
const deck: OpenedWith = { kind: 'slides.main', itemId: 'deck', typedName: 'deck.pptx', title: 'deck.pptx', opening: 2 }

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
