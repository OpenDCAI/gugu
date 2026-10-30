import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
const { MessageBubble } = await import('@/components/chat/MessageBubble')
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())
const sender = { id: 'peer', displayName: 'Peer', avatar: null, type: 'human' } as MemberProfileCardModel
const cases = [
  { label: 'direct reply', group: false, mine: false, grouped: false, row: '[data-message-time]' },
  { label: 'group sender', group: true, mine: false, grouped: false, row: '[data-message-sender-name]' },
  { label: 'own reply', group: true, mine: true, grouped: false, row: '[data-message-time]' },
  { label: 'same speaker reply', group: true, mine: false, grouped: true, row: '[data-message-time]' },
  { label: 'unavailable sender name', group: true, mine: false, grouped: false, row: '[data-message-time]', name: '' },
]

for (const mobile of [false, true]) for (const scenario of cases) {
  it(`${mobile ? 'phone' : 'desktop'} ${scenario.label}: the reply mark shares an existing row without adding message height`, async () => {
    await page.viewport(mobile ? 390 : 1100, 800)
    harness = createReactHarness()
    harness.container.className = 'gugu-skin emlight'
    harness.container.style.cssText = `position:fixed;left:10px;top:100px;width:${mobile ? 370 : 900}px`
    const bubble = (quoted: boolean) => <MessageBubble
      msg={message({ id: quoted ? 'reply' : 'control', content: 'ok', is_mine: scenario.mine, sender_user_id: 'peer', created_at: '2026-10-30T07:59:00.000Z', reply_to_message_id: quoted ? 'source' : null, reply_to_sender_user_id: 'peer', reply_to_content: 'Original message' })}
      isGroup={scenario.group} compactMobile={mobile} groupedWithPrev={scenario.grouped}
      memberProfile={{ ...sender, displayName: scenario.name ?? sender.displayName }} memberProfiles={{ peer: sender }}
      onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} onShowMessage={() => {}} />
    await renderWithAppProviders(harness, <>{bubble(false)}{bubble(true)}</>)
    const [control, reply] = harness.container.querySelectorAll<HTMLElement>('[data-message-bubble-column]')
    const mark = reply.querySelector<HTMLElement>('.gg-chat-reply-jump')!
    const row = reply.querySelector<HTMLElement>(scenario.row)!
    const messageBody = reply.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!
    expect(row.contains(mark), 'the mark belongs to the existing sender or time row').toBe(true)
    const a = mark.getBoundingClientRect(), b = row.getBoundingClientRect(), box = messageBody.getBoundingClientRect()
    expect(Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2), 'mark and metadata share a baseline row').toBeLessThanOrEqual(1)
    expect(a.left, 'mark stays inside the bubble').toBeGreaterThanOrEqual(box.left)
    expect(a.right).toBeLessThanOrEqual(box.right)
    expect(reply.getBoundingClientRect().height, 'a short reply adds no standalone line').toBe(control.getBoundingClientRect().height)
    if (scenario.row === '[data-message-time]') {
      const range = document.createRange(); range.selectNodeContents(row.lastChild!)
      expect(a.right, 'reply mark comes before the timestamp').toBeLessThanOrEqual(range.getBoundingClientRect().left + 0.5)
    }
  })
}

it.each([false, true])('keeps a card reply in its existing timestamp row (mobile=%s)', async (mobile) => {
  await page.viewport(mobile ? 390 : 1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.width = mobile ? '370px' : '900px'
  const content = serializeComposerCard({ v: 1, type: 'task', text: 'Task', agentUserId: 'peer', agentName: 'Peer', agentType: 'codex', sessionId: 'session', projectId: 'project', deviceId: 'device', machineLabel: 'This computer' })
  const card = (reply: boolean) => <MessageBubble msg={message({ id: reply ? 'card-reply' : 'card', content_type: 'card', content, is_mine: true, reply_to_message_id: reply ? 'source' : null, reply_to_sender_user_id: 'peer', reply_to_content: 'Original' })}
    memberProfiles={{ peer: sender }} compactMobile={mobile} isGroup onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} />
  await renderWithAppProviders(harness, <>{card(false)}{card(true)}</>)
  const [control, reply] = harness.container.querySelectorAll<HTMLElement>('[data-testid="composer-card"]')
  const mark = reply.querySelector<HTMLElement>('.gg-chat-reply-jump')!
  expect(mark.parentElement!.closest('button'), 'the reply action is not nested inside the card action').toBeNull()
  const row = mark.parentElement!.parentElement!
  expect(row.textContent).toMatch(/\d{1,2}:\d{2}/)
  expect(row.getBoundingClientRect().height, 'the card timestamp remains one line').toBeLessThanOrEqual(20)
  expect(reply.getBoundingClientRect().height).toBe(control.getBoundingClientRect().height)
})
