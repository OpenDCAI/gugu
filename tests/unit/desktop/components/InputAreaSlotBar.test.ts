// @vitest-environment jsdom
// gugu-dev#181 ⑫:画在会话页格子里(项目块、对话块)的对话,输入框的「+ / 新任务 / 定时任务 / 发送」进框内底排;
// 手机和格子外照旧是两坞在框外 —— 手机那一支不能跟着变。
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputArea } from '../../../../apps/desktop/src/components/chat/InputArea'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { InChatSlot } from '../../../../apps/desktop/src/lib/shellSlots'

const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
vi.mock('textarea-caret', () => ({ default: () => ({ left: 0, top: 5, height: 20 }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  setLocalePreference('en-US')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  shell.mobile = false
})

async function render(inSlot: boolean) {
  await act(async () => {
    root.render(createElement(InChatSlot.Provider, { value: inSlot }, createElement(InputArea, { onSend: vi.fn(async () => {}) })))
  })
  const box = (container.querySelector('textarea') as HTMLTextAreaElement).parentElement as HTMLElement
  return { sendInBox: !!box.querySelector('button[aria-label="Send"]'), sendInPage: !!container.querySelector('button[aria-label="Send"]') }
}

describe('InputArea in a chat slot', () => {
  it('puts send (with + and the verbs) on the bottom row inside the box', async () => {
    expect(await render(true)).toEqual({ sendInBox: true, sendInPage: true })
  })
  it('keeps the docks outside the box outside a slot', async () => {
    expect(await render(false)).toEqual({ sendInBox: false, sendInPage: true })
  })
  it('keeps the phone layout unchanged even inside a slot', async () => {
    shell.mobile = true
    expect(await render(true)).toEqual({ sendInBox: false, sendInPage: true })
  })
})
