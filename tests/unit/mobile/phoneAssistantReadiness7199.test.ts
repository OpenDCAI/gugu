// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../support/testHarness'
import { usePhoneMachine } from '../../../apps/desktop/src/mobile/assistant/phoneMachine'
vi.mock('../../../apps/desktop/src/components/assistant/assistant-panel-files',() => ({ useCloudAssistantFiles: () => undefined }))
it('finishes with a missing-home error instead of showing an endless opening spinner', async () => {
  const harness = createReactHarness()
  let state: unknown
  function Probe() { state = usePhoneMachine(null,'assistant','chat'); return null }
  try { await harness.render(createNode(Probe,{})); expect(state).toMatchObject({ state: 'error',error: { code: 'missing-home' } }) }
  finally { harness.cleanup() }
})
