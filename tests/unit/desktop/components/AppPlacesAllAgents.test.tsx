// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { HERE_ALL, type EnablePlace } from '../../../../apps/desktop/src/session/shared/extensions/host-actions'

vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({
  Avatar: () => <span data-avatar />,
}))

import { AppPlacesEditor, AppPlacesSummary } from '../../../../apps/desktop/src/components/extensionBundle/AppPlaces'

/**
 * 编号 2 (10-12, 148 评审): a first install now ticks every agent on this computer. The sheet then showed 「All agents」 on and,
 * right under it, 「None chosen yet」 — read as nobody given. That line is only said when nobody is given at all.
 */
const places: EnablePlace[] = [
  { id: HERE_ALL, kind: 'here', enabled: true },
  { id: 'g1', kind: 'group', name: 'G1', enabled: false },
]
const NOBODY = /还没有选|None chosen yet|appEnable\.empty/

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
})

describe('the places editor with every agent here given', () => {
  for (const installing of [true, false]) {
    it(`says nothing of 「none chosen」 while every agent here is on (${installing ? 'install sheet' : 'App row'})`, async () => {
      await harness.render(createNode(AppPlacesEditor, { places, enabled: new Set([HERE_ALL]), onChange: () => {}, installing }))
      expect(harness.container.textContent ?? '').not.toMatch(NOBODY)
    })

    it(`[control] says it when nobody at all is given (${installing ? 'install sheet' : 'App row'})`, async () => {
      await harness.render(createNode(AppPlacesEditor, { places, enabled: new Set<string>(), onChange: () => {}, installing }))
      expect(harness.container.textContent ?? '').toMatch(NOBODY)
    })
  }
})

// 复核 10-15: an App's row on another machine's App page — 「给哪些 agent」 is that machine's agents, named as its; before,
// the folded line said 「本机所有 agent」 and the open editor 「这台电脑」 whichever machine was shown.
describe('the places of another machine are named as that machine\'s', () => {
  it('the folded line and the open editor say its name — and, as a control, 「本机」 / 「这台电脑」 for this one', async () => {
    await harness.render(createNode(AppPlacesSummary, { places, machineName: 'Mac 1' }))
    expect(harness.container.textContent).toContain('「Mac 1」上所有 agent')
    expect(harness.container.textContent).not.toContain('本机')
    await harness.render(createNode(AppPlacesEditor, { places, machineName: 'Mac 1', enabled: new Set([HERE_ALL]), onChange: () => {} }))
    expect(harness.container.textContent).toContain('Mac 1')
    expect(harness.container.textContent).not.toContain('这台电脑')

    await harness.render(createNode(AppPlacesSummary, { places }))
    expect(harness.container.textContent).toContain('本机所有 agent')
  })
})
