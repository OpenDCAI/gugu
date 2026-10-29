import { expect, it, vi } from 'vitest'
import { setSessionAdmissionPreparation } from '../../../../apps/desktop/electron/session/main/core/sessions/session-admission-preparation'

// The ACP runtime (SessionCell) runs in its own process. The host installs the assistant panel's
// preparation in its module graph; the runtime's copy of the module is a different instance.
async function runtimeGraph() {
  vi.resetModules()
  return import('../../../../packages/session-runtime/src/acp-agents/session/prompt-preparation')
}

it('delivers the notice the host prepared for a bound assistant session to that session\'s turn in the runtime process', async () => {
  const accepted = vi.fn(async () => {})
  const asked = vi.fn()
  setSessionAdmissionPreparation(async (sessionId, text) => {
    asked(sessionId)
    return sessionId === 'session-a'
      ? { text, beforeText: '<resource_changes>\n飞书已连接，要用就派任务\n</resource_changes>', accepted, assistantPanel: true }
      : { text, accepted: async () => {} }
  })
  const runtime = await runtimeGraph()
  const prepared = await runtime.prepareNativePrompt('session-a')
  // The id the panel bound is the id the turn asks with.
  expect(asked).toHaveBeenCalledWith('session-a')
  expect(prepared?.beforeText).toContain('飞书已连接，要用就派任务')
  await prepared!.accepted()
  expect(accepted).toHaveBeenCalledOnce()
  setSessionAdmissionPreparation(null)
})
