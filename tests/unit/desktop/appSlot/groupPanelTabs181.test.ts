// gugu-dev#181 第 ⑥ 步:群右栏从「一个槽」变成「开着的一串 + 正看着的那一枚」。右栏(GroupAppSlot)只画正看着的那一枚,
// 块的页签条按 tabs() 列出开着的几枚。owner 10-24:右栏没有「底」—— 群文件夹是普通的一枚,人打开它才有;一个 App 的一份
// 资源只有一枚,怎么打开的只决定它的「上一页」(from)。
import { describe, expect, it, vi } from 'vitest'
import { folderTab, groupSlotMemory, isFolder, type OpenedWith } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'

const board: OpenedWith = { kind: 'kanban.board', title: 'Board', opening: 1 }
const deck: OpenedWith = { kind: 'slides.main', itemId: 'deck', typedName: 'deck.pptx', title: 'deck.pptx', opening: 2 }

describe('leaving a tab', () => {
  const file = (id: string, from?: OpenedWith): OpenedWith => ({ kind: 'workspace.main', itemId: id, title: `${id}.md`, opening: Number(id), ...(from ? { from } : {}) })

  it('Back on a file opened from the folder goes back to the folder, in one notification', () => {
    const folder = folderTab()
    groupSlotMemory.open('exit-folder', folder)
    const item = file('101', folder)
    groupSlotMemory.open('exit-folder', item)
    const changed = vi.fn()
    const off = groupSlotMemory.subscribe(changed)
    groupSlotMemory.close('exit-folder', item)
    off()
    expect(groupSlotMemory.tabs('exit-folder')).toEqual([folder])
    expect(groupSlotMemory.opened('exit-folder')).toBe(folder)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps its 上一页 after switching tabs, and does not revive one the person closed', () => {
    const app: OpenedWith = { kind: 'board.main', title: 'Board', opening: 102 }
    groupSlotMemory.open('exit-source', app)
    const first = file('103', app)
    groupSlotMemory.open('exit-source', first)
    const second = file('104', first)
    groupSlotMemory.open('exit-source', second)
    groupSlotMemory.activate('exit-source', app)
    groupSlotMemory.activate('exit-source', second)
    groupSlotMemory.close('exit-source', second)
    expect(groupSlotMemory.opened('exit-source')).toBe(first)
    groupSlotMemory.close('exit-source', app)
    groupSlotMemory.close('exit-source', first)
    expect(groupSlotMemory.tabs('exit-source'), 'nothing open: the panel has no floor').toEqual([])
    expect(groupSlotMemory.opened('exit-source')).toBeNull()
    expect(groupSlotMemory.form('exit-source')).toBe('closed')
  })

  it('opened again from a page it gains that page as its 上一页; opened again straight from the chat it keeps it', () => {
    const direct = file('105')
    groupSlotMemory.open('exit-reopen', direct)
    const folder = folderTab()
    groupSlotMemory.open('exit-reopen', folder)
    groupSlotMemory.open('exit-reopen', { ...direct, opening: 106, from: folder })
    expect(groupSlotMemory.tabs('exit-reopen').map((item) => item.itemId ?? 'folder'), 'still one tab of 105').toEqual(['105', 'folder'])
    const shown = groupSlotMemory.opened('exit-reopen')!
    expect(shown.opening, 'its page kept').toBe(105)
    expect(shown.from).toBe(folder)
    groupSlotMemory.open('exit-reopen', { ...direct, opening: 107 })
    expect(groupSlotMemory.opened('exit-reopen')?.from).toBe(folder)
    groupSlotMemory.close('exit-reopen', direct)
    expect(groupSlotMemory.opened('exit-reopen')).toBe(folder)
  })

  it('Close removes a message file before closing the panel and restoring the message', () => {
    const order: string[] = []
    const item = { ...file('107'), restore: () => {
      expect(groupSlotMemory.tabs('exit-message')).not.toContain(item)
      order.push('message')
    } }
    groupSlotMemory.open('exit-message', item)
    groupSlotMemory.close('exit-message', item, () => order.push('panel'))
    expect(order).toEqual(['panel', 'message'])
  })

  it('closing one preview leaves another item open and does not close the whole panel', () => {
    const preview = { ...file('108'), kind: null }
    const other = file('109')
    groupSlotMemory.open('exit-preview', other)
    groupSlotMemory.open('exit-preview', preview)
    const closePanel = vi.fn()
    groupSlotMemory.close('exit-preview', preview, closePanel)
    expect(groupSlotMemory.opened('exit-preview')).toBe(other)
    expect(groupSlotMemory.tabs('exit-preview')).toEqual([other])
    expect(closePanel).not.toHaveBeenCalled()
  })

  it('closing a tab not shown keeps the one shown', () => {
    const source: OpenedWith = { kind: 'board.main', title: 'Board', opening: 110 }
    const shown = file('111', source)
    groupSlotMemory.open('exit-inactive-source', source)
    groupSlotMemory.open('exit-inactive-source', shown)
    const closePanel = vi.fn()
    groupSlotMemory.close('exit-inactive-source', source, closePanel)
    expect(groupSlotMemory.opened('exit-inactive-source')).toBe(shown)
    expect(closePanel).not.toHaveBeenCalled()
  })
})

