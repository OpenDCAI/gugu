// @vitest-environment jsdom
// 聊天页渲染预算:一条新消息 / 一次别的会话的流片段 / 一次草稿落盘,各自让多少条气泡重渲。
// 这是「卡、一闪一闪」的量化判据 —— 每条可见气泡都重渲时,长会话里一次流片段就是几十次 markdown 重算。
// 计数器包在真 MessageBubble 外面(沿用它自己的 memo 比较函数),所以测到的就是 memo 真实放过/拦下了几次。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, memo, Profiler, useState, type FunctionComponent, type ReactNode } from 'react'
import type { ChatItem, Device, MessageItem } from '@gugu/core/shared/types/chat'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { ToastContext } from '../../../../apps/desktop/src/components/toastContext'
import { AuthContext, type AuthUser } from '../../../../apps/desktop/src/store/auth'
import { ChatStoreProvider, type ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { deriveThreadScope } from '../../../../apps/desktop/src/store/threadScope'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { chat, chatStore, createReactHarness, device, displayIdentity, message } from '../../../support/testHarness'

const counts = vi.hoisted(() => ({ bubble: new Map<string, number>(), metaRow: 0, panelCommits: 0 }))

vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/components/chat/MessageBubble')>()
  const real = actual.MessageBubble as unknown as { type: FunctionComponent<{ msg: MessageItem }>; compare: ((a: object, b: object) => boolean) | null }
  const Counting = (props: { msg: MessageItem }) => {
    counts.bubble.set(props.msg.id, (counts.bubble.get(props.msg.id) ?? 0) + 1)
    return real.type(props)
  }
  return { ...actual, MessageBubble: memo(Counting, real.compare ?? undefined) }
})
vi.mock('../../../../apps/desktop/src/components/chat/MessageMetaRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/components/chat/MessageMetaRow')>()
  return { ...actual, MessageMetaRow: (props: Parameters<typeof actual.MessageMetaRow>[0]) => { counts.metaRow += 1; return actual.MessageMetaRow(props) } }
})
vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: vi.fn(async () => []),
    getSourceState: vi.fn(async () => ({ kind: 'gone' as const })),
    getAgentFloodAdjustment: vi.fn(async () => null),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: vi.fn(async () => []),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    getGroupCollab: vi.fn(async () => ({
      snapshot: { scheduler: null, humans: [], agents: [], tasks: [], outputs: [] },
      identities: [],
    })),
    markMessageRead: vi.fn(async () => {}),
    getThreadMessages: vi.fn(async () => []),
  },
}))
// 真 hook 的返回值在状态不变时身份稳定;替身也必须稳定,否则量到的是替身制造的重渲。
const presence = vi.hoisted(() => ({
  display: {
    status: 'idle',
    presence: { presentation: { tone: 'online', label: 'online', animate: false, emphasis: false }, payload: { deviceId: 'device-1', agentType: 'claude-code', recentActions: [], lastActionAt: null, updatedAt: '2026-05-09T00:00:00.000Z' } },
    waking: false, wake: () => {}, opening: false, openRuntime: () => {},
  },
  none: {},
}))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({
  useAgentDisplayStatus: () => presence.display,
  useAgentDisplayStatuses: () => presence.none,
  useAgentRecentActivity: () => presence.none,
}))

const USER: AuthUser = { id: 'user-1', email: 'user@example.com', nickname: 'User' }
const AUTH = { user: USER, loading: false, status: 'authenticated' as const, updateUser: () => {}, logout: async () => ({ success: true }) }
const TOAST = { toast: () => {} }
const DEVICES: DevicesContextValue = {
  devices: [device('device-1', [], { is_current_device: true })] as Device[], loading: false, error: null,
  refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [],
}
const PEER = 'agent-1'
const MESSAGE_COUNT = 30

