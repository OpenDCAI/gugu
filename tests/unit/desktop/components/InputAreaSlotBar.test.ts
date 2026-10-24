// @vitest-environment jsdom
// gugu-dev#181 ⑫:画在会话页格子里(项目块、对话块)的对话,输入框的「+ / 新任务 / 发送」进框内底排;
// 手机和格子外照旧是两坞在框外 —— 手机那一支不能跟着变。
import { act, createElement, useCallback, useMemo, useState, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readComposer } from '../../../support/composerEditor'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { InChatSlot } from '../../../../apps/desktop/src/lib/shellSlots'
import { sessionComposerDockedWidthClassName } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-composer-styles'
import { setComposerVerb } from '../../../../apps/desktop/src/lib/composerVerbBridge'
import { ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import { chatStore } from '../../../support/testHarness'

const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
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

async function render(inSlot: boolean, projectName: string | null = null) {
  await act(async () => {
    root.render(createElement(InChatSlot.Provider, { value: inSlot ? { projectName } : null }, createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}) })))
  })
  const input = container.querySelector('[contenteditable]') as HTMLElement
  const bar = input.closest('[data-slot="composer-bar"]')!
  return { input, bar, composer: bar.closest('[data-slot="composer"]')!,
    send: bar.querySelector('button[aria-label="Send message"]'), placeholder: input.getAttribute('data-placeholder') }
}

describe('ChatMessageComposer uses the shared composer bar', () => {
  it.each([true, false])('keeps the editor and send control in one bar (in slot: %s)', async (inSlot) => {
    const { bar, input, send } = await render(inSlot)
    expect(bar.contains(input)).toBe(true)
    expect(send).not.toBeNull()
  })
  it('marks the phone surface while retaining the same composer and newline keyboard', async () => {
    shell.mobile = true
    const { composer, input, send, placeholder } = await render(true, 'website')
    expect(composer.getAttribute('data-mobile')).toBe('true')
    expect(input.getAttribute('enterkeyhint')).toBe('enter')
    expect(send).not.toBeNull()
    expect(placeholder).toBe('Write a message… Type / for commands')
  })
  it('applies the shared docked width only inside a slot', async () => {
    expect((await render(true)).composer.className.includes(sessionComposerDockedWidthClassName)).toBe(true)
    expect((await render(false)).composer.className.includes(sessionComposerDockedWidthClassName)).toBe(false)
  })
  it('names the project in a project group box', async () => {
    expect((await render(true, 'website')).placeholder).toBe('Message website… @ an agent to call it')
    expect((await render(true)).placeholder).toBe('Write a message… Type / for commands')
  })
})

// 点了新任务框标签上的 ×:那一框写的话沿 composerVerbBridge 的 carry 交回群输入框(原型里两者就是同一个框)。
function DraftHost({ chatId }: { chatId: string }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const setDraft = useCallback((id: string, update: SetStateAction<string>) => setDrafts((p) => ({
    ...p, [id]: typeof update === 'function' ? update(p[id] ?? '') : update,
  })), [])
  const value = useMemo(() => ({ ...chatStore(), drafts, setDraft }), [drafts, setDraft])
  return createElement(ChatStoreProvider, { value }, createElement(InChatSlot.Provider, { value: { projectName: null } },
    createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}), chatId, isGroupChat: true })))
}

describe('ChatMessageComposer and the new-task box', () => {
  it('takes back what was written in the new-task box when its tag is closed', async () => {
    await act(async () => { root.render(createElement(DraftHost, { chatId: 'chat-carry' })) })
    const textarea = () => container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => { setComposerVerb('chat-carry', 'task') })
    expect(textarea().closest('[style*="display: none"]'), 'the group box steps aside while the new task is open').not.toBeNull()
    await act(async () => { setComposerVerb('chat-carry', null, 'add a pricing page') })
    expect(textarea().closest('[style*="display: none"]')).toBeNull()
    expect(readComposer(textarea())).toBe('add a pricing page')
  })
})