describe('the group panel keeps what is open and shows one of it', () => {
  it('nothing opened is no tab; opening another keeps the one shown before as a tab', () => {
    groupSlotMemory.setForm('tabs-1', 'side')
    expect(groupSlotMemory.tabs('tabs-1'), 'the folder is not a floor under the tabs').toEqual([])
    groupSlotMemory.open('tabs-1', board)
    groupSlotMemory.open('tabs-1', deck)
    expect(groupSlotMemory.opened('tabs-1')).toBe(deck)
    expect(groupSlotMemory.tabs('tabs-1')).toEqual([board, deck])
  })

  it('the same App page opened again is the same tab, its page kept', () => {
    groupSlotMemory.setForm('tabs-2', 'side')
    groupSlotMemory.open('tabs-2', board)
    groupSlotMemory.open('tabs-2', deck)
    groupSlotMemory.open('tabs-2', { ...board, opening: 9 })
    expect(groupSlotMemory.tabs('tabs-2')).toEqual([board, deck])
    expect(groupSlotMemory.opened('tabs-2')).toBe(board)
  })

  it("one App's one file is one tab through any of its tabs (owner 10-24); another App on it is another tab", () => {
    const asApp: OpenedWith = { kind: 'kanban.file', itemId: 'B', title: '协作看板', opening: 21 }
    groupSlotMemory.open('tabs-9', asApp)
    groupSlotMemory.open('tabs-9', { kind: 'kanban.board', itemId: 'B', title: '协作看板', opening: 22 })
    expect(groupSlotMemory.tabs('tabs-9')).toEqual([asApp])
    groupSlotMemory.open('tabs-9', { kind: 'workspace.main', itemId: 'B', title: '协作看板.board', opening: 23 })
    expect(groupSlotMemory.tabs('tabs-9').map((item) => item.kind)).toEqual(['kanban.file', 'workspace.main'])
  })

  it('a tab picked is what the panel shows', () => {
    groupSlotMemory.setForm('tabs-3', 'side')
    groupSlotMemory.open('tabs-3', board)
    groupSlotMemory.open('tabs-3', deck)
    groupSlotMemory.activate('tabs-3', board)
    expect(groupSlotMemory.opened('tabs-3')).toBe(board)
  })

  it('closing the shown tab shows its neighbour; closing the last closes the panel', () => {
    groupSlotMemory.setForm('tabs-4', 'full')
    groupSlotMemory.open('tabs-4', board)
    groupSlotMemory.open('tabs-4', deck)
    groupSlotMemory.close('tabs-4', deck)
    expect(groupSlotMemory.opened('tabs-4')).toBe(board)
    expect(groupSlotMemory.form('tabs-4')).toBe('full')
    groupSlotMemory.close('tabs-4', board)
    expect(groupSlotMemory.tabs('tabs-4')).toEqual([])
    expect(groupSlotMemory.form('tabs-4')).toBe('closed')
    expect(groupSlotMemory.opened('tabs-4')).toBeNull()
  })

  it('the folder is a tab only once it is opened, opened again it is the same one, and its × lets it go', () => {
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([])
    const folder = folderTab()
    groupSlotMemory.open('tabs-5', folder)
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([folder])
    expect(isFolder(groupSlotMemory.opened('tabs-5'))).toBe(true)
    groupSlotMemory.open('tabs-5', board)
    groupSlotMemory.open('tabs-5', folderTab())
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([folder, board])
    expect(groupSlotMemory.opened('tabs-5'), 'its page kept: the subfolder it is in stays').toBe(folder)
    groupSlotMemory.close('tabs-5', folder)
    expect(groupSlotMemory.tabs('tabs-5')).toEqual([board])
  })

  it('the right side giving way (#1312: a topic, the chat alone) keeps what the panel has open as tabs', () => {
    groupSlotMemory.setForm('tabs-6', 'side')
    groupSlotMemory.open('tabs-6', board)
    groupSlotMemory.setForm('tabs-6', 'closed')
    expect(groupSlotMemory.tabs('tabs-6'), 'not shown, still open').toEqual([board])
    expect(groupSlotMemory.opened('tabs-6'), 'and it comes back on the one it showed').toBe(board)
  })

  it('the topic beside the group stays a tab while the panel has the right side; only its × lets it go', () => {
    groupSlotMemory.showTopic('tabs-7', { chatId: 'topic-a', name: 'A' })
    expect(groupSlotMemory.topic('tabs-7')).toEqual({ chatId: 'topic-a', name: 'A', shown: true })
    groupSlotMemory.open('tabs-7', board)
    groupSlotMemory.showTopic('tabs-7', null)
    expect(groupSlotMemory.topic('tabs-7'), 'the panel came up: the topic is a tab, not shown').toEqual({ chatId: 'topic-a', name: 'A', shown: false })
    expect(groupSlotMemory.tabs('tabs-7'), 'its things too').toEqual([board])
    groupSlotMemory.showTopic('tabs-7', { chatId: 'topic-b', name: 'B' })
    expect(groupSlotMemory.topic('tabs-7'), 'another topic opened beside the group takes its place').toEqual({ chatId: 'topic-b', name: 'B', shown: true })
    groupSlotMemory.closeTopic('topic-b')
    expect(groupSlotMemory.topic('tabs-7')).toBeNull()
    expect(groupSlotMemory.tabs('tabs-7'), 'the panel\'s tabs stay').toEqual([board])
  })
})

describe('asking a chat\'s panel', () => {
  it('one channel for Apps and files: the last ask is taken once', () => {
    groupSlotMemory.ask('ask-1', { app: 'kanban' })
    groupSlotMemory.ask('ask-1', { itemId: 'F1', at: { slide: '3' } })
    expect(groupSlotMemory.take('ask-1')).toEqual({ itemId: 'F1', at: { slide: '3' } })
    expect(groupSlotMemory.take('ask-1')).toBeNull()
  })
})