function history(): MessageItem[] {
  return Array.from({ length: MESSAGE_COUNT }, (_, i) => message({
    id: `m-${i}`, seq: i + 1, content: `line ${i}`,
    sender_user_id: i % 2 ? 'user-1' : PEER, is_mine: i % 2 === 1,
    created_at: new Date(Date.UTC(2026, 4, 9, 0, i)).toISOString(),
  }))
}

// 一份「provider 算出来的」store:回调身份稳定(真 provider 里它们都是 useCallback),
// 每次状态变更整份值换新 —— 与 ChatProvider 每次渲染给出新 value 同形。
function makeStore(kind: ChatItem['kind']) {
  const base = chatStore({
    identitiesById: {
      'user-1': displayIdentity('user-1', { display_name: 'User' }),
      [PEER]: displayIdentity(PEER, { type: 'agent', display_name: 'Deploy Bot' }),
    },
    activeChatId: 'chat-1',
  })
  let value: ChatContextValue = base
  const set = (patch: Partial<ChatContextValue>) => {
    const next = { ...value, ...patch }
    value = { ...next, threadScope: patch.messages ? deriveThreadScope({ rootId: null, messages: next.messages, threadMessages: [], loadingThread: false, loadingMessages: false }) : next.threadScope }
  }
  const activeChat = chat({ id: 'chat-1', kind, name: kind === 'group' ? 'Ops' : 'Deploy Bot', peer_user_id: kind === 'group' ? null : PEER })
  set({ activeChat, chats: [activeChat, chat({ id: 'chat-2', name: 'Other' })], messages: history() })
  return { get: () => value, set }
}

let harness: ReturnType<typeof createReactHarness>
// 帧时钟是假的:消息列表首帧之后隔两帧才补齐整窗(flowList),那次提交挂在真实帧上,落进哪条断言的观测窗由机器负载决定。
// 假帧只在 flushFrames() 里走 —— 挂载时排上的帧算在挂载里,一次操作排上的帧算在这次操作里。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  harness = createReactHarness()
  counts.bubble.clear()
  counts.metaRow = 0
  counts.panelCommits = 0
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
})

async function flushFrames() {
  await act(async () => { vi.runAllTimers() })
}

// 与真 ChatProvider 同形:provider 自己持有状态、每次变更给出新 value,而它的 children 是**同一个**元素 ——
// 所以面板只会因为它订阅的那几格变了才重渲,不会因为外层重新 render 一棵新树。
let publish: (value: ChatContextValue) => void = () => { throw new Error('store host not mounted') }
function StoreHost({ initial, children }: { initial: ChatContextValue; children?: ReactNode }) {
  const [value, setValue] = useState(initial)
  publish = setValue
  return createElement(ChatStoreProvider, { value }, children)
}

