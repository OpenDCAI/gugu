// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, clickElement, deferred, typeInto } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/lib/assistantSetup', () => ({ ASSISTANT_NAME_MAX: 30 }))
import { AssistantNameInline } from '../../../../apps/desktop/src/components/assistant/AssistantNameInline'

let ui: ReturnType<typeof createReactHarness>
beforeEach(() => { ui = createReactHarness() })
afterEach(() => ui.cleanup())
const input = () => ui.container.querySelector<HTMLInputElement>('input')!
const key = async (key: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

describe('assistant name edits in place', () => {
  it('starts as the name itself, without an input or save button', async () => {
    await ui.render(createNode(AssistantNameInline, { name: 'bc', onCommit: vi.fn() }))
    expect(input()).toBeNull()
    expect(ui.container.querySelectorAll('button')).toHaveLength(1)
    expect(ui.container.querySelector('button')?.textContent).toBe('bc')
    await clickElement(ui.container.querySelector('button')!)
    expect(input().value).toBe('bc')
  })
  it('Enter plus blur commits once while the request is in flight', async () => {
    const pending = deferred<void>(); const commit = vi.fn(() => pending.promise)
    await ui.render(createNode(AssistantNameInline, { name: 'bc', onCommit: commit }))
    await clickElement(ui.container.querySelector('button')!); await typeInto(input(), 'new name')
    await key('Enter'); await act(async () => input().blur())
    expect(commit).toHaveBeenCalledExactlyOnceWith('new name')
    await act(async () => pending.resolve())
    expect(input()).toBeNull()
  })
  it('Escape cancels without saving the changed draft on blur', async () => {
    const commit = vi.fn()
    await ui.render(createNode(AssistantNameInline, { name: 'bc', onCommit: commit }))
    await clickElement(ui.container.querySelector('button')!); await typeInto(input(), 'discard')
    await key('Escape')
    expect(commit).not.toHaveBeenCalled(); expect(input()).toBeNull()
    expect(ui.container.querySelector('button')?.textContent).toBe('bc')
  })
  it('keeps the draft and a short notification if saving fails', async () => {
    const commit = vi.fn(async () => { throw new Error('Permission denied at /Users/private/readability sk-synthetic-secret') })
    await ui.render(createNode(AssistantNameInline, { name: 'bc', onCommit: commit }))
    await clickElement(ui.container.querySelector('button')!); await typeInto(input(), 'keep me'); await key('Enter')
    expect(input().value).toBe('keep me'); expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(ui.container.querySelector('[role="alert"]')).not.toBeNull()
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe('Permission denied at [path] [redacted token]')
  })
})
