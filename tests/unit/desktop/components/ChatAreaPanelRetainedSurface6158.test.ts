// @vitest-environment jsdom
// #6158 聊天面在别的 tab 上由 MainLayout 隐藏而非卸载。这里钉住 ChatAreaPanel 自己那三条:
//   ① 别的 tab 上不换成空态(树留着,分栏/右栏/滚动才在);
//   ② 隐藏态不算「看见」:IntersectionObserver 那条已读路径按壳的 tab(ShellTabContext)门控,切回时重新数一遍;
//   ③ 隐藏态不接全局快捷键(Mod+F 搜索 = 限定本会话的全局搜索)。
// jsdom 没有 IntersectionObserver ⇒ MessageList 一挂载就同步调 onVisible(产品自己的降级分支),
// 所以「隐藏态 0 次调用」是门控的真读数,不是观察器没装。每条都带同场景的阳性对照。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, Fragment } from 'react'
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { resetSearchSession, useSearchSession } from '@renderer/features/global-search/search-session'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { chat, createNode, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

const { getImRepositoryMock } = vi.hoisted(() => ({ getImRepositoryMock: vi.fn() }))

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }))
vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    createTopic: vi.fn(),
    listTopicsOfChat: vi.fn(async () => []),
    getSourceState: vi.fn(async () => ({ kind: 'gone' as const })),
    getAgentFloodAdjustment: vi.fn(async () => null),
    undoAgentFloodAdjustment: vi.fn(async () => 0),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => ({
      snapshot: {
        scheduler: { chat_id: 'chat-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-22T00:00:00.000Z' },
        humans: [], agents: [], tasks: [],
      },
      identities: [],
    })),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    getThreadMessages: vi.fn(async () => []),
  },
}))

let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository

beforeEach(async () => {
  harness = createReactHarness()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})

afterEach(() => {
  repository.close()
  harness.cleanup()
  resetSearchSession()
})

const PEER_MESSAGE = message({ id: 'peer-msg-1', chat_id: 'chat-1', seq: 7, sender_user_id: 'peer-1', content: '隐藏期间到达的一条' })
function SearchSnapshot() { return createNode('output', { 'data-search-session': true }, JSON.stringify(useSearchSession())) }

async function renderPanel(activeTab: 'chats' | 'tasks', markMessageVisible = vi.fn()) {
  await renderWithAppProviders(harness, createNode(Fragment, null, createNode(CommandShortcutBinder), createNode(ChatAreaPanel, { imPage: true, openNonce: 0 }), createNode(SearchSnapshot)), {
    shellTab: activeTab,
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: 'chat-1',
      activeChat: chat({ id: 'chat-1', kind: 'dm', peer_user_id: 'peer-1' }),
      identitiesById: { 'peer-1': displayIdentity('peer-1') },
      messages: [PEER_MESSAGE],
      markMessageVisible,
    },
  })
  return { markMessageVisible }
}

const composer = () => harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`)
async function pressFind() {
  const input = composer() as HTMLElement
  await act(async () => { input.focus() })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'KeyF', key: 'f', bubbles: true, cancelable: true }))
  })
}

describe('ChatAreaPanel retained while hidden on another tab (#6158)', () => {
  it('keeps the conversation tree instead of swapping to the empty state on a non-chats tab', async () => {
    await renderPanel('tasks')
    expect(composer(), 'hidden on the tasks tab the panel must still hold the conversation (composer present)').not.toBeNull()
    expect(harness.container.textContent).toContain(PEER_MESSAGE.content)
    // 阳性对照:同一棵树在 chats tab 上当然也在。
    await renderPanel('chats')
    expect(composer()).not.toBeNull()
  })

  it('does not count rows as seen while hidden, and counts them once the surface is back on chats', async () => {
    const markMessageVisible = vi.fn()
    await renderPanel('tasks', markMessageVisible)
    expect(markMessageVisible, 'hidden ≠ seen: no row may advance the read watermark while on another tab').not.toHaveBeenCalled()
    // 切回 chats:同一份 markMessageVisible,同一棵树(root.render 复用实例),此刻在视口里的行才算看见。
    await renderPanel('chats', markMessageVisible)
    expect(markMessageVisible).toHaveBeenCalled()
    expect(markMessageVisible.mock.calls.some(([msg]) => (msg as { id: string }).id === PEER_MESSAGE.id)).toBe(true)
  })

  it('counts rows as seen on the chats tab from the first render (positive control for the gate)', async () => {
    const { markMessageVisible } = await renderPanel('chats')
    expect(markMessageVisible).toHaveBeenCalled()
  })

  it('ignores the Mod+F search shortcut while hidden, and opens the scoped global search on the chats tab', async () => {
    const openPanel = vi.fn()
    const unregister = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', execute: openPanel }] })
    try {
      await renderPanel('tasks')
      await pressFind()
      expect(openPanel, 'a global shortcut must not act on a hidden surface').not.toHaveBeenCalled()
      await renderPanel('chats')
      await pressFind()
      expect(openPanel, 'positive control: the same shortcut opens search on the chats tab').toHaveBeenCalledTimes(1)
      const state = JSON.parse(harness.container.querySelector('[data-search-session]')!.textContent!)
      expect(state.chips).toEqual([{ kind: 'in', chatId: 'chat-1' }])
      expect(harness.container.querySelector('input[placeholder="Find..."], input[placeholder="查找…"]'), 'no second, in-page search box').toBeNull()
    } finally { await act(async () => { unregister() }) }
  })
})
