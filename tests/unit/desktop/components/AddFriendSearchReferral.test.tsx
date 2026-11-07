// @vitest-environment jsdom
import { act } from 'react'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

let AddFriendSearch: typeof import('../../../../apps/desktop/src/components/AddFriendSearch')['AddFriendSearch']
let harness: ReturnType<typeof createReactHarness>

beforeAll(async () => {
  vi.stubEnv('VITE_REFERRAL_ENTRY_PREVIEW', '1')
  ;({ AddFriendSearch } = await import('../../../../apps/desktop/src/components/AddFriendSearch'))
})
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })
afterAll(() => { vi.unstubAllEnvs() })

describe('empty contact search referral suggestion', () => {
  it('shows the empty result before offering an invitation after a completed search', async () => {
    const searchUsers = vi.fn(async () => {})
    await renderWithAppProviders(harness, createNode(AddFriendSearch), {
      contacts: { searchResults: [], searchUsers },
    })
    const input = harness.container.querySelector('input')!
    await typeInto(input, 'missing-person@example.test')
    expect(harness.container.querySelector('[data-testid="referral-preview-search"]')).toBeNull()

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(searchUsers).toHaveBeenCalledWith('missing-person@example.test')
    const emptyText = i18n.t('friendSearch.noResults', { ns: 'contacts' })
    const empty = [...harness.container.querySelectorAll('div')].find(element => element.textContent === emptyText)
    const invitation = harness.container.querySelector('[data-testid="referral-preview-search"]')
    expect(empty).toBeDefined()
    expect(invitation).not.toBeNull()
    expect(empty!.compareDocumentPosition(invitation!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await typeInto(input, 'another-person@example.test')
    expect(harness.container.querySelector('[data-testid="referral-preview-search"]')).toBeNull()
  })
})
