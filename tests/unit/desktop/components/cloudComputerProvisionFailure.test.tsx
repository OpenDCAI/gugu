// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { CloudComputerProvisionPanel } from '../../../../apps/desktop/src/components/settings/CloudComputerSection'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

async function refusal(reason?: string) {
  const snapshot: CloudComputerSnapshot = { state: 'error', error: 'service wording', reason, deviceId: null, since: null }
  await harness.render(createElement(CloudComputerProvisionPanel, { snapshot, device: null }))
  return harness.container.querySelector('[data-testid="cloud-computer-refusal"]')!
}

it('names the reason the service reported, in the client own words', async () => {
  const shown = await refusal('server_start_failed')
  expect(shown.getAttribute('data-kind')).toBe('server_start_failed')
  expect(shown.textContent).not.toContain('service wording')
})

it.each([undefined, 'a_word_from_a_newer_service'])('stays generic for reason %s', async reason => {
  expect((await refusal(reason)).getAttribute('data-kind')).toBe('failed')
})
