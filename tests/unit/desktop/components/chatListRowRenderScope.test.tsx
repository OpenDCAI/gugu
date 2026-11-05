// @vitest-environment jsdom
// 会话列表行的重渲染范围:一条会话来了新消息只重画那一行,其它行一行不画。
// 从前每次列表更新(store 里没变的行仍是同一个对象)都重画整列,每行一次日期格式化 + 头像角标 ⇒ 会话越多收一条消息越慢。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const rowRenders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../../apps/desktop/src/components/ui/ListRow', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/components/ui/ListRow')>()
  return {
    ...original,
    ListRow: (props: Parameters<typeof original.ListRow>[0] & { 'data-chat-row'?: string }) => {
      const id = props['data-chat-row']
      if (id) rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1)
      return original.ListRow(props)
    },
  }
})
vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); rowRenders.clear() })
afterEach(() => harness.cleanup())

const chats = ['a', 'b', 'c'].map((id, index) => chat({ id, kind: 'group', name: `Group ${id}`, last_message_preview: `hello ${id}`, last_message_at: `2099-01-0${3 - index}T00:00:00Z` }))
const node = createNode(ChatListPanel, {})
// 身份目录在两次更新之间是同一个对象(新消息不改身份),与产品里的 store 一致。
const identitiesById = {}
const render = (rows: typeof chats) => renderWithAppProviders(harness, node, { chat: { chats: rows, identitiesById }, contacts: {} })

describe('chat list rows re-render only for their own change', () => {
  it('a new message in one conversation re-renders that row only', async () => {
    await render(chats)
    expect([...rowRenders.keys()].sort()).toEqual(['a', 'b', 'c'])
    rowRenders.clear()

    await render([chats[0]!, { ...chats[1]!, last_message_preview: 'new message in b', unread_count: 1 }, chats[2]!])
    expect(harness.container.querySelector('[data-chat-row="b"]')?.textContent).toContain('new message in b')
    expect(Object.fromEntries(rowRenders)).toEqual({ b: 1 })
  })

  it('a topic sub-row re-renders only for its own change', async () => {
    const topic = chat({ id: 't', kind: 'topic', name: 'Review', source_chat_id: 'a', last_message_at: '2099-01-03T12:00:00Z' })
    const withTopic = [...chats, topic]
    await render(withTopic)
    expect(rowRenders.get('t')).toBe(1)
    rowRenders.clear()

    const b = { ...withTopic[1]!, last_message_preview: 'new message in b' }
    await render([withTopic[0]!, b, withTopic[2]!, topic])
    expect(Object.fromEntries(rowRenders)).toEqual({ b: 1 })
    rowRenders.clear()
    await render([withTopic[0]!, b, withTopic[2]!, { ...topic, unread_count: 3 }])
    expect(Object.fromEntries(rowRenders)).toEqual({ t: 1 })
  })

  it('a list update that changed no row re-renders none', async () => {
    await render(chats)
    rowRenders.clear()
    await render([...chats])
    expect(Object.fromEntries(rowRenders)).toEqual({})
  })
})
