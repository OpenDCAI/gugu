// @vitest-environment jsdom
// gugu-dev#181 ⑫:画在会话页格子里(项目块、对话块)的对话,输入框的「+ / 新任务 / 定时任务 / 发送」进框内底排;
// 手机和格子外照旧是两坞在框外 —— 手机那一支不能跟着变。
import { act, createElement, useCallback, useMemo, useState, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputArea } from '../../../../apps/desktop/src/components/chat/InputArea'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { InChatSlot } from '../../../../apps/desktop/src/lib/shellSlots'
import { setComposerVerb } from '../../../../apps/desktop/src/lib/composerVerbBridge'
import { ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import { chatStore } from '../../../support/testHarness'

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

// 点了新任务框标签上的 ×:那一框写的话沿 composerVerbBridge 的 carry 交回群输入框(原型里两者就是同一个框)。
function DraftHost({ chatId }: { chatId: string }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const setDraft = useCallback((id: string, update: SetStateAction<string>) => setDrafts((p) => ({
    ...p, [id]: typeof update === 'function' ? update(p[id] ?? '') : update,
  })), [])
  const value = useMemo(() => ({ ...chatStore(), drafts, setDraft }), [drafts, setDraft])
  return createElement(ChatStoreProvider, { value }, createElement(InChatSlot.Provider, { value: true },
    createElement(InputArea, { onSend: vi.fn(async () => {}), chatId, isGroupChat: true })))
}

describe('InputArea and the new-task box', () => {
  it('takes back what was written in the new-task box when its tag is closed', async () => {
    await act(async () => { root.render(createElement(DraftHost, { chatId: 'chat-carry' })) })
    const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => { setComposerVerb('chat-carry', 'task') })
    expect(textarea().closest('[style*="display: none"]'), 'the group box steps aside while the new task is open').not.toBeNull()
    await act(async () => { setComposerVerb('chat-carry', null, 'add a pricing page') })
    expect(textarea().closest('[style*="display: none"]')).toBeNull()
    expect(textarea().value).toBe('add a pricing page')
  })
})
