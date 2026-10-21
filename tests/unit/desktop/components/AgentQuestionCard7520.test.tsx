// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settlement, SessionpageSessionRespondResult } from '@gugu/session-core/session-record/contract'
import { AgentQuestionCard } from '../../../../apps/desktop/src/components/chat/AgentQuestionCard'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => <span>{content}</span> }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
const request = (id: string): Settlement => ({ itemId: id, kind: 'question', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null, questions: [
  { question: '预算？', multiSelect: false, options: [{ optionId: '300', name: '300 元' }] },
  { question: '风格？', multiSelect: false, options: [{ optionId: 'casual', name: '休闲' }] },
] })
const click = async (selector: string) => act(async () => { (harness.container.querySelector(selector) as HTMLButtonElement).click() })

describe('compact question card', () => {
  it('deferring does not answer; all questions need an explicit final submit', async () => {
    const respond = vi.fn(async () => ({ accepted: true } as SessionpageSessionRespondResult))
    await renderWithAppProviders(harness, <AgentQuestionCard scope="owner:session" settlement={request('explicit-submit')} respond={respond} />)
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(true)
    await click('.agent-question-card__later')
    expect(respond).not.toHaveBeenCalled()
    await click('.agent-question-receipt button')
    await click('.agent-question-card__option')
    await click('.agent-question-card__submit')
    expect(respond).not.toHaveBeenCalled()
    await click('.agent-question-card__option')
    await click('.agent-question-card__submit')
    expect(respond).toHaveBeenCalledWith([{ selected: ['300'] }, { selected: ['casual'] }])
    expect(harness.container.querySelector('[data-testid="agent-question-card"], [data-testid="agent-question-receipt"]')).toBeNull()
  })

  it('does not claim success after a delivery failure and prevents repeated in-flight submission', async () => {
    let reject!: (error: Error) => void
    const respond = vi.fn(() => new Promise<SessionpageSessionRespondResult>((_resolve, fail) => { reject = fail }))
    await renderWithAppProviders(harness, <AgentQuestionCard scope="owner:session" settlement={request('delivery-failed')} respond={respond} />)
    await click('.agent-question-card__option'); await click('.agent-question-card__submit')
    await click('.agent-question-card__option')
    // Do not await the unresolved delivery, only the event dispatch.
    act(() => { (harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).click() })
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(true)
    expect(respond).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('disconnected')) })
    expect(harness.container.querySelector('[data-testid="agent-question-receipt"]')).toBeNull()
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(false)
  })
})
