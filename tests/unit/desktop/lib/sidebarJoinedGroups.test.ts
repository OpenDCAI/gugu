// spec session-page「拼在一屏的几块是一组」:侧栏的「对话」把同一组的几行并在一处 —— 并在这组最靠前那一行的位置,
// 和「项目」那边同一条规则。
import { describe, expect, it } from 'vitest'
import { joinRows, type JoinedGroup } from '../../../../apps/desktop/src/lib/sidebarJoinedGroups'

// 「对话」按最近活动排好的一串:私聊、群、没有项目的会话混排。
const rows = ['chat:zhang', 'chat:design', 'session:helper', 'chat:li', 'chat:beta', 'chat:wang']
const pack = (groups: JoinedGroup[], list: readonly string[] = rows) =>
  joinRows(list, (row) => row, groups).map(({ row, join }) => (join ? `${row}:${join.pos}${join.onScreen ? '*' : ''}` : row))

describe('joinRows: the Chats list packs a group where its highest row is', () => {
  it('pulls the other members up to the group’s highest row, in the order they sit on screen', () => {
    expect(pack([{ members: ['chat:design', 'chat:li'], onScreen: true }])).toEqual([
      'chat:zhang', 'chat:design:first*', 'chat:li:last*', 'session:helper', 'chat:beta', 'chat:wang',
    ])
    expect(pack([{ members: ['chat:wang', 'session:helper', 'chat:zhang'], onScreen: false }])).toEqual([
      'chat:wang:first', 'session:helper:middle', 'chat:zhang:last', 'chat:design', 'chat:li', 'chat:beta',
    ])
  })

  it('a new message to any member lifts the whole group with it', () => {
    const group: JoinedGroup = { members: ['chat:design', 'chat:wang'], onScreen: false }
    expect(pack([group])).toEqual(['chat:zhang', 'chat:design:first', 'chat:wang:last', 'session:helper', 'chat:li', 'chat:beta'])
    // 王五来了新消息,排到最前:整组跟着上去
    const afterMessage = ['chat:wang', ...rows.filter((row) => row !== 'chat:wang')]
    expect(pack([group], afterMessage)).toEqual(['chat:design:first', 'chat:wang:last', 'chat:zhang', 'session:helper', 'chat:li', 'chat:beta'])
  })

  it('members this list does not have (a project task, an App) do not count', () => {
    expect(pack([{ members: ['session:task', 'chat:beta', 'chat:zhang'], onScreen: false }])).toEqual([
      'chat:beta:first', 'chat:zhang:last', 'chat:design', 'session:helper', 'chat:li', 'chat:wang',
    ])
    expect(pack([{ members: ['session:task', 'app:x.clock', 'chat:li'], onScreen: true }])).toEqual(rows)
    expect(pack([])).toEqual(rows)
  })

  it('two groups pack independently', () => {
    expect(
      pack([
        { members: ['chat:li', 'chat:design'], onScreen: true },
        { members: ['chat:zhang', 'chat:wang'], onScreen: false },
      ]),
    ).toEqual(['chat:zhang:first', 'chat:wang:last', 'chat:li:first*', 'chat:design:last*', 'session:helper', 'chat:beta'])
  })
})
