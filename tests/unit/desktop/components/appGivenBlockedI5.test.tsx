// @vitest-environment jsdom
// App architecture I5: the App page's 「给了…」 summary agrees with the runtime. Switched off here, or its agent tools taken back,
// no agent gets them whoever it is given to — the summary says so instead of listing who it is 「given to」.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { HERE_ALL } from '../../../../apps/desktop/src/session/shared/extensions/host-actions'

const { AppGivenSection } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-given-section')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

const api = {
  appPlaces: async () => ({ success: true as const, data: [{ id: HERE_ALL, kind: 'here' as const, enabled: true }] }),
  changeAppPlaces: async () => ({ success: true as const }),
}
async function section(blocked?: 'off' | 'revoked') {
  await harness.render(createNode(AppGivenSection, { extensionId: 'searcher', api: api as never, ...(blocked ? { blocked } : {}) }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return harness.container
}

describe('I5 — the 「给了…」 summary says what the runtime does', () => {
  it('switched off here: says no agent gets its tools, not 「given to all agents here」', async () => {
    const root = await section('off')
    expect(root.querySelector('[data-testid="extension-given-blocked"]')).not.toBeNull()
  })

  it('its agent tools taken back: says so', async () => {
    const root = await section('revoked')
    expect(root.querySelector('[data-testid="extension-given-blocked"]')).not.toBeNull()
  })

  it('[control] on and allowed: the summary lists who it is given to', async () => {
    const root = await section()
    expect(root.querySelector('[data-testid="extension-given-blocked"]')).toBeNull()
    expect(root.querySelector('[data-testid="extension-given-searcher"]')).not.toBeNull()
  })
})
