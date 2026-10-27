// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import {
  EXTENSION_CONSENT_ANSWER_EVENT,
  EXTENSION_CONSENT_EVENT,
  HERE_ALL,
  type EnablePlace,
  type ExtensionConsentAnswerDetail,
} from '../../../../apps/desktop/src/session/shared/extensions/host-actions'

vi.mock('../../../../apps/desktop/src/components/chat/DispatchSheet', () => ({ DispatchSheet: () => null }))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/ForumConsent', () => ({ ForumConsent: () => null }))

import { ExtensionConsentSheet } from '../../../../apps/desktop/src/components/extensionBundle/ExtensionConsentSheet'

/**
 * owner 10-27「安装卡……不关心给哪些 agent，关心给哪些设备」: the install sheet is one list of computers. The one asked for is
 * installed on, each other one ticked too, and on each every agent gets it; naming agents, groups and projects is the App page's.
 */
const places: EnablePlace[] = [
  { id: HERE_ALL, kind: 'here', enabled: false },
  { id: 'dm-1', kind: 'agent', name: 'Helper', enabled: false },
  { id: 'g1', kind: 'group', name: 'Ops', enabled: true },
]

let harness: ReturnType<typeof createReactHarness>
let answers: ExtensionConsentAnswerDetail[]
const onAnswer = (event: Event) => answers.push((event as CustomEvent<ExtensionConsentAnswerDetail>).detail)
beforeEach(() => {
  harness = createReactHarness()
  answers = []
  window.addEventListener(EXTENSION_CONSENT_ANSWER_EVENT, onAnswer)
})
afterEach(() => {
  window.removeEventListener(EXTENSION_CONSENT_ANSWER_EVENT, onAnswer)
  harness.cleanup()
})

async function ask() {
  await harness.render(createNode(ExtensionConsentSheet, {}))
  await act(async () => {
    window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_EVENT, { detail: {
      type: 'ask', requestId: 'r1', title: 'Install Board?', description: 'A board.', confirmLabel: 'Install', places,
      alsoOn: [{ id: 'dev-b', label: 'Linux 1' }, { id: 'dev-c', label: 'Mac 2', disabledReason: 'Only this computer can read the folder' }],
    } }))
  })
}
const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)

describe('the install sheet asks which computers', () => {
  it('lists this computer (installed, fixed) and the others to tick — no agent, group or project picker', async () => {
    await ask()
    const target = q<HTMLInputElement>('[data-testid="extension-consent-device-target"]')!
    expect(target.checked && target.disabled).toBe(true)
    expect(q('[data-testid="extension-consent-devices"]')!.textContent).toMatch(/Linux 1.*Mac 2/)
    expect(q<HTMLInputElement>('[data-testid="extension-consent-also-on-dev-c"]')!.disabled).toBe(true)
    expect(q('[data-testid="app-places"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Helper')
  })

  it('a yes gives every agent on the computers installed on, keeping what was given already', async () => {
    await ask()
    await act(async () => { q<HTMLInputElement>('[data-testid="extension-consent-also-on-dev-b"]')!.click() })
    await act(async () => { q<HTMLButtonElement>('[data-testid="extension-consent-confirm"]')!.click() })
    expect(answers).toEqual([{ requestId: 'r1', outcome: 'confirmed', enableIn: ['g1', HERE_ALL], alsoOn: ['dev-b'] }])
  })
})
