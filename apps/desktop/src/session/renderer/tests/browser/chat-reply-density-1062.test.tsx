import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
const { MessageBubble } = await import('@/components/chat/MessageBubble')
let harness: ReturnType<typeof createReactHarness>
const jumps: string[] = []
afterEach(() => { harness?.cleanup(); jumps.length = 0 })
const popup = () => document.querySelector<HTMLElement>('[data-chat-reply-preview-popup]')

async function mount(group: boolean, mobile = false, target: string | null = 'question', selected = false) {
  await page.viewport(mobile ? 390 : 1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = `position:fixed;left:10px;top:100px;width:${mobile ? 370 : 900}px;height:600px`
  harness.container.dataset.testid = 'chat-message-list'
  await renderWithAppProviders(harness, <>
    <span data-testid="away" style={{ position: 'fixed', left: 0, top: 0, width: 20, height: 20 }}>.</span>
    <MessageBubble msg={message({ id: 'answer', content: selected ? '> [Owner]: Selected excerpt.\nThe actual reply body.' : 'The actual reply body.', is_mine: false, sender_user_id: 'agent', reply_to_message_id: target, reply_to_sender_user_id: 'owner', reply_to_content: selected ? 'Unselected start. Selected excerpt.' : 'Original question' })}
      memberProfiles={{ owner: { displayName: 'Owner' } } as unknown as Record<string, MemberProfileCardModel>}
      isGroup={group} compactMobile={mobile}
      onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}}
      onShowMessage={(id) => jumps.push(id)} />
  </>)
  return {
    bubble: harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!,
    marker: harness.container.querySelector<HTMLElement>('[data-chat-reply-quote]'),
    jump: harness.container.querySelector<HTMLButtonElement>('.gg-chat-reply-jump'),
  }
}

it.each([false, true])('shows only the explicit reply mark; hovering the message does not disclose the quote (group=%s)', async (group) => {
  const v = await mount(group)
  expect(v.marker).not.toBeNull()
  expect(v.jump!.textContent?.trim()).toBe('')
  expect(popup()).toBeNull()
  expect(harness.container.textContent).not.toContain('Original question')
  await act(async () => { await userEvent.hover(v.bubble) })
  expect(popup()).toBeNull()
  await act(async () => { await userEvent.hover(v.jump!) })
  await until('hovering only the mark reveals the real quote', () => !!popup())
  expect(popup()!.textContent).toContain('Owner')
  expect(popup()!.textContent).toContain('Original question')
  await act(async () => { await userEvent.click(v.jump!) })
  expect(jumps).toEqual(['question'])
  await act(async () => { await userEvent.hover(harness.container.querySelector<HTMLElement>('[data-testid="away"]')!) })
  await until('mouse departure closes the quote without sticky mouse focus', () => !popup())
})

it.each([false, true])('does not create a quote from author or preview text without a reply target (group=%s)', async (group) => {
  const v = await mount(group, false, null)
  expect(v.marker).toBeNull()
  await act(async () => { await userEvent.hover(v.bubble) })
  expect(popup()).toBeNull()
})

it('opens a phone quote on tap without jumping, then lets its preview jump to the source', async () => {
  const v = await mount(true, true)
  expect(popup()).toBeNull()
  await act(async () => { v.jump!.click() })
  await until('phone tap opens the source preview', () => !!popup())
  expect(jumps).toEqual([])
  expect(popup()!.textContent).toContain('Original question')
  const source = popup()!.querySelector<HTMLElement>('[title]')!
  await act(async () => { source.click() })
  expect(jumps).toEqual(['question'])
})

it.each([false, true])('keeps a selected excerpt and its jump inside the disclosed source (group=%s)', async (group) => {
  const v = await mount(group, false, 'question', true)
  await act(async () => { await userEvent.hover(v.jump!) })
  await until('selected source preview is open', () => !!popup())
  expect(popup()!.textContent).toContain('Selected excerpt.')
  expect(popup()!.textContent).not.toContain('Unselected start.')
  expect(document.body.textContent?.match(/Selected excerpt\./g)).toHaveLength(1)
  await act(async () => { await userEvent.hover(popup()!) })
  expect(popup()).not.toBeNull()
  await act(async () => { await userEvent.click(popup()!.querySelector<HTMLElement>('[title]')!) })
  expect(jumps).toEqual(['question'])
})
