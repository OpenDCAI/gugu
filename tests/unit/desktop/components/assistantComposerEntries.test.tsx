// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantComposerEntries } from '../../../../apps/desktop/src/components/assistant/AssistantComposerEntries'
import { offerCustomizeCard, useCustomizeCardOffered, customizeCardOffered } from '../../../../apps/desktop/src/lib/assistantSetupState'
import { ideasEntryHidden, requestIdeas, setIdeasEntryHidden } from '../../../../apps/desktop/src/lib/assistantIdeas'
import { useIdeasOpen } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ideas'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
const openCustomize = vi.fn()
function Entries({ busy = false }: { busy?: boolean }) {
  const offered = useCustomizeCardOffered('composer-owner')
  const [ideasOpen] = useIdeasOpen()
  return <><AssistantComposerEntries assistantId="composer-assistant" busy={busy} onOpen={requestIdeas}
    customize={offered ? { ownerUserId: 'composer-owner', name: '咕咕', onOpen: openCustomize } : undefined} /><output>{ideasOpen ? 'ideas opened' : ''}</output></>
}
beforeEach(() => { localStorage.clear(); openCustomize.mockReset(); harness = createReactHarness() })
afterEach(() => harness.cleanup())
const row = () => harness.container.querySelector('[data-testid="assistant-composer-entries"]')!
const byId = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

describe('assistant composer entry row', () => {
  it('places both entries in one parent and opens ideas through the existing event', async () => {
    offerCustomizeCard('composer-owner')
    await renderWithAppProviders(harness, <Entries />)
    expect(row().children.length).toBe(2)
    expect(row().firstElementChild).toBe(byId('assistant-customize-card'))
    expect(row().lastElementChild).toBe(byId('assistant-ideas-entry'))
    await clickElement(byId('assistant-ideas-entry'))
    expect(harness.container.querySelector('output')?.textContent).toBe('ideas opened')
  })
  it('retains only the ideas entry after dismissing customization', async () => {
    offerCustomizeCard('composer-owner')
    await renderWithAppProviders(harness, <Entries />)
    await clickElement(byId('assistant-customize-card-dismiss'))
    expect(customizeCardOffered('composer-owner')).toBe(false)
    expect(row().children.length).toBe(1)
    expect(row().firstElementChild).toBe(byId('assistant-ideas-entry'))
    expect(openCustomize).not.toHaveBeenCalled()
  })
  it('opens customization through its original callback and retires the offer', async () => {
    offerCustomizeCard('composer-owner')
    await renderWithAppProviders(harness, <Entries />)
    await clickElement(byId('assistant-customize-card-open'))
    expect(openCustomize).toHaveBeenCalledOnce()
    expect(customizeCardOffered('composer-owner')).toBe(false)
    expect(row().children.length).toBe(1)
  })
  it('has no entry nodes when both are hidden and reacts to the ideas preference', async () => {
    setIdeasEntryHidden('composer-assistant', true)
    await renderWithAppProviders(harness, <Entries />)
    expect(row().childNodes.length).toBe(0)
    await act(async () => setIdeasEntryHidden('composer-assistant', false))
    expect(row().children.length).toBe(1)
  })
  it('suppresses the ideas entry while recording without altering the saved preference', async () => {
    await renderWithAppProviders(harness, <Entries busy />)
    expect(row().childNodes.length).toBe(0)
    expect(ideasEntryHidden('composer-assistant')).toBe(false)
    await renderWithAppProviders(harness, <Entries />)
    expect(row().children.length).toBe(1)
  })
})
