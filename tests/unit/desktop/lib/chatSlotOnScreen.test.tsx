// @vitest-environment jsdom
// 桌面的对话画在会话页的格子里(gugu-dev#181):格子真摆在屏上 = 人正看着它,通知与「看见即已读」都认它;藏着的不算。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { subscribeAppActive: (listener: (active: boolean) => void) => { listener(true); return () => undefined } },
}))

const { isChatOnScreen } = await import('../../../../apps/desktop/src/lib/onScreenChat')
const { ChatSlot } = await import('../../../../apps/desktop/src/session/renderer/lib/chat-slot')
const { RetainedTabContent } = await import('../../../../apps/desktop/src/session/renderer/features/tabs/retained-tab-content')
const { setEmbedVisible } = await import('../../../../apps/desktop/src/session/renderer/lib/portal-container')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); setEmbedVisible(true) })

const block = (layerVisible: boolean) => createNode(RetainedTabContent, { visible: layerVisible, children: createElement(ChatSlot, { chatId: 'group' }) })

describe('a chat block on the session page counts as on screen only while it is shown', () => {
  it('is on screen in the shown chat layer, so a mention there raises no banner', async () => {
    await harness.render(block(true))
    expect(isChatOnScreen('group')).toBe(true)
    expect(isChatOnScreen('other')).toBe(false)
  })

  it('is not on screen behind another tab of its block, nor while the task frame is hidden', async () => {
    await harness.render(block(false))
    expect(isChatOnScreen('group')).toBe(false)
    await harness.render(block(true))
    await act(async () => { setEmbedVisible(false) })
    expect(isChatOnScreen('group')).toBe(false)
  })
})
