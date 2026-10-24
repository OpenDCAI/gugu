// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('section', { role: 'dialog' }, children) }))
import { ContactsLetterPicker } from '../../../../apps/desktop/src/components/contacts/ContactsLetterPicker'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
const button = (text: string) => [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!
it('offers the present sections and closes after one explicit selection', async () => {
  const pick = vi.fn()
  await harness.render(createNode(ContactsLetterPicker, { present: new Set(['A', 'Z']), onPick: pick }))
  await clickElement(button('A–Z'))
  expect(button('A').disabled).toBe(false)
  expect(button('B').disabled).toBe(true)
  await clickElement(button('Z'))
  expect(pick).toHaveBeenCalledExactlyOnceWith('Z')
  expect(harness.container.querySelector('[role="dialog"]')).toBeNull()
})
it('returns without scrolling when the user closes the letter picker', async () => {
  const pick = vi.fn()
  await harness.render(createNode(ContactsLetterPicker, { present: new Set(['A']), onPick: pick }))
  await clickElement(button('A–Z'))
  await clickElement(harness.container.querySelector('[aria-label="返回联系人"]')!)
  expect(pick).not.toHaveBeenCalled()
  expect(harness.container.querySelector('[role="dialog"]')).toBeNull()
})
