// @vitest-environment jsdom
//
// 手机上话题整页盖住了来源群,群里那条运行条就看不见了。话题页挂上同一条:数据取来源群,
// 短按 @ 进**话题自己的**输入框。桌面不挂:分栏旁边群里那条一直看得见。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

const { TopicSplitPane } = await import('../../../apps/desktop/src/components/chat/TopicSplitPane')

let harness: ReturnType<typeof createReactHarness>
const desktopWidth = window.innerWidth
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  harness.cleanup()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth })
})

const baseProps = {
  topic: { chatId: 'topic-1', name: '分片下载失败' },
  sourceChatId: 'source-1',
  messages: [],
  loading: false,
  memberProfiles: {},
  memberReadSeqs: {},
  visibleChats: [],
  sourceMessagePreview: 'pending',
  onOpenFile: vi.fn(),
  onDownloadFile: vi.fn(),
  onSend: vi.fn(async () => {}),
  onSendAttachments: vi.fn(async () => {}),
  onClose: vi.fn(),
  currentUserId: 'user-1',
  onRevealOlder: vi.fn(),
  mentionMembers: [],
} satisfies Parameters<typeof TopicSplitPane>[0]

const pico = { id: 'agent-1', name: 'Pico', avatarUrl: null, avatarSeed: 'agent-1', stateKey: 'running' as const, toolCount: 2, lastActiveAt: null }

describe('手机话题页的运行条', () => {
  it('来源群有 agent 在跑 ⇒ 话题页挂上运行条;短按 token,@ 进话题的输入框', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    await renderWithAppProviders(harness, createNode(TopicSplitPane, {
      ...baseProps,
      mobile: true,
      runningTokens: [pico],
      runningPreviewChatId: 'group-1',
    }))
    const bar = harness.container.querySelector('[data-testid="topic-agent-running-status"]')
    expect(bar, '话题页没有运行条').toBeTruthy()
    await clickElement(bar!.querySelector('[data-message-preview-trigger="agent-1"]') as HTMLElement)
    const composer = harness.container.querySelector('[data-topic-split-composer] textarea') as HTMLTextAreaElement
    expect(composer.value).toBe('@Pico ')
  })

  it('没有 token(桌面不传)⇒ 不挂', async () => {
    await renderWithAppProviders(harness, createNode(TopicSplitPane, baseProps))
    expect(harness.container.querySelector('[data-testid="topic-agent-running-status"]')).toBeNull()
  })
})
