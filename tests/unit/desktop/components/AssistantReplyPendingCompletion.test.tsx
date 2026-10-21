// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const pending = vi.hoisted(() => ({ pending: 'working' as const, awaitingMessageId: 'source' as string | null }))
vi.mock('../../../../apps/desktop/src/components/chat/useAgentReplyPending', () => ({ useAgentReplyPending: () => pending }))
import { useAssistantTyping } from '../../../../apps/desktop/src/components/assistant/useAssistantTyping'
import { ProgressContext } from '../../../../apps/desktop/src/components/assistant/assistantConversationProgressContext'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); pending.awaitingMessageId = 'source' })
function View() { return useAssistantTyping('chat', 'agent', '咕咕') }
it('removes the reply bubble once the real answer arrived, even while its engine settles', async () => {
  await harness.render(<View />)
  expect(harness.container.textContent).toContain('处理中')
  pending.awaitingMessageId = null
  await harness.render(<View />)
  expect(harness.container.textContent).toBe('')
})
it('reopens a moved assistant’s missing record once for each new input, without a retry loop', async () => {
  const retry = vi.fn()
  const context = { live: null, replies: new Map(), retryMissingRecord: retry }
  const render = () => harness.render(<ProgressContext.Provider value={context}><View /></ProgressContext.Provider>)
  await render()
  expect(retry).toHaveBeenCalledTimes(1)
  await render()
  expect(retry).toHaveBeenCalledTimes(1)
  pending.awaitingMessageId = 'next-source'
  await render()
  expect(retry).toHaveBeenCalledTimes(2)
})
