// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'
import { agentOfSession, useAgentNames } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
it('keeps the account agent name after cold startup while the contacts relationship list is empty', async () => {
  function Fixture() {
    const agent = agentOfSession({ conversationId: 'session', title: 'G0 complete', agent: { userId: 'agent' } } as never, useAgentNames())
    return <span>{agent?.displayName}</span>
  }
  await renderWithAppProviders(harness, <Fixture />, { chat: { identitiesById: { agent: displayIdentity('agent', { type: 'agent', display_name: 'Claude 3' }) } }, contacts: { contacts: [] } })
  expect(harness.container.textContent).toBe('Claude 3')
})
