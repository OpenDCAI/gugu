// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog } from '../../../apps/desktop/src/components/ui/Dialog'
import { Sheet } from '../../../apps/desktop/src/components/ui/Sheet'
import { PhoneConfirmDialog } from '../../../apps/desktop/src/mobile/assistant/PhoneConfirmDialog'
import { createNode, createReactHarness, clickElement } from '../../support/testHarness'
import { expectExit, frame, holdDialogExit } from '../../support/dialogExit'

let h: ReturnType<typeof createReactHarness>
let exit: ReturnType<typeof holdDialogExit>
beforeEach(() => { h = createReactHarness(); exit = holdDialogExit() })
afterEach(() => { h.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })

it('keeps the last committed sheet body and releases it only after the exit finishes', async () => {
  const closed = vi.fn()
  const render = (open: boolean) => h.render(createNode(Sheet, { open, onClose: vi.fn(), onClosed: closed, children: open ? 'Last request' : null, testId: 'retained' }))
  await render(true)
  await frame()
  const popup = document.querySelector<HTMLElement>('[data-testid="retained"]')!
  await render(false)
  expect(popup.textContent).toContain('Last request')
  expect(closed).not.toHaveBeenCalled()
  await expectExit(popup, exit)
  expect(closed).toHaveBeenCalledOnce()
})

it('a rapid reopen cancels the old completion and retains the new request', async () => {
  const closed = vi.fn()
  const render = (text: string | null) => h.render(createNode(Sheet, { open: text !== null, onClose: vi.fn(), onClosed: closed, children: text, testId: 'rapid' }))
  await render('Old request'); await frame()
  await render(null); await frame()
  await render('New request'); await frame()
  await exit.finish()
  expect(closed).not.toHaveBeenCalled()
  expect(document.querySelector('[data-testid="rapid"]')?.textContent).toContain('New request')
})

it('parent unmount aborts completion callbacks instead of navigating afterwards', async () => {
  const closed = vi.fn()
  await h.render(createNode(Sheet, { open: true, onClose: vi.fn(), onClosed: closed, children: 'Request' }))
  await frame()
  await h.render(createNode(Sheet, { open: false, onClose: vi.fn(), onClosed: closed, children: null }))
  await frame()
  await h.render(null)
  await exit.finish()
  expect(closed).not.toHaveBeenCalled()
  expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull()
})

it('without an animation, closing completes immediately', async () => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] })
  const closed = vi.fn()
  await h.render(createNode(Sheet, { open: true, onClose: vi.fn(), onClosed: closed, children: 'Request' })); await frame()
  await h.render(createNode(Sheet, { open: false, onClose: vi.fn(), onClosed: closed, children: null })); await frame()
  expect(closed).toHaveBeenCalledOnce()
})

it('preserves Base UI payload render functions', async () => {
  await h.render(createNode(Dialog.Root, { open: true, children: ({ payload }: { payload: unknown }) => createNode(Dialog.Portal, { children: createNode(Dialog.Popup, { children: String(payload) }) }) }))
  expect(document.querySelector('[data-slot="dialog-popup"]')?.textContent).toBe('undefined')
})

it('a successful confirmation navigates only after exit; a failure stays open', async () => {
  const navigate = vi.fn()
  const action = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
  function Parent() {
    const [open, setOpen] = useState(true)
    return createNode(PhoneConfirmDialog, { open, title: 'Delete request', body: 'Request data', confirmLabel: 'Delete', failedText: 'Retry', onConfirm: action, onConfirmed: navigate, onClose: () => setOpen(false), testId: 'confirm' })
  }
  await h.render(createNode(Parent)); await frame()
  await clickElement(document.querySelector('[data-testid="confirm-confirm"]')!)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Retry')
  expect(navigate).not.toHaveBeenCalled()
  await clickElement(document.querySelector('[data-testid="confirm-confirm"]')!)
  const popup = document.querySelector<HTMLElement>('[data-testid="confirm"]')!
  expect(navigate).not.toHaveBeenCalled()
  await expectExit(popup, exit)
  expect(navigate).toHaveBeenCalledOnce()
})
