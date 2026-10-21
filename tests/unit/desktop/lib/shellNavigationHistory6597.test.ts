// #6597 Windows 标题栏的 ← →:壳级历史(对话 / 通讯录 / 任务,对话里细到哪条会话)。
import { describe, expect, it } from 'vitest'
import {
  SHELL_HISTORY_LIMIT,
  ShellNavigationHistory,
  type ShellLocation,
} from '../../../../apps/desktop/src/lib/shellNavigationHistory'

const chats = (chatId: string | null): ShellLocation => ({ tab: 'chats', chatId })
const contacts: ShellLocation = { tab: 'contacts' }
const sessions: ShellLocation = { tab: 'tasks' }
const always = () => true

/** 走一遍:记录 → 后退/前进,并像壳那样把落地的位置再 record 回来。 */
function walk(history: ShellNavigationHistory, locations: ShellLocation[]) {
  for (const location of locations) history.record(location)
}

describe('ShellNavigationHistory', () => {
  it('后退 / 前进沿着走过的位置来回,落地那一次 record 不截掉前进栈', () => {
    const history = new ShellNavigationHistory()
    walk(history, [sessions, chats('a'), contacts])
    expect(history.canGoBack(always)).toBe(true)
    expect(history.canGoForward(always)).toBe(false)

    const back = history.back(always)
    expect(back).toEqual(chats('a'))
    history.record(back!) // 壳切过去之后,位置变化照常流回来
    expect(history.canGoForward(always)).toBe(true)

    expect(history.back(always)).toEqual(sessions)
    history.record(sessions)
    expect(history.canGoBack(always)).toBe(false)

    expect(history.forward(always)).toEqual(chats('a'))
    history.record(chats('a'))
    expect(history.forward(always)).toEqual(contacts)
  })

  it('后退之后走到新位置 = 截掉前进栈(浏览器语义)', () => {
    const history = new ShellNavigationHistory()
    walk(history, [sessions, chats('a'), contacts])
    history.record(history.back(always)!)
    history.record(chats('b'))
    expect(history.canGoForward(always)).toBe(false)
    expect(history.back(always)).toEqual(chats('a'))
  })

  it('落地时位置没到目标(被别的导航抢先)⇒ 这次变化照常记成一格,不被吞掉', () => {
    const history = new ShellNavigationHistory()
    walk(history, [sessions, chats('a'), contacts])
    history.back(always) // 目标 chats('a'),但接下来到的是 tasks
    history.record(sessions)
    // tasks 被记成新的一格(截掉了 contacts),而不是被当成「落地」静默丢掉
    expect(history.canGoForward(always)).toBe(false)
    expect(history.back(always)).toEqual(chats('a'))
  })

  it('同一位置重复 record 不加格', () => {
    const history = new ShellNavigationHistory()
    walk(history, [sessions, sessions, chats('a'), chats('a')])
    expect(history.back(always)).toEqual(sessions)
    history.record(sessions)
    expect(history.canGoBack(always)).toBe(false)
  })

  it('对话从「没选会话」到「选中一条」是把这一格填上,不是新的一格', () => {
    const history = new ShellNavigationHistory()
    walk(history, [sessions, chats(null), chats('a')])
    expect(history.back(always)).toEqual(sessions)
    // 反例:两条不同的会话之间照常是两格
    const other = new ShellNavigationHistory()
    walk(other, [chats('a'), chats('b')])
    expect(other.back(always)).toEqual(chats('a'))
  })

  it('后退到「没选会话」那一格再选一条:原地填上,但前进栈照样截掉', () => {
    const history = new ShellNavigationHistory()
    walk(history, [chats(null), sessions])
    history.record(history.back(always)!)
    expect(history.canGoForward(always)).toBe(true)
    history.record(chats('a'))
    expect(history.canGoForward(always)).toBe(false)
    expect(history.canGoBack(always)).toBe(false)
  })

  it('去不了的格(会话已删)在后退 / 前进时跳过;全都去不了就不可后退', () => {
    const history = new ShellNavigationHistory()
    walk(history, [sessions, chats('gone'), contacts])
    const reachable = (location: ShellLocation) => !(location.tab === 'chats' && location.chatId === 'gone')
    expect(history.back(reachable)).toEqual(sessions)
    history.record(sessions)
    expect(history.forward(reachable)).toEqual(contacts)

    const only = new ShellNavigationHistory()
    walk(only, [chats('gone'), contacts])
    expect(only.canGoBack(reachable)).toBe(false)
    expect(only.back(reachable)).toBeNull()
  })

  it(`最多留 ${SHELL_HISTORY_LIMIT} 格,多了丢最早的`, () => {
    const history = new ShellNavigationHistory()
    for (let i = 0; i < SHELL_HISTORY_LIMIT + 5; i += 1) history.record(chats(`c${i}`))
    let steps = 0
    let target = history.back(always)
    while (target) {
      history.record(target)
      steps += 1
      target = history.back(always)
    }
    expect(steps).toBe(SHELL_HISTORY_LIMIT - 1)
  })
})
