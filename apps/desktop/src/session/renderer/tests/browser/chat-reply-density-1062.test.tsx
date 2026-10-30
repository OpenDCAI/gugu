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

async function mount(group: boolean, persistent: boolean, mobile = false) {
  await page.viewport(mobile ? 390 : 1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = `position:fixed;left:10px;top:100px;width:${mobile ? 370 : 900}px;height:600px`
  harness.container.dataset.testid = 'chat-message-list'
  await renderWithAppProviders(harness, <>
    <span data-testid="away" style={{ position: 'fixed', left: 0, top: 0, width: 20, height: 20 }}>.</span>
    <MessageBubble msg={message({ id: 'answer', content: 'The actual reply body.', is_mine: false, sender_user_id: 'agent', reply_to_message_id: 'question', reply_to_sender_user_id: 'owner', reply_to_content: 'Original question' })}
      memberProfiles={{ owner: { displayName: 'Owner' } } as unknown as Record<string, MemberProfileCardModel>}
      isGroup={group} compactMobile={mobile} showReplyQuote={persistent}
      onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}}
      onShowMessage={(id) => jumps.push(id)} />
  </>)
  return {
    bubble: harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!,
    quote: () => harness.container.querySelector<HTMLElement>('[data-chat-reply-quote]')!,
    preview: () => harness.container.querySelector<HTMLElement>('.gg-chat-reply-preview')!,
    jump: () => harness.container.querySelector<HTMLButtonElement>('.gg-chat-reply-jump')!,
  }
}

it.each([false, true])('hides an adjacent quote without a gap, then reveals the real quote on reply hover (group=%s)', async (group) => {
  const v = await mount(group, false)
  expect(getComputedStyle(v.quote()).display).toBe('none')
  expect(v.quote().getBoundingClientRect().height).toBe(0)
  expect(getComputedStyle(v.preview()).display).toBe('none')
  await act(async () => { await userEvent.hover(v.bubble) })
  await until('the hovered reply reveals its quote', () => getComputedStyle(v.preview()).display === 'block')
  expect(v.preview().textContent).toContain('Owner')
  expect(v.preview().textContent).toContain('Original question')
  await act(async () => { await userEvent.hover(v.preview()) })
  expect(getComputedStyle(v.preview()).display).toBe('block')
  await act(async () => { await userEvent.click(v.jump()) })
  expect(jumps).toEqual(['question'])
  await act(async () => { await userEvent.hover(harness.container.querySelector<HTMLElement>('[data-testid="away"]')!) })
  await until('leaving the reply removes the entire adjacent quote row', () => getComputedStyle(v.quote()).display === 'none')
  expect(v.quote().getBoundingClientRect().height).toBe(0)
})

it('keeps only a clickable mark for a non-adjacent group reply at rest', async () => {
  const v = await mount(true, true)
  expect(getComputedStyle(v.quote()).display).not.toBe('none')
  expect(getComputedStyle(v.preview()).display).toBe('none')
  expect(v.jump().textContent?.trim()).toBe('')
  await act(async () => { await userEvent.click(v.jump()) })
  expect(jumps).toEqual(['question'])
})

it('keeps the non-adjacent group mark tappable on phone without hover', async () => {
  const v = await mount(true, true, true)
  expect(getComputedStyle(v.quote()).display).not.toBe('none')
  expect(getComputedStyle(v.preview()).display).toBe('none')
  await act(async () => v.jump().click())
  expect(jumps).toEqual(['question'])
  expect(getComputedStyle(v.preview()).display).toBe('none')
})
