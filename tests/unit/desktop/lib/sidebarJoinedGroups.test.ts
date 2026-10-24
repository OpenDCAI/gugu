// spec session-page「拼在一屏的几块是一组」:侧栏的「对话」把同一组的几行并在一处,和「项目」那边同一条规则(joinedSlot)。
import { describe, expect, it } from 'vitest'
import { joinedSlot, joinRows, type JoinedGroup } from '../../../../apps/desktop/src/lib/sidebarJoinedGroups'

// 「对话」按最近活动排好的一串:私聊、群、没有项目的会话混排。
const rows = ['chat:zhang', 'chat:design', 'session:helper', 'chat:li', 'chat:beta', 'chat:wang']
const pack = (groups: JoinedGroup[]) =>
  joinRows(rows, (row) => row, groups).map(({ row, join }) => (join ? `${row}:${join.pos}${join.onScreen ? '*' : ''}` : row))

describe('joinRows: the Chats list packs a group where its anchor row is', () => {
  it('pulls the other members up to the anchor, in the order they sit on screen', () => {
    expect(pack([{ members: ['chat:design', 'chat:li'], anchor: 'chat:design', onScreen: true }])).toEqual([
      'chat:zhang', 'chat:design:first*', 'chat:li:last*', 'session:helper', 'chat:beta', 'chat:wang',
    ])
    expect(pack([{ members: ['chat:wang', 'session:helper', 'chat:zhang'], anchor: 'chat:wang', onScreen: false }])).toEqual([
      'chat:design', 'chat:li', 'chat:beta', 'chat:wang:first', 'session:helper:middle', 'chat:zhang:last',
    ])
  })

  it('an anchor that lives in another list (a project task) puts the box at this list’s first member in group order', () => {
    expect(pack([{ members: ['session:task', 'chat:beta', 'chat:zhang'], anchor: 'session:task', onScreen: false }])).toEqual([
      'chat:design', 'session:helper', 'chat:li', 'chat:beta:first', 'chat:zhang:last', 'chat:wang',
    ])
  })

  it('a group with one row here leaves that row alone; rows of no group stay in their place', () => {
    expect(pack([{ members: ['session:task', 'app:x.clock', 'chat:li'], anchor: 'chat:li', onScreen: true }])).toEqual(rows)
    expect(pack([])).toEqual(rows)
  })

  it('two groups pack independently', () => {
    expect(
      pack([
        { members: ['chat:li', 'chat:design'], anchor: 'chat:li', onScreen: true },
        { members: ['chat:zhang', 'chat:wang'], anchor: 'chat:zhang', onScreen: false },
      ]),
    ).toEqual(['chat:zhang:first', 'chat:wang:last', 'session:helper', 'chat:li:first*', 'chat:design:last*', 'chat:beta'])
  })
})

describe('joinedSlot: the one place that decides where a group sits', () => {
  it('is the anchor when this list has it, else the first member this list has', () => {
    const group: JoinedGroup = { members: ['chat:a', 'session:b', 'chat:c'], anchor: 'session:b', onScreen: true }
    expect(joinedSlot(group, ['session:b', 'chat:c'])).toBe('session:b')
    expect(joinedSlot(group, ['chat:a', 'chat:c'])).toBe('chat:a')
  })
})
