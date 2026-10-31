// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { scheduleComposerFocus, shouldFocusComposer } from '@/lib/focusComposer'

// owner 10-28 手机试用:发完一条键盘不收、整个 App 闪一下(键盘收了又被抢回输入框)。
describe('after a message is sent', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function mount() {
    const editor = document.body.appendChild(document.createElement('div'))
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    const send = document.body.appendChild(document.createElement('button'))
    return { editor, send }
  }

  it('the phone shell never takes focus back after the shared composer blurs', async () => {
    const { editor, send } = mount()
    send.focus()
    expect(shouldFocusComposer('message-sent', { mobileShell: true })).toBe(false)
    send.blur()
    scheduleComposerFocus('message-sent', { target: () => editor, mobileShell: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(document.body)
  })

  it('the desktop keeps typing in the composer', async () => {
    const { editor, send } = mount()
    send.focus()
    expect(shouldFocusComposer('message-sent', { mobileShell: false })).toBe(true)
    scheduleComposerFocus('message-sent', { target: () => editor, mobileShell: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(editor)
  })
})
