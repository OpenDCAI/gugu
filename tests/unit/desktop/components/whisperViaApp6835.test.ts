// @vitest-environment jsdom
import { runInAction } from 'mobx'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messageItemFromRow, MESSAGES_VIEW_SELECT } from '@gugu/core/cloud/messageItem'
import type { ExtensionManifest } from '@shared/extensions/manifest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

// #6835 App 用 gugu.send 以人的名义发的悄悄话:发送人自己的气泡写「由『X』App 代你发送」,收件人的气泡写「由『X』App 代 A 发送」,
// 不然人会以为那句是 A 亲手打的。判据只有 via_app;X 是 manifest 里的名字,本机没装这个 App(手机、别的机器)就写 id。
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  runInAction(() => { installedExtensionsStore.manifests = [] })
})
afterEach(() => { harness.cleanup() })

async function renderWhisper(viaApp: string | null, seenBy: 'sender' | 'recipient' = 'sender') {
  const received = seenBy === 'recipient'
  await renderWithAppProviders(harness, createNode(MessageBubble, {
    msg: message({
      id: 'msg-1', is_mine: !received, sender_user_id: received ? 'alice' : 'me', is_whisper: true,
      to_user_ids: [received ? 'me' : 'agent-1'], via_app: viaApp,
    }),
    memberProfile: received ? { id: 'alice', displayName: 'Alice', avatar: null, email: null, type: 'human', role: 'member' } : null,
    onReaction: vi.fn(),
    memberReadSeqs: {},
    onQuote: vi.fn(),
    onForward: vi.fn(),
    onDelete: vi.fn(),
    isGroup: true,
  }))
}
const viaAppLine = () => harness.container.querySelector('[data-testid="message-via-app-badge"]')?.textContent ?? null

describe('whisper sent by an App in the person\'s name (#6835)', () => {
  it('reads via_app off the message row, the same select for history pages and arrivals', () => {
    expect(MESSAGES_VIEW_SELECT.split(', ')).toContain('via_app')
    const row = { id: 'm', chat_id: 'c', sender_user_id: 'me', created_at: '2026-09-30T00:00:00Z' }
    expect(messageItemFromRow({ ...row, via_app: 'waimai-review-vote' }, 'me')?.via_app).toBe('waimai-review-vote')
    expect(messageItemFromRow(row, 'me')?.via_app).toBeNull()
  })

  it('names the App from its manifest', async () => {
    runInAction(() => { installedExtensionsStore.manifests = [{ id: 'waimai-review-vote', name: '外卖评审投票', defaultLocale: 'zh-CN' } as ExtensionManifest] })
    await renderWhisper('waimai-review-vote')
    expect(viaAppLine()).toBe('由『外卖评审投票』App 代你发送')
    expect(harness.container.textContent).toContain('悄悄话')
  })

  it('writes the id where this device has no manifest for it, and follows the list once it loads', async () => {
    await renderWhisper('waimai-review-vote')
    expect(viaAppLine()).toBe('由『waimai-review-vote』App 代你发送')
    await act(async () => { runInAction(() => { installedExtensionsStore.manifests = [{ id: 'waimai-review-vote', name: '外卖评审投票', defaultLocale: 'zh-CN' } as ExtensionManifest] }) })
    expect(viaAppLine()).toBe('由『外卖评审投票』App 代你发送')
  })

  it('a plain whisper (via_app null) has no App line', async () => {
    await renderWhisper(null)
    expect(viaAppLine()).toBeNull()
    expect(harness.container.textContent).toContain('悄悄话')
  })

  it('the recipient reads which App spoke for the sender, by the sender\'s name in the bubble header', async () => {
    runInAction(() => { installedExtensionsStore.manifests = [{ id: 'waimai-review-vote', name: '外卖评审投票', defaultLocale: 'zh-CN' } as ExtensionManifest] })
    await renderWhisper('waimai-review-vote', 'recipient')
    expect(viaAppLine()).toBe('由『外卖评审投票』App 代 Alice 发送')
    expect(harness.container.textContent).toContain('Alice')
  })

  it('a recipient without the App installed reads its id; a plain received whisper has no line', async () => {
    await renderWhisper('waimai-review-vote', 'recipient')
    expect(viaAppLine()).toBe('由『waimai-review-vote』App 代 Alice 发送')
    harness.cleanup()
    harness = createReactHarness()
    await renderWhisper(null, 'recipient')
    expect(viaAppLine()).toBeNull()
  })
})
