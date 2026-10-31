// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import * as platformMock from '../../../support/capacitorPlatformTestDouble'
import {
  chat,
  contact,
  createNode,
  createReactHarness,
  renderWithAppProviders
} from '../../../support/testHarness'

// Solid's DOM renderer runs in the Chromium project; keep the React host/providers real here.
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript')>(),
  ChatTranscript: () => null,
}))

vi.mock(
  '../../../../apps/desktop/src/platform',
  () => import('../../../support/capacitorPlatformTestDouble')
)
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getCommonGroupChats: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => null),
    markMessageRead: vi.fn(async () => {}),
  }
}))
vi.mock(
  '../../../../apps/desktop/src/hooks/useAgentDisplayStatus',
  () => import('../../../support/agentDisplayStatusTestDouble')
)

let harness: ReturnType<typeof createReactHarness>

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  harness = createReactHarness()
  platformMock.platform.capabilities.agentRuntime = false
})

afterEach(() => {
  vi.unstubAllGlobals()
  harness.cleanup()
})

describe('agent runtime capability visibility', () => {
  it('hides desktop runtime-open actions when the platform cannot open agent runtimes', async () => {
    await renderOwnedAgentChat()

    expect(
      harness.container.querySelector(
        `[data-testid="${AUTOMATION_TEST_IDS.chatHeaderAgentRuntimeOpenButton}"]`
      )
    ).toBeNull()

    harness.cleanup()
    harness = createReactHarness()
    await renderOwnedAgentContact()

    expect(
      harness.container.querySelector(
        `[data-testid="${AUTOMATION_TEST_IDS.contactAgentRuntimeOpenButton}"]`
      )
    ).toBeNull()
  })

  it('keeps the runtime-open action in Contacts (capable platforms) but NOT in the agent-DM header', async () => {
    platformMock.platform.capabilities.agentRuntime = true
    await renderOwnedAgentChat()

    // @@@1141 - create-Agent 单聊右上角按设计稿(#chat-single 仅 历史+⋯):header 的
    // 「打开 Agent 运行窗口」按钮已删(它是 gugu 比 SSOT 多出的 electron-only 元素)。运行窗口入口
    // 保留在通讯录 agent 卡(capability-gated),不丢能力。
    expect(
      harness.container.querySelector(
        `[data-testid="${AUTOMATION_TEST_IDS.chatHeaderAgentRuntimeOpenButton}"]`
      )
    ).toBeNull()

    harness.cleanup()
    harness = createReactHarness()
    await renderOwnedAgentContact()

    expect(
      harness.container.querySelector(
        `[data-testid="${AUTOMATION_TEST_IDS.contactAgentRuntimeOpenButton}"]`
      )
    ).not.toBeNull()
  })

  it('keeps the agent contact detail free of non-actionable runtime and permission copy', async () => {
    platformMock.platform.capabilities.agentRuntime = true

    await renderOwnedAgentContact()

    expect(harness.container.textContent).not.toContain('唤醒 Agent')
    expect(harness.container.textContent).not.toContain('运行环境')
    expect(harness.container.textContent).not.toContain('未连接运行时')
    expect(harness.container.textContent).not.toContain('能力边界')
    expect(harness.container.textContent).not.toContain('工具权限')
    expect(harness.container.textContent).not.toContain('资料未提供具体工具清单')
    expect(harness.container.textContent).toContain('打开运行窗口')
    expect(harness.container.textContent).toContain('上线意图')
  })
})

async function renderOwnedAgentChat() {
  await renderWithAppProviders(
    harness,
    createNode(ChatAreaPanel, { mobile: true }),
    {
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      chat: {
        activeChatId: 'chat-1',
        activeChat: chat({
          id: 'chat-1',
          kind: 'ai',
          name: 'Deploy Bot',
          peer_user_id: 'agent-1',
        })
      }
    }
  )
}

async function renderOwnedAgentContact() {
  await renderWithAppProviders(
    harness,
    createNode(ContactsPanel, {
      externalContactId: 'agent-1',
      mobile: true
    }),
    {
      shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: {
        contacts: [
          contact({
            id: 'agent-1',
            display_name: 'Deploy Bot',
            type: 'agent',
            owner_user_id: 'owner-1'
          })
        ]
      }
    }
  )
}