async function mount(store: ReturnType<typeof makeStore>) {
  const panel = createElement(Profiler, { id: 'panel', onRender: () => { counts.panelCommits += 1 } }, createElement(ChatAreaPanel, { activeTab: 'chats' }))
  await harness.render(createElement(AuthContext.Provider, { value: AUTH },
    createElement(ToastContext.Provider, { value: TOAST },
      createElement(DevicesContext.Provider, { value: DEVICES },
        createElement(StoreHost, { initial: store.get() }, panel)))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  await flushFrames()
  counts.bubble.clear()
  counts.metaRow = 0
  counts.panelCommits = 0
}

async function commit(store: ReturnType<typeof makeStore>) {
  await act(async () => { publish(store.get()) })
  await flushFrames()
}

function bubbleRenders(): number {
  return [...counts.bubble.values()].reduce((sum, n) => sum + n, 0)
}

// 新消息落地时 provider 同时做的两件事:消息窗追加一行,会话行的预览/水位被打补丁(换一个新对象)。
async function receiveMessage(store: ReturnType<typeof makeStore>) {
  const incoming = message({ id: 'm-new', seq: MESSAGE_COUNT + 1, content: 'new', sender_user_id: PEER, created_at: '2026-05-09T01:00:00.000Z' })
  const patched = { ...store.get().activeChat!, last_message_preview: 'new', next_message_seq: MESSAGE_COUNT + 2 }
  store.set({ messages: [...store.get().messages, incoming], activeChat: patched, chats: [patched, ...store.get().chats.slice(1)] })
  await commit(store)
}

describe('聊天页渲染预算', () => {
  it.each(['ai', 'group'] as const)('%s:收到一条新消息只渲染新那一条气泡', async (kind) => {
    const store = makeStore(kind)
    await mount(store)
    await receiveMessage(store)
    console.info(`[render-budget] ${kind} new message: bubbles=${bubbleRenders()} metaRows=${counts.metaRow}`)
    expect(counts.bubble.get('m-new')).toBe(1)
    expect(bubbleRenders()).toBe(1)
  })

  it('别的会话来了一片流式输出,当前会话一次都不重渲', async () => {
    const store = makeStore('ai')
    await mount(store)
    await act(async () => {
      window.dispatchEvent(new CustomEvent(UI_EVENTS.agentStream, { detail: { conversationId: 'chat-2', agentUserId: PEER, event: { type: 'message_chunk', text: 'x' } } }))
    })
    await flushFrames()
    console.info(`[render-budget] foreign stream chunk: panelCommits=${counts.panelCommits} bubbles=${bubbleRenders()}`)
    expect(counts.panelCommits).toBe(0)
    expect(bubbleRenders()).toBe(0)
  })

  // 上一条的阳控:同一个事件打到**当前**会话,面板必须真的重渲(证明事件确实送达、计数器确实在数),
  // 而气泡仍一条都不重渲 —— 流式正文不在历史气泡里,运行条的变化不该波及它们。
  it('当前会话的流片段让面板重渲,但历史气泡一条都不重渲', async () => {
    const store = makeStore('ai')
    await mount(store)
    await act(async () => {
      window.dispatchEvent(new CustomEvent(UI_EVENTS.agentStream, { detail: { conversationId: 'chat-1', agentUserId: PEER, event: { type: 'message_chunk', text: 'x' } } }))
    })
    await flushFrames()
    console.info(`[render-budget] own stream chunk: panelCommits=${counts.panelCommits} bubbles=${bubbleRenders()}`)
    expect(counts.panelCommits).toBeGreaterThan(0)
    expect(bubbleRenders()).toBe(0)
  })

  it('草稿落盘(别的会话)不让任何气泡或元指示行重渲', async () => {
    const store = makeStore('ai')
    await mount(store)
    store.set({ drafts: { 'chat-2': 'typing…' } })
    await commit(store)
    console.info(`[render-budget] draft persist: panelCommits=${counts.panelCommits} bubbles=${bubbleRenders()} metaRows=${counts.metaRow}`)
    expect(bubbleRenders()).toBe(0)
    expect(counts.metaRow).toBe(0)
  })
})

// C4:会话还在加载时发出去的那条乐观行必须看得见。从前 loading 与列表是互斥分支,
// 骨架盖住一切,乐观行在加载完成前不可见;且 loading 一翻转列表整个卸载重挂。
describe('加载中也画已有的行', () => {
  it('loading 期间的乐观行照样渲染,不出骨架', async () => {
    const store = makeStore('ai')
    const pending = message({ id: 'm-pending', seq: -1, sender_user_id: 'user-1', is_mine: true, local_send_state: 'sending' })
    store.set({ loadingMessages: true, messages: [pending] })
    await mount(store)
    expect(harness.container.querySelector('[data-skeleton-bubble]')).toBeNull()
    expect(harness.container.querySelector('[data-msg-id="m-pending"]')).not.toBeNull()
  })

  it('loading 且一行都没有:才出骨架', async () => {
    const store = makeStore('ai')
    store.set({ loadingMessages: true, messages: [] })
    await mount(store)
    expect(harness.container.querySelector('[data-skeleton-bubble]')).not.toBeNull()
  })
})
