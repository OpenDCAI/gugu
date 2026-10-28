// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import {
  EXTENSION_CONSENT_ANSWER_EVENT,
  EXTENSION_CONSENT_EVENT,
  type InstallGrant,
  type ExtensionConsentAnswerDetail,
} from '../../../../apps/desktop/src/session/shared/extensions/host-actions'

vi.mock('../../../../apps/desktop/src/components/chat/DispatchSheet', () => ({ DispatchSheet: () => null }))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/ForumConsent', () => ({ ForumConsent: () => null }))
// The person's computers as this window follows them: Linux 1 is offline (the machine picker greys it, so does the sheet).
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    hosts: new Map([['dev-d', { device: { id: 'dev-d', label: 'Linux 4', isOnline: false, platform: 'linux', lastSeenAt: null } }]]),
    connectionState: () => null,
  },
}))

import { ExtensionConsentSheet } from '../../../../apps/desktop/src/components/extensionBundle/ExtensionConsentSheet'

/**
 * owner 10-27「安装卡……不关心给哪些 agent，关心给哪些设备」: the install sheet is one list of computers. The one asked for is
 * installed on, each other one ticked too, and on each every agent gets it; naming agents, groups and projects is the App page's.
 */
/** A first install where it lands: every agent there gets it. */
const fresh: InstallGrant = { first: true }
/** Installed there already and narrowed; an agent installs it again for group Ops: that one group is added. */
const forGroup: InstallGrant = { first: false, chat: { id: 'g1', name: 'Ops' } }

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

const others = [{ id: 'dev-b', label: 'Linux 1' }, { id: 'dev-c', label: 'Mac 2', disabledReason: 'Only this computer can read the folder' }, { id: 'dev-d', label: 'Linux 4' }]
async function ask(given: InstallGrant | null = fresh, requestId = 'r1', render = true, requester?: { name: string }, alsoOn: typeof others = others) {
  if (render) await harness.render(createNode(ExtensionConsentSheet, {}))
  await act(async () => {
    window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_EVENT, { detail: {
      type: 'ask', requestId, title: `Install ${requestId}?`, description: 'A board.', confirmLabel: 'Install', ...(given ? { given } : {}), ...(requester ? { requester } : {}),
      ...(alsoOn.length ? { alsoOn } : {}),
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
    // Each row is the machine picker's own row: another computer carries its online dot, and its state on the right.
    expect(q('[data-device-id="dev-b"] [data-slot="machine-dot"]')).not.toBeNull()
    expect(q('[data-device-id=""] [data-slot="machine-dot"]')).toBeNull()
    expect(q('[data-testid="app-places"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Helper')
  })

  it('a first install says every agent on a newly installed computer gets it; the yes carries the computers ticked and nothing about agents', async () => {
    await ask()
    expect(q('[data-testid="extension-consent-grant"]')!.textContent).not.toMatch(/Ops/)
    await act(async () => { q<HTMLInputElement>('[data-testid="extension-consent-also-on-dev-b"]')!.click() })
    await act(async () => { q<HTMLButtonElement>('[data-testid="extension-consent-confirm"]')!.click() })
    expect(answers).toEqual([{ requestId: 'r1', outcome: 'confirmed', alsoOn: ['dev-b'] }])
  })

  it('an offline computer is listed, greyed and not to be ticked, as the machine picker lists it', async () => {
    await ask()
    expect(q<HTMLInputElement>('[data-testid="extension-consent-also-on-dev-d"]')!.disabled).toBe(true)
    expect(q('[data-device-id="dev-d"] [data-slot="machine-dot"]')!.getAttribute('data-state')).toBe('offline')
  })

  it('with no other computer there is nothing to choose: no list, the sentence about who gets it stays', async () => {
    await ask(fresh, 'r1', true, undefined, [])
    expect(q('[data-testid="extension-consent-devices"]')).toBeNull()
    expect(q('[data-testid="extension-consent-grant"]')).not.toBeNull()
  })

  it('an install for a group on a narrowed computer says it adds that one group, and nothing else', async () => {
    await ask(forGroup)
    expect(q('[data-testid="extension-consent-grant"]')!.textContent).toMatch(/Ops/)
  })

  it('a second ask while the first is open waits its turn: each is answered, ❌ the first left unanswered under it', async () => {
    await ask(fresh, 'r1')
    await ask(fresh, 'r2', false)
    expect(document.body.textContent).toContain('Install r1?')
    await act(async () => { q<HTMLButtonElement>('[data-testid="extension-consent-cancel"]')!.click() })
    expect(document.body.textContent).toContain('Install r2?')
    await act(async () => { q<HTMLButtonElement>('[data-testid="extension-consent-confirm"]')!.click() })
    expect(answers.map(({ requestId, outcome }) => [requestId, outcome])).toEqual([['r1', 'declined'], ['r2', 'confirmed']])
  })

  it("an agent's ask: the no is 「不装」, and closing it (Esc) is no answer", async () => {
    await ask(forGroup, 'r1', true, { name: 'Claude 8' })
    expect(q('[data-testid="extension-consent-cancel"]')!.textContent).toBe('不装')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(answers.map(({ outcome }) => outcome)).toEqual(['dismissed'])
  })

  it('an App giving agents no tools says nothing about agents', async () => {
    await ask(null)
    expect(q('[data-testid="extension-consent-grant"]')).toBeNull()
  })
})
