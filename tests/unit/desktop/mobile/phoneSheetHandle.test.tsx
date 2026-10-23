// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const shell = vi.hoisted(() => ({ mobile: true }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
vi.mock('../../../../apps/desktop/src/components/ui/IconButton', () => ({
  IconButton: ({ children, size: _size, ...props }: { children: ReactNode; size?: string }) => createElement('button', props, children),
}))
import { PhoneSheetHandle } from '../../../../apps/desktop/src/mobile/PhoneSheetHandle'

const active: Array<ReturnType<typeof createReactHarness>> = []
afterEach(async () => { for (const h of active.splice(0)) await h.cleanup(); shell.mobile = true })

async function render(disabled = false) {
  const close = vi.fn(), h = createReactHarness(); active.push(h)
  const view = (off: boolean) => createElement('section', { role: 'dialog' }, createElement(PhoneSheetHandle, { onDismiss: close, disabled: off }), createElement('textarea', { defaultValue: '保留未保存的草稿' }))
  await h.render(view(disabled))
  const popup = document.querySelector<HTMLElement>('[role="dialog"]')!
  popup.getBoundingClientRect = () => ({ height: 400 }) as DOMRect
  const button = popup.querySelector('button')!
  if (button) button.setPointerCapture = vi.fn()
  return { close, popup, button, h, view }
}
async function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerId: id, isPrimary: id === 1, pointerType: 'touch', clientX: x, clientY: y }).map(([k,v]) => [k, { value: v }])))
  await act(async () => { target.dispatchEvent(event) })
}
async function click(target: HTMLElement, detail = 1) { await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })) }) }

describe('phone sheet handle', () => {
  it('follows a downward handle drag, dismisses once, and clears the transient style', async () => {
    const { button, popup, close } = await render()
    await pointer(button, 'pointerdown', 40, 20); await pointer(button, 'pointermove', 42, 135)
    expect(popup.style.translate).toBe('0 115px')
    await pointer(button, 'pointerup', 42, 135); await click(button)
    expect(close).toHaveBeenCalledTimes(1)
    expect(popup.style.translate).toBe('')
    expect(popup.style.transition).toBe('')
  })
  it('does not dismiss on short, horizontal, upward or cancelled movement', async () => {
    const { button, close } = await render()
    for (const [x,y,end] of [[42,45,'pointerup'],[160,80,'pointerup'],[42,-50,'pointerup'],[42,180,'pointercancel']] as const) {
      await pointer(button,'pointerdown',40,20); await pointer(button,'pointermove',x,y); await pointer(button,end,x,y); await click(button)
    }
    expect(close).not.toHaveBeenCalled()
    await click(button,0)
    expect(close).toHaveBeenCalledTimes(1) // keyboard activation remains available after a cancelled drag
  })
  it('leaves body scrolling and draft edits alone and ignores a second pointer', async () => {
    const { popup, button, close } = await render()
    const body = popup.querySelector('textarea')!
    await pointer(body,'pointerdown',40,20); await pointer(body,'pointermove',40,200); await pointer(body,'pointerup',40,200)
    expect(close).not.toHaveBeenCalled(); expect(body.value).toBe('保留未保存的草稿')
    await pointer(button,'pointerdown',40,20); await pointer(button,'pointermove',40,200,2); await pointer(button,'pointerup',40,200,2)
    expect(popup.style.translate).toBe(''); expect(close).not.toHaveBeenCalled()
    await pointer(button,'pointercancel',40,20)
  })
  it('cancels a gesture when saving disables dismissal, without dropping a draft', async () => {
    const { popup, button, h, view, close } = await render()
    await pointer(button,'pointerdown',40,20); await pointer(button,'pointermove',40,150)
    await h.render(view(true))
    expect(popup.style.translate).toBe('')
    await pointer(button,'pointerup',40,150)
    expect(close).not.toHaveBeenCalled(); expect(popup.querySelector('textarea')?.value).toBe('保留未保存的草稿')
  })
  it('is hidden outside the mobile shell', async () => {
    shell.mobile = false
    const { button } = await render()
    expect(button).toBeNull()
  })
})
