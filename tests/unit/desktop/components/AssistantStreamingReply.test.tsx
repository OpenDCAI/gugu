// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantTyping } from '../../../../apps/desktop/src/components/assistant/AssistantTyping'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => <span>{content}</span> }))
const harness = createReactHarness()
afterEach(() => harness.cleanup())
const inactive = () => undefined

it('keeps the same width and meaningful older quote when a streamed reply becomes a persisted message', async () => {
  const source = message({ id: 'source', is_mine: true, sender_user_id: 'user-1', content: '解释一下这个问题' })
  const newer = message({ id: 'newer', is_mine: true, sender_user_id: 'user-1', content: '补充另一个问题' })
  const text = '这是一段需要多行显示的真实回复。'.repeat(15)
  await renderWithAppProviders(harness, <AssistantTyping name="bc" pending="working" activity={{ phase: 'draft', id: 'call', text, replyToMessageId: source.id }} />, {
    chat: { activeChat: chat({ id: source.chat_id, peer_user_id: 'assistant' }), messages: [source,newer] },
  })
  const column = harness.container.querySelector<HTMLElement>('[data-message-bubble-column]')
  expect(column).not.toBeNull()
  const width = column!.getAttribute('style')
  expect(harness.container.textContent).toContain(source.content)
  expect(harness.container.querySelector('[data-testid="agent-answer-actions"]')).toBeNull()
  const settled = message({ id: 'persisted', is_mine: false, content: text, sender_user_id: 'assistant', reply_to_message_id: source.id, reply_to_content: source.content, reply_to_sender_user_id: 'user-1' })
  await renderWithAppProviders(harness, <MessageBubble msg={settled} isAgent hideAvatar hideTime memberProfiles={{ 'user-1': { id: 'user-1', displayName: 'User', avatar: null, email: null, type: 'human', role: 'member' } }} onReaction={inactive} onQuote={inactive} onForward={inactive} onDelete={inactive} />)
  expect(harness.container.querySelector('[data-message-bubble-column]')?.getAttribute('style')).toBe(width)
  expect(harness.container.textContent).toContain(source.content)
})
