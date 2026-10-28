// @vitest-environment jsdom
import { act, createElement, Fragment, Profiler, useCallback, useMemo, useState, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { ChatStoreProvider, type DraftAttachment, type DraftMention } from '../../../../apps/desktop/src/store/chatContext'
import { chat, chatStore, contactsStore, message } from '../../../support/testHarness'
import { publishProjectGroupChats } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/project-group-chats-bridge'
import { ContactsContext } from '../../../../apps/desktop/src/store/contactsContext'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { readComposer, writeComposer, selectComposer } from '../../../support/composerEditor'
import type { GroupRosterCandidate } from '../../../../apps/desktop/src/lib/mention'
const { toastMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
}))
const sendErrorLog = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: sendErrorLog }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({
  useToast: () => ({ toast: toastMock }),
}))
const mobileShellState = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => mobileShellState.enabled }))
let container: HTMLDivElement
let root: Root
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  publishProjectGroupChats([], new Map(), new Map())
  mobileShellState.enabled = false
  setLocalePreference('zh-CN')
  toastMock.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gugu-preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  setLocalePreference('zh-CN')
  vi.useRealTimers()
  vi.restoreAllMocks()
})
describe('ChatMessageComposer', () => {
  it.each([[true, 'native-range', false], [true, undefined, true], [false, undefined, true]] as const)('preserves native selection focus for automatic quotes (phone=%s, token=%s)', async (mobile, selectionId, focus) => {
    mobileShellState.enabled = mobile
    const onSend = vi.fn(async () => {})
    await act(async () => { root.render(createElement(ChatMessageComposer, { onSend })) })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 0 })
    const source = document.createTextNode('Beta')
    document.body.append(source)
    const range = document.createRange(); range.selectNodeContents(source)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    await act(async () => { root.render(createElement(ChatMessageComposer, { onSend,
      quoteContent: { messageId: 'source-1', senderName: 'Ada', content: 'Beta', originalContent: 'Alpha Beta', selectionId, source: message({ id: 'source-1' }) },
    })) })
    const editor = container.querySelector('[contenteditable]')!
    expect(document.activeElement === editor).toBe(focus)
    if (!focus) expect(window.getSelection()?.toString()).toBe('Beta')
    source.remove()
  })

  it.each([false, true])('sends a selected excerpt in the existing quote format while preserving its message ID (phone=%s)', async mobile => {
    mobileShellState.enabled = mobile
    const onSend = vi.fn(async () => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend,
        quoteContent: { messageId: 'source-1', senderName: 'Ada', content: 'Beta paragraph\n\nFirst item', originalContent: 'Alpha paragraph\n\nBeta paragraph\n\nFirst item', source: message({ id: 'source-1' }) },
      }))
    })
    await flush()
    await typeInComposer('Please explain this part.')
    await clickSend()
    expect(onSend).toHaveBeenCalledWith('> [Ada]: Beta paragraph\n> \n> First item\nPlease explain this part.', expect.objectContaining({ replyToMessageId: 'source-1' }))
  })
  it('keeps touch Enter for a new line and sends only through the visible control', async () => {
    mobileShellState.enabled = true
    const onSend = vi.fn<(content: string) => Promise<void>>(async () => {})
    await act(async () => { root.render(createElement(ChatMessageComposer, { onSend })) })
    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => {
      writeComposer(textarea, '手机输入')
    })
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { textarea.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(true)
    expect(textarea.querySelector('br')).not.toBeNull()
    expect(onSend).not.toHaveBeenCalled()
    expect(readComposer(textarea)).toBe('手机输入')
    expect(textarea.getAttribute('enterkeyhint')).toBe('enter')
    const send = container.querySelector('button[aria-label="发送消息"]') as HTMLButtonElement
    await act(async () => { send.click() })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]?.[0]).toBe('手机输入')
  })
  it('switches composer chrome without changing the draft or command token', async () => {
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}) }))
    })
    await flush()
    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => {
      writeComposer(textarea, '用户草稿 /clear')
    })
    expect(textarea.getAttribute('data-placeholder')).toBe('发送消息… 输入 / 唤起命令')
    await act(async () => {
      setLocalePreference('en-US')
    })
    expect(textarea.getAttribute('data-placeholder')).toBe('Write a message… Type / for commands')
    expect(readComposer(textarea)).toBe('用户草稿 /clear')
    expect(container.querySelector('button[aria-label="Send message"]')).not.toBeNull()
  })
  // @@@6200 spec composer「Typing writes only the text」: one keystroke = one commit. A second commit per key means
  // an effect wrote state after the keystroke's commit — under fast input React counts those as nested updates and
  // throws #185 mid-typing (measured in the product: ~50 back-to-back keys). act() drains every lane, so the
  // throw itself can't be reproduced here; the per-key commit count is the contract that prevents it.
  it('#6200 a keystroke commits once — no state write trails the input', async () => {
    let commits = 0
    await act(async () => {
      root.render(createElement(Profiler, { id: 'composer', onRender: () => { commits += 1 } },
        createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}) })))
    })
    await flush()
    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    // The first input after mount also yields one commit in which no component renders (no update origin —
    // measured with a devtools commit hook); it is not a state write and never repeats, so count from key 2.
    await act(async () => {
      writeComposer(textarea, 'h')
    })
    await flush()
    const perKey: number[] = []
    for (const value of ['he', 'hel', 'hell', 'hello']) {
      const before = commits
      await act(async () => {
        writeComposer(textarea, value)
        })
      await flush()
      perKey.push(commits - before)
    }
    expect(perKey).toEqual([1, 1, 1, 1])
    expect(readComposer(textarea)).toBe('hello')
  })
  it('revokes pending image preview urls when unmounted', async () => {
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}) }))
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    const file = new File(['image'], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(URL.createObjectURL).toHaveBeenCalledWith(file)
    act(() => {
      root.unmount()
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gugu-preview')
  })
  it('restores pending attachments and reports send failures', async () => {
    const file = new File(['image'], 'avatar.png', { type: 'image/png' })
    const onSendAttachments = vi.fn(async () => {
      throw new Error('upload denied /Users/test/private sk-synthetic-secret\nstack detail')
    })
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}),
        onSendAttachments,
      }))
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(container.querySelectorAll('[data-slot="composer-attachment"]')).toHaveLength(1)
    const sendButton = Array.from(container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === '发送消息')
    expect(sendButton).toBeDefined()
    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(onSendAttachments).toHaveBeenCalledWith([file], { toUserIds: [], isWhisper: false, onSent: expect.any(Function) })
    expect(container.querySelectorAll('[data-slot="composer-attachment"]')).toHaveLength(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gugu-preview')
    expect(toastMock).toHaveBeenCalledWith('发送失败：upload denied [path] [redacted token]', 'error')
    expect(sendErrorLog).toHaveBeenCalledWith(expect.objectContaining({ error: 'upload denied /Users/test/private sk-synthetic-secret\nstack detail' }), 'message send failed')
  })
  it('#2188 restores only the text when every attachment committed before the text failed', async () => {
    const file = new File(['report'], 'report.txt', { type: 'text/plain' })
    const onSendAttachments = vi.fn(async (files: File[], opts?: { onSent?: (f: File, index: number) => void }) => {
      files.forEach((f, index) => opts?.onSent?.(f, index))
    })
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('text denied'))
      .mockResolvedValueOnce(undefined)
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend, onSendAttachments }))
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await typeInComposer('send this text after the file')
    await clickSend()
    expect(onSendAttachments).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(readComposer(container.querySelector('[contenteditable]'))).toBe('send this text after the file')
    expect(container.querySelectorAll('[data-slot="composer-attachment"]'), 'the committed attachment must not return to the draft').toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith('发送失败：text denied', 'error')
    await clickSend()
    expect(onSendAttachments, 'retry must not resend the committed attachment').toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(2)
  })
  it('#2188 a mid-batch attachment failure restores the failed AND remaining files, never the committed one', async () => {
    const sentFile = new File(['a'], 'already-sent.txt', { type: 'text/plain' })
    const failedFile = new File(['b'], 'failed-verification.txt', { type: 'text/plain' })
    const remainingFile = new File(['c'], 'never-attempted.txt', { type: 'text/plain' })
    const onSendAttachments = vi.fn<(files: File[], opts?: { onSent?: (f: File, index: number) => void }) => Promise<void>>(async (files, opts) => {
      opts?.onSent?.(files[0], 0)
      throw new Error('second file denied')
    })
    const onSend = vi.fn(async () => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend, onSendAttachments }))
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [sentFile, failedFile, remainingFile] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await typeInComposer('text never attempted')
    await clickSend()
    const chips = container.querySelectorAll('[data-slot="composer-attachment"]')
    expect(chips, 'the failed file and the remaining file return to the draft').toHaveLength(2)
    expect(chips[0].textContent).toContain('failed-verification.txt')
    expect(chips[1].textContent).toContain('never-attempted.txt')
    expect(readComposer(container.querySelector('[contenteditable]')), 'the unattempted text stays recoverable').toBe('text never attempted')
    expect(onSend, 'the text half never ran').toHaveBeenCalledTimes(0)
    onSendAttachments.mockImplementationOnce(async (files: File[], opts?: { onSent?: (f: File, index: number) => void }) => {
      files.forEach((f, index) => opts?.onSent?.(f, index))
    })
    await clickSend()
    expect(onSendAttachments).toHaveBeenCalledTimes(2)
    expect(onSendAttachments.mock.calls[1]?.[0], 'retry sends ONLY the uncommitted files, in order').toEqual([failedFile, remainingFile])
    expect(onSend).toHaveBeenCalledTimes(1)
  })
  it('uses disabled placeholder and hover hint independently', async () => {
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}),
        disabled: true,
        disabledReason: 'Agent 正在激活，完成后可发送消息',
        placeholder: 'Agent 正在激活中，稍后即可对话…',
      }))
    })
    const textarea = container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`) as HTMLElement | null
    expect(textarea).not.toBeNull()
    expect(textarea?.getAttribute('aria-disabled')).toBe('true')
    expect(textarea?.getAttribute('data-placeholder')).toBe('Agent 正在激活中，稍后即可对话…')
    expect(textarea?.closest('[data-chat-composer-host]')?.getAttribute('title')).toBe('Agent 正在激活，完成后可发送消息')
    const sendButton = Array.from(container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === '发送消息')
    expect(sendButton).toBeDefined()
    expect(sendButton?.disabled).toBe(true)
    expect(sendButton?.getAttribute('aria-label')).toBe('发送消息')
  })
  // @@@at-mention-draft (#951) - a stateful ChatContext provider so draft TEXT + @-mention targets actually
  function StatefulHost({ chatId, onSend, onSendAttachments, groupMembers = [] }: { chatId: string | null; onSend: (c: string, o?: unknown) => Promise<void>; onSendAttachments?: (files: File[], opts?: unknown) => Promise<void>; groupMembers?: GroupRosterCandidate[] }) {
    const [drafts, setDrafts] = useState<Record<string, string>>({})
    const [draftMentions, setDM] = useState<Record<string, DraftMention[]>>({})
    // @@@draft-attachment (#1872) - also round-trip queued attachments through the store, parallel to text.
    const [draftAttachments, setDA] = useState<Record<string, DraftAttachment[]>>({})
    const setDraft = useCallback((id: string, update: SetStateAction<string>) => setDrafts((p) => ({
      ...p,
      [id]: typeof update === 'function' ? update(p[id] ?? '') : update,
    })), [])
    const setDraftMentions = useCallback((id: string, m: DraftMention[]) => setDM((p) => ({ ...p, [id]: m })), [])
    const setDraftAttachments = useCallback((id: string, a: DraftAttachment[]) => setDA((p) => ({ ...p, [id]: a })), [])
    const value = useMemo(() => ({
      ...chatStore(),
      drafts,
      draftMentions,
      draftAttachments,
      setDraft,
      setDraftMentions,
      setDraftAttachments,
    }), [drafts, draftMentions, draftAttachments, setDraft, setDraftMentions, setDraftAttachments])
    return createElement(ChatStoreProvider, { value }, createElement(ChatMessageComposer, {
      onSend,
      onSendAttachments,
      chatId,
      isGroupChat: true,
      groupMembers,
    }))
  }
  function rosterMember(id: string, name: string, type: 'human' | 'agent' = 'human'): GroupRosterCandidate {
    return { id, name, type }
  }
  async function typeInComposer(value: string) {
    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => {
        writeComposer(textarea, value)
    })
    await flush()
  }
  async function clickMentionOption(name: string) {
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes(name))
    expect(option, `mention option "${name}" should be in the picker`).toBeTruthy()
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flush()
  }
  async function clickSend() {
    const sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '发送消息')
    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
  }
  async function pressEnter() {
    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
  }
  it('a second Enter while a batch is in flight does not resend the same attachments', async () => {
    let finish: () => void = () => {}
    const beforeSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const onSendAttachments = vi.fn(async () => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}), onSendAttachments, beforeSend }))
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['a'], 'a.txt', { type: 'text/plain' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await pressEnter()
    await pressEnter()
    await act(async () => { finish(); await Promise.resolve() })
    await flush()
    expect(beforeSend).toHaveBeenCalledTimes(1)
    expect(onSendAttachments).toHaveBeenCalledTimes(1)
  })
  it('a failed send merges back into a draft typed while it was in flight instead of overwriting it', async () => {
    let rejectSend: (e: Error) => void = () => {}
    const onSendAttachments = vi.fn(() => new Promise<void>((_, reject) => { rejectSend = reject }))
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}), onSendAttachments }))
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['a'], 'first.txt', { type: 'text/plain' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await typeInComposer('first words')
    await clickSend()
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['b'], 'added-mid-send.txt', { type: 'text/plain' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await typeInComposer('typed mid-send')
    await act(async () => { rejectSend(new Error('upload denied')); await Promise.resolve() })
    await flush()
    const chips = container.querySelectorAll('[data-slot="composer-attachment"]')
    expect(Array.from(chips).map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('first.txt'),
      expect.stringContaining('added-mid-send.txt'),
    ])
    expect(readComposer(container.querySelector('[contenteditable]'))).toBe('first words\ntyped mid-send')
  })
  it('#1872 a send that fails after switching chats restores into the ORIGINAL chat, not the active one', async () => {
    let rejectSend: (e: Error) => void = () => {}
    const onSendAttachments = vi.fn(() => new Promise<void>((_, reject) => { rejectSend = reject }))
    const chips = () => container.querySelectorAll('[data-slot="composer-attachment"]')
    await act(async () => {
      root.render(createElement(StatefulHost, { chatId: 'chat-a', onSend: vi.fn(async () => {}), onSendAttachments }))
    })
    await flush()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['secret'], 'secret.txt', { type: 'text/plain' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(chips()).toHaveLength(1)
    await clickSend()
    expect(onSendAttachments).toHaveBeenCalledTimes(1)
    expect(chips(), 'optimistic clear emptied the composer').toHaveLength(0)
    await act(async () => {
      root.render(createElement(StatefulHost, { chatId: 'chat-b', onSend: vi.fn(async () => {}), onSendAttachments }))
    })
    await flush()
    await act(async () => { rejectSend(new Error('upload denied')); await Promise.resolve() })
    await flush()
    expect(chips(), 'failed send must not leak into the now-active chat-b').toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith('发送失败：upload denied', 'error')
    await act(async () => {
      root.render(createElement(StatefulHost, { chatId: 'chat-a', onSend: vi.fn(async () => {}), onSendAttachments }))
    })
    await flush()
    expect(chips(), 'failed send is recoverable in its original chat-a').toHaveLength(1)
  })
  it('a send failing after the user came back and drafted anew merges into that draft instead of overwriting it', async () => {
    let rejectSend: (e: Error) => void = () => {}
    const onSendAttachments = vi.fn(() => new Promise<void>((_, reject) => { rejectSend = reject }))
    const chips = () => container.querySelectorAll('[data-slot="composer-attachment"]')
    const render = async (chatId: string) => {
      await act(async () => { root.render(createElement(StatefulHost, { chatId, onSend: vi.fn(async () => {}), onSendAttachments })) })
      await flush()
    }
    const attach = async (name: string) => {
      const input = container.querySelector('input[type="file"]') as HTMLInputElement
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], name, { type: 'text/plain' })] })
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
      await flush()
    }
    await render('chat-a')
    await attach('first.txt')
    await typeInComposer('first words')
    await clickSend()
    await render('chat-b')
    await render('chat-a')
    await attach('second.txt')
    await typeInComposer('second words')
    await render('chat-b')
    await act(async () => { rejectSend(new Error('upload denied')); await Promise.resolve() })
    await flush()
    await render('chat-a')
    expect(Array.from(chips()).map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('first.txt'),
      expect.stringContaining('second.txt'),
    ])
    expect(readComposer(container.querySelector('[contenteditable]'))).toBe('first words\nsecond words')
  })
  it('#2188 after attachment success, a late text failure restores only text into the ORIGINAL chat', async () => {
    let rejectText: (e: Error) => void = () => {}
    const onSendAttachments = vi.fn(async (files: File[], opts?: unknown) => {
      files.forEach((f, index) => (opts as { onSent?: (f: File, index: number) => void } | undefined)?.onSent?.(f, index))
    })
    const onSend = vi.fn(() => new Promise<void>((_, reject) => { rejectText = reject }))
    const chips = () => container.querySelectorAll('[data-slot="composer-attachment"]')
    await act(async () => {
      root.render(createElement(StatefulHost, { chatId: 'chat-a', onSend, onSendAttachments }))
    })
    await flush()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['sent'], 'sent.txt', { type: 'text/plain' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await typeInComposer('unsent text')
    await clickSend()
    expect(onSendAttachments).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(chips(), 'optimistic clear emptied chat-a while text is in flight').toHaveLength(0)
    await act(async () => {
      root.render(createElement(StatefulHost, { chatId: 'chat-b', onSend, onSendAttachments }))
    })
    await flush()
    await act(async () => { rejectText(new Error('text denied')); await Promise.resolve() })
    await flush()
    expect(readComposer(container.querySelector('[contenteditable]'))).toBe('')
    expect(chips(), 'the committed attachment must not leak into chat-b').toHaveLength(0)
    await act(async () => {
      root.render(createElement(StatefulHost, { chatId: 'chat-a', onSend, onSendAttachments }))
    })
    await flush()
    expect(readComposer(container.querySelector('[contenteditable]'))).toBe('unsent text')
    expect(chips(), 'the committed attachment must not be restored into chat-a either').toHaveLength(0)
  })
  it('#951 token-boundary: typing @Bobby routes to Bobby, never Bob (no substring misroute)', async () => {
    const groupMembers = [rosterMember('u-bob', 'Bob'), rosterMember('u-bobby', 'Bobby')]
    const onSend = vi.fn(async () => {})
    await act(async () => { root.render(createElement(StatefulHost, { chatId: 'group-1', onSend, groupMembers })) })
    await flush()
    await typeInComposer('@Bob')
    await clickMentionOption('Bob') // picks Bob → mentionTargets=[u-bob], text "@Bob "
    await typeInComposer('@Bobby ')
    await clickSend()
    // @@@1703: a typed @Bobby now resolves to the real member at send time (whole-token match) → u-bobby.
    expect(onSend).toHaveBeenCalledWith('@Bobby', expect.objectContaining({ toUserIds: ['u-bobby'] }))
  })
  it('#6819 a pick of Claude lapses once the text reads @Claude 2 (longest match, as send routing reads it)', async () => {
    const groupMembers = [rosterMember('u-claude', 'Claude'), rosterMember('u-claude-2', 'Claude 2')]
    const onSend = vi.fn(async () => {})
    await act(async () => { root.render(createElement(StatefulHost, { chatId: 'group-1', onSend, groupMembers })) })
    await flush()
    await typeInComposer('@Claude')
    await clickMentionOption('Claude')
    expect(readComposer(container.querySelector('[contenteditable]'))).toBe('@Claude ')
    await typeInComposer('@Claude 2 ')
    await clickSend()
    expect(onSend).toHaveBeenCalledWith('@Claude 2', expect.objectContaining({ toUserIds: ['u-claude-2'] }))
  })
  it('C1 会话就绪不挡上屏:输入框立刻清空、onSend 立刻被调,就绪交给投递前置', async () => {
    const readiness = new Promise<void>(() => {}) // 模拟重开会话:永远没就绪
    const beforeSend = vi.fn(() => readiness)
    const onSend = vi.fn(async () => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, { onSend, beforeSend, chatId: 'dm-agent' }))
    })
    await typeInComposer('你好')
    await clickSend()
    expect(readComposer(container.querySelector('[contenteditable]')), '输入框不等会话就绪').toBe('')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('你好', expect.objectContaining({ beforeDeliver: beforeSend }))
    expect(beforeSend, '文字消息的就绪由 outbox 在投递前 await,composer 不自己挡').not.toHaveBeenCalled()
  })
  it.each([
    { sender_user_id: 'ada', to_user_ids: ['me'] },
    { sender_user_id: 'me', to_user_ids: ['ada'] },
  ])('replies privately to the original peer for $sender_user_id → $to_user_ids', async (pair) => {
    const onSend = vi.fn(async () => {})
    const quoteContent = { messageId: 'private-source', senderName: 'Ada', content: 'private', source: message({ ...pair, is_whisper: true }) }
    await act(async () => { root.render(createElement(ChatMessageComposer, {
      onSend, chatId: 'group-1', isGroupChat: true, currentUserId: 'me', quoteContent,
      groupMembers: [rosterMember('ada', 'Ada')],
    })) })
    expect(container.textContent).toContain('悄悄话给 Ada')
    await typeInComposer('private reply')
    await clickSend()
    expect(onSend).toHaveBeenCalledWith('private reply', expect.objectContaining({
      toUserIds: ['ada'], isWhisper: true, replyToMessageId: 'private-source',
    }))
  })
  it('requires Exit whisper mode to publish a private reply and defaults a new reply back to private', async () => {
    const onSend = vi.fn(async () => {})
    const source = message({ sender_user_id: 'ada', to_user_ids: ['me'], is_whisper: true })
    const renderQuote = async () => act(async () => { root.render(createElement(ChatMessageComposer, {
      onSend, chatId: 'group-1', isGroupChat: true, currentUserId: 'me',
      quoteContent: { messageId: source.id, senderName: 'Ada', content: 'private', source },
    })) })
    await renderQuote()
    await act(async () => { (container.querySelector('button[aria-label="退出悄悄话"]') as HTMLButtonElement).click() })
    await typeInComposer('public reply')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('public reply', expect.objectContaining({ toUserIds: [], replyToMessageId: source.id }))
    expect(onSend).toHaveBeenLastCalledWith('public reply', expect.not.objectContaining({ isWhisper: true }))
    await renderQuote()
    expect(container.querySelector('button[aria-label="退出悄悄话"]')).not.toBeNull()
    await typeInComposer('private again')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('private again', expect.objectContaining({ toUserIds: ['ada'], isWhisper: true }))
  })
  it('does not send a reply whose original privacy metadata is unavailable', async () => {
    const onSend = vi.fn(async () => {})
    await act(async () => { root.render(createElement(ChatMessageComposer, {
      onSend, quoteContent: { messageId: 'missing', senderName: 'Ada', content: 'unavailable' },
    })) })
    expect(container.querySelector('[data-chat-composer-host]')?.getAttribute('title')).toContain('原消息不可用')
    expect(container.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('false')
    expect(onSend).not.toHaveBeenCalled()
  })
  it.each([
    { currentUserId: undefined, sender_user_id: 'ada' },
    { currentUserId: 'me', sender_user_id: null },
  ])('disables private replies when the pair cannot be resolved: $sender_user_id / $currentUserId', async ({ currentUserId, sender_user_id }) => {
    const onSend = vi.fn(async () => {})
    await act(async () => { root.render(createElement(ChatMessageComposer, {
      onSend, currentUserId,
      quoteContent: { messageId: 'unavailable-private-source', senderName: 'Ada', content: 'private',
        source: message({ sender_user_id, to_user_ids: ['me'], is_whisper: true }) },
    })) })
    expect(container.querySelector('[data-chat-composer-host]')?.getAttribute('title')).toContain('原消息不可用')
    expect(container.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('false')
    expect(onSend).not.toHaveBeenCalled()
  })
  it('preserves the reply id when whisper mode was selected manually', async () => {
    const onSend = vi.fn(async () => {})
    await act(async () => { root.render(createElement(ChatMessageComposer, {
      onSend, currentUserId: 'me', whisperTarget: { userId: 'ada', displayName: 'Ada' },
      quoteContent: { messageId: 'public-source', senderName: 'Ada', content: 'public', source: message({ is_whisper: false }) },
    })) })
    await typeInComposer('manual private reply')
    await clickSend()
    expect(onSend).toHaveBeenCalledWith('manual private reply', expect.objectContaining({ toUserIds: ['ada'], isWhisper: true, replyToMessageId: 'public-source' }))
  })
  it('#1641 preserves @, reply, whisper, DM, and @all routing precedence', async () => {
    const agent = rosterMember('agent-codex', 'Codex 8', 'agent')
    const onSend = vi.fn(async () => {})
    const render = async (props: Record<string, unknown>) => {
      await act(async () => {
        root.render(createElement(ChatMessageComposer, {
          onSend,
          chatId: 'group-1',
          isGroupChat: true,
          groupMembers: [agent],
          ...props,
        }))
      })
      await flush()
    }
    await render({})
    await typeInComposer('@Codex 8 请检查')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('@Codex 8 请检查', expect.objectContaining({
      toUserIds: ['agent-codex'],
      replyToMessageId: null,
    }))
    await render({ quoteContent: { messageId: 'message-1', senderName: 'Codex 8', content: '原消息', source: message({ id: 'message-1' }) } })
    await typeInComposer('Codex 8 收到')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('Codex 8 收到', expect.objectContaining({
      toUserIds: [],
      replyToMessageId: 'message-1',
    }))
    await render({ whisperTarget: { userId: 'human-private', displayName: '私聊对象' } })
    await typeInComposer('Codex 8 这条只发给人类')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('Codex 8 这条只发给人类', expect.objectContaining({
      toUserIds: ['human-private'],
      replyToMessageId: null,
      isWhisper: true,
    }))
    await render({ isGroupChat: false })
    await typeInComposer('Codex 8 这是 DM')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('Codex 8 这是 DM', expect.objectContaining({
      toUserIds: [],
      replyToMessageId: null,
    }))
    await render({})
    await typeInComposer('@所有人 大家看一下')
    await clickSend()
    expect(onSend).toHaveBeenLastCalledWith('@所有人 大家看一下', expect.objectContaining({
      toUserIds: ['*'],
      replyToMessageId: null,
    }))
  })
  it('@@@2104 updates candidates from the subscribed roster without a chat switch', async () => {
    const agentA = rosterMember('a-1', '旧成员', 'agent')
    const agentB = rosterMember('a-2', '新入群 Agent', 'agent')
    const onSend = vi.fn(async () => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend,
        chatId: 'group-1',
        isGroupChat: true,
        groupMembers: [agentA],
      }))
    })
    await flush()
    const ta = container.querySelector('[contenteditable]') as HTMLElement
    const setVal = (v: string, caret: number) => {
      writeComposer(ta, v)
      selectComposer(ta, caret)
    }
    await act(async () => { setVal('@', 1) })
    await flush()
    expect(document.body.textContent).toContain('旧成员')
    expect(document.body.textContent).not.toContain('新入群 Agent')
    await act(async () => { setVal('', 0) })
    await flush()
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend,
        chatId: 'group-1',
        isGroupChat: true,
        groupMembers: [agentA, agentB],
      }))
    })
    await flush()
    await act(async () => { setVal('@', 1) })
    await flush()
    expect(document.body.textContent).toContain('新入群 Agent')
  })
  it('#2166 warns only for an explicitly offline resolved agent status', async () => {
    const offlineAgent = rosterMember('offline-agent', '设备离线 Agent', 'agent')
    const reachableAgent = rosterMember('reachable-agent', '可对话 Agent', 'agent')
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}),
        chatId: 'group-1',
        isGroupChat: true,
        groupMembers: [offlineAgent, reachableAgent],
        agentStatuses: { 'offline-agent': 'offline', 'reachable-agent': 'idle' },
      }))
    })
    await flush()
    await typeInComposer('@')
    const offlineOption = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('设备离线 Agent'))
    const reachableOption = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('可对话 Agent'))
    expect(offlineOption?.textContent).toContain('当前不在线，可能无法及时回复')
    expect(reachableOption?.textContent).not.toContain('当前不在线，可能无法及时回复')
    expect(offlineOption?.querySelector('[data-agent-display-status]')?.getAttribute('data-agent-display-status')).toBe('offline')
    expect(reachableOption?.querySelector('[data-agent-display-status]')?.getAttribute('data-agent-display-status')).toBe('idle')
    await act(async () => {
      offlineOption?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flush()
    expect(container.querySelector('[data-agent-status-surface="mention-selection"][data-agent-id="offline-agent"]')?.textContent)
      .toContain('当前不在线，可能无法及时回复')
    expect(container.querySelector('[data-agent-status-surface="mention-selection"][data-agent-id="reachable-agent"]')).toBeNull()
  })
  it('3a a name with a space stays pickable, and picking it closes the popup', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend, chatId: 'group-1', isGroupChat: true,
        groupMembers: [rosterMember('a-2', 'Claude 2', 'agent'), rosterMember('a-3', 'gpt-5.4', 'agent')],
      }))
    })
    await flush()
    await typeInComposer('@Claude 2')
    const options = () => Array.from(document.body.querySelectorAll('[role="option"]')).map((el) => el.textContent ?? '')
    expect(options().some((text) => text.includes('Claude 2'))).toBe(true)
    await typeInComposer('@gpt5')
    expect(options().some((text) => text.includes('gpt-5.4'))).toBe(true)
    await typeInComposer('@Claude 2')
    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(readComposer(textarea)).toBe('@Claude 2 ')
    await act(async () => { textarea.dispatchEvent(new Event('select', { bubbles: true })) })
    await flush()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })
  it('ranks loaded group history and inserts the keyboard-selected identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 25, 12))
    const onSend = vi.fn(async () => {})
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend, chatId: 'group-1', isGroupChat: true, currentUserId: 'me',
        groupMembers: [rosterMember('alice', 'Alice', 'human'), rosterMember('atlas', 'Atlas', 'agent')],
        messages: [message({ chat_id: 'group-1', sender_user_id: 'me', to_user_ids: ['atlas'], created_at: '2026-10-25T11:59:00Z' })],
      }))
    })
    await flush()
    await typeInComposer('@a')
    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
    expect(options).toHaveLength(2)
    expect(options[0].querySelector('[data-agent-id="atlas"]')).not.toBeNull()
    expect(options[1].textContent).toContain('Alice')
    await pressEnter()
    expect(readComposer(container.querySelector('[contenteditable]') as HTMLElement)).toBe('@Atlas ')
    await clickSend()
    expect(onSend).toHaveBeenCalledWith('@Atlas', expect.objectContaining({ toUserIds: ['atlas'] }))
  })
  it.each(['project-group', 'project-topic', 'ordinary-group'] as const)('uses project affiliation in %s without changing the selected identity', async (chatId) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 25, 12))
    publishProjectGroupChats(['project-group'], new Map([['project-group', ['ada']]]), new Map())
    const onSend = vi.fn(async () => {})
    const topic = chatId === 'project-topic'
    await act(async () => {
      root.render(createElement(ChatStoreProvider, { value: chatStore({ chats: [chat({
        id: chatId, kind: topic ? 'topic' : 'group', source_chat_id: topic ? 'project-group' : null,
      })] }) }, createElement(ChatMessageComposer, {
        onSend, chatId, isGroupChat: true, currentUserId: 'me',
        groupMembers: [rosterMember('atlas', 'Atlas', 'agent'), rosterMember('ada', 'Ada', 'agent')],
        participantIds: topic ? ['atlas', 'ada'] : undefined,
        messages: [message({ chat_id: chatId, sender_user_id: 'me', to_user_ids: ['atlas'], created_at: '2026-10-25T11:59:00Z' })],
      })))
    })
    await flush()
    await typeInComposer('@a')
    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
    // A project group's main line offers its whole roster, the same as an ordinary group.
    expect(options).toHaveLength(2)
    const expectedId = chatId === 'ordinary-group' ? 'atlas' : 'ada'
    const expectedName = chatId === 'ordinary-group' ? 'Atlas' : 'Ada'
    expect(options[0].querySelector(`[data-agent-id="${expectedId}"]`)).not.toBeNull()
    await pressEnter()
    expect(readComposer(container.querySelector('[contenteditable]') as HTMLElement)).toBe(`@${expectedName} `)
    await clickSend()
    expect(onSend).toHaveBeenCalledWith(`@${expectedName}`, expect.objectContaining({ toUserIds: [expectedId] }))
  })
  it('#6722 keeps the keyboard-highlighted mention visible beyond the first popup viewport', async () => {
    const members = Array.from({ length: 12 }, (_, index) =>
      rosterMember(`agent-${index}`, `Agent ${index}`, 'agent'))
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}),
        chatId: 'group-1',
        isGroupChat: true,
        groupMembers: members,
      }))
    })
    await flush()
    await typeInComposer('@')

    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    expect(options).toHaveLength(13)
    const scrollIntoView = options.map(() => vi.fn())
    options.forEach((option, index) => {
      Object.defineProperty(option, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView[index],
      })
    })

    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => {
      for (let index = 0; index < 11; index += 1) {
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }))
      }
    })
    await flush()

    expect(options[11].getAttribute('aria-selected')).toBe('true')
    expect(scrollIntoView[11]).toHaveBeenCalledWith({ block: 'nearest' })

    await pressEnter()
    await flush()
    expect(readComposer(textarea)).toBe('@Agent 11 ')
  })
  it('#6722 keeps a valid highlight when the open mention roster shrinks', async () => {
    const onSend = vi.fn(async () => {})
    const members = Array.from({ length: 5 }, (_, index) =>
      rosterMember(`agent-${index}`, `Agent ${index}`, 'agent'))
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend,
        isGroupChat: true,
        groupMembers: members,
      }))
    })
    await flush()
    await typeInComposer('@Agent')

    const textarea = container.querySelector('[contenteditable]') as HTMLElement
    await act(async () => {
      for (let index = 0; index < 4; index += 1) {
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }))
      }
    })
    await flush()
    expect(document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Agent 4')

    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend,
        isGroupChat: true,
        groupMembers: members.slice(0, 2),
      }))
    })
    await flush()

    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Agent 1')
    await pressEnter()
    await flush()
    expect(readComposer(textarea)).toBe('@Agent 1 ')
  })
  // The aside (topic split) composer never registers as the global focus target, so its in-conversation
  // follow-ups must name their own textarea — otherwise the registered main composer takes the caret.
  it('the aside composer keeps focus after picking a mention with Enter and after sending with Enter', async () => {
    const onSendAside = vi.fn(async () => {})
    const members = [rosterMember('a-1', 'Ada', 'agent')]
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(ChatMessageComposer, { onSend: vi.fn(async () => {}), chatId: 'group-1', isGroupChat: true, groupMembers: members }),
        createElement(ChatMessageComposer, { onSend: onSendAside, chatId: 'topic-1', isGroupChat: true, groupMembers: members, surface: 'aside' })))
    })
    await flush()
    const main = container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`) as HTMLElement
    const aside = container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposerAside}"]`) as HTMLElement
    expect(main).not.toBeNull()
    const nextFrames = () => act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve)) })
    const pressEnter = () => act(async () => { aside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    aside.focus()
    await act(async () => {
      writeComposer(aside, '@Ad')
    })
    await flush()
    await pressEnter()
    await nextFrames()
    expect(readComposer(aside)).toBe('@Ada ')
    expect(document.activeElement, 'picking a mention moved the caret to the main composer').toBe(aside)
    await pressEnter()
    await nextFrames()
    expect(onSendAside).toHaveBeenCalledTimes(1)
    expect(document.activeElement, 'sending moved the caret to the main composer').toBe(aside)
  })
  it('3a finds members by pinyin and by the alias the owner gave them', async () => {
    await act(async () => {
      root.render(createElement(ContactsContext.Provider, {
        value: contactsStore({ contacts: [{ id: 'u-1', display_name: 'Ada Lovelace', avatar: null, bio: null, alias: '数学家' }] }),
      }, createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}), chatId: 'group-1', isGroupChat: true,
        groupMembers: [rosterMember('u-1', 'Ada Lovelace'), rosterMember('u-2', '张三丰')],
      })))
    })
    await flush()
    const options = () => Array.from(document.body.querySelectorAll('[role="option"]')).map((el) => el.textContent ?? '')
    await typeInComposer('@zsf')
    expect(options().some((text) => text.includes('张三丰'))).toBe(true)
    await typeInComposer('@数学')
    expect(options().some((text) => text.includes('Ada Lovelace'))).toBe(true)
  })
  it('3a no match keeps the popup with「没有匹配的成员」until the text reads as a sentence', async () => {
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}), chatId: 'group-1', isGroupChat: true,
        groupMembers: [rosterMember('u-1', 'Ada')],
      }))
    })
    await flush()
    vi.useFakeTimers()
    await typeInComposer('@nobody')
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    vi.useRealTimers()
    expect(document.body.querySelector('[role="listbox"]')?.textContent).toBe('没有匹配的成员')
    expect(document.body.querySelector('[role="option"]')).toBeNull()
    await typeInComposer('@nobody, hi')
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })
  it('shares attachment chips and preserves the whisper / quote close controls', async () => {
    await act(async () => {
      root.render(createElement(ChatMessageComposer, {
        onSend: vi.fn(async () => {}), chatId: 'group-1',
        whisperTarget: { userId: 'u-1', displayName: 'Ada' }, onExitWhisper: vi.fn(),
        quoteContent: { messageId: 'm-1', senderName: 'Ada', content: 'hi' }, onQuoteConsumed: vi.fn(),
      }))
    })
    await flush()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('__chat_composer_attach_files', { detail: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] } }))
    })
    await flush()
    expect(container.querySelector('[data-slot="composer-attachment"]')?.textContent).toContain('note.txt')
    for (const label of ['退出悄悄话', '取消引用']) {
      const button = container.querySelector(`button[aria-label="${label}"]`)
      expect(button?.getAttribute('data-slot'), label).toBe('icon-button')
      expect(button?.getAttribute('data-size'), label).toBe('sm')
    }
  })
})
