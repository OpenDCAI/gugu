// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { settleComposerAfterSend, shouldFocusComposer } from '@/lib/focusComposer'

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

  it('the phone shell dismisses the keyboard and never takes focus back', async () => {
    const { editor, send } = mount()
    send.focus()
    expect(shouldFocusComposer('message-sent', { mobileShell: true })).toBe(false)
    settleComposerAfterSend({ target: () => editor, mobileShell: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(document.body)

    editor.focus()
    settleComposerAfterSend({ target: () => editor, mobileShell: true })
    expect(document.activeElement).toBe(document.body)
  })

  it('the desktop keeps typing in the composer', async () => {
    const { editor, send } = mount()
    send.focus()
    expect(shouldFocusComposer('message-sent', { mobileShell: false })).toBe(true)
    settleComposerAfterSend({ target: () => editor, mobileShell: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(editor)
  })
})
