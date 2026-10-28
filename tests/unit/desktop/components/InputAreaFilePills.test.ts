// @vitest-environment jsdom
import { act, createElement, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readComposer, selectComposer, writeComposer } from '../../../support/composerEditor'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { ChatStoreProvider, useChatStore, useTextDraftStore, type DraftAttachment, type DraftMention } from '../../../../apps/desktop/src/store/chatContext'
import { chatStore } from '../../../support/testHarness'
import { APP_COMPOSE_EVENT, type AppComposeDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { filePillText } from '../../../../apps/desktop/src/components/markdown/filePills'

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: toastMock }) }))

const DECK = 'gugu-file://0c000000-0000-4000-8000-0000000000a1?v=7#slide=3&shape=12'
const SHEET = 'gugu-file://0c000000-0000-4000-8000-0000000000a2?v=2#range=销售!B2:D4'
const deckPill = { label: '演示稿 · 第 3 页 · 标题', link: DECK }
const sheetPill = { label: '预算 · 销售!B2:D4 · 3×3', link: SHEET }
const deckToken = `@[演示稿 · 第 3 页 · 标题](${DECK})`
const sheetToken = `@[预算 · 销售!B2:D4 · 3×3](${SHEET})`

let container: HTMLDivElement
let root: Root
let store: ReturnType<typeof useChatStore>
type ComposerProps = Parameters<typeof ChatMessageComposer>[0]

function Host({ chatId, onSend, quoteContent, surface }: Pick<ComposerProps, 'chatId' | 'onSend' | 'quoteContent' | 'surface'>) {
  const { drafts, setDraft } = useTextDraftStore()
  const [draftMentions, setDM] = useState<Record<string, DraftMention[]>>({})
  const [draftAttachments, setDA] = useState<Record<string, DraftAttachment[]>>({})
  const setDraftMentions = useCallback((id: string, m: DraftMention[]) => setDM((p) => ({ ...p, [id]: m })), [])
  const setDraftAttachments = useCallback((id: string, a: DraftAttachment[]) => setDA((p) => ({ ...p, [id]: a })), [])
  const value = useMemo(
    () => ({ ...chatStore(), drafts, draftMentions, draftAttachments, setDraft, setDraftMentions, setDraftAttachments }),
    [drafts, draftMentions, draftAttachments, setDraft, setDraftMentions, setDraftAttachments],
  )
  return createElement(ChatStoreProvider, { value }, createElement(AppHost), createElement(ChatMessageComposer, { onSend, chatId, quoteContent, surface, isGroupChat: true, groupMembers: [] }))
}

function AppHost() {
  store = useChatStore()
  const { writeDraft } = store
  useEffect(() => {
    const compose = (event: Event) => {
      const detail = (event as CustomEvent<AppComposeDetail>).detail
      const text = [detail.text, ...(detail.refs ?? []).map(filePillText)].filter(Boolean).join('\n')
      if (text) writeDraft(detail.chatId, { at: 'end', text })
    }
    window.addEventListener(APP_COMPOSE_EVENT, compose)
    return () => window.removeEventListener(APP_COMPOSE_EVENT, compose)
  }, [writeDraft])
  return null
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
const pills = () => [...textarea().querySelectorAll<HTMLElement>('[data-mention-kind="file"]')]
const textarea = () => container.querySelector('[contenteditable]') as HTMLElement
const sendButton = () => [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送消息') as HTMLButtonElement
async function type(value: string) {
  await act(async () => {
    writeComposer(textarea(), value)
  })
  await flush()
}
async function send() {
  await act(async () => {
    sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
  await flush()
}
async function mount(onSend: ComposerProps['onSend'], chatId = 'group-1', quoteContent?: ComposerProps['quoteContent']) {
  await act(async () => { root.render(createElement(Host, { chatId, onSend, quoteContent })) })
  await flush()
}
async function draft(text: string) {
  await act(async () => store.writeDraft('group-1', text))
  await flush()
}

beforeEach(() => {
  setLocalePreference('zh-CN')
  toastMock.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('file citations share the composer document with the words', () => {
  it('restores multiple inline atoms in order, including their full label and picked version', async () => {
    await mount(vi.fn(async () => {}))
    const text = `先改 ${deckToken}，再改 ${sheetToken}，最后检查。`
    await draft(text)
    expect(pills().map((pill) => pill.textContent)).toEqual([deckPill.label, sheetPill.label])
    expect(pills()[0]!.title).toBe(`${deckPill.label} · 第 7 版上选的`)
    expect(pills()[1]!.getAttribute('data-mention-id')).toBe(SHEET)
    expect(readComposer(textarea())).toBe(text)
  })

  it('sends the exact mixed order instead of collecting references at the end', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend)
    const text = `把 ${deckToken} 改成蓝色\n${sheetToken} 保持不变`
    await draft(text)
    await send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]![0]).toBe(text)
    expect(pills()).toHaveLength(0)
    expect(store.drafts['group-1']).toBe('')
  })

  it('allows a citation alone to be sent', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend)
    await draft(deckToken)
    expect(sendButton().disabled).toBe(false)
    await send()
    expect(onSend.mock.calls[0]![0]).toBe(deckToken)
  })

  it('removes one whole atom while preserving the other citation and surrounding words', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend)
    await draft(`看 ${deckToken} 和 ${sheetToken} 这两处`)
    const remove = pills()[0]!.querySelector('button')!
    expect(remove.getAttribute('aria-label')).toBe(`Remove @${deckPill.label}`)
    await act(async () => { remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(pills().map((pill) => pill.textContent)).toEqual([sheetPill.label])
    await send()
    expect(onSend.mock.calls[0]![0]).toBe(`看  和 ${sheetToken} 这两处`)
  })

  it('pastes repeated references at the selection without moving or deduplicating them', async () => {
    await mount(vi.fn(async () => {}))
    await type('前后')
    await act(async () => {
      selectComposer(textarea(), 1)
      const event = new Event('paste', { bubbles: true, cancelable: true })
      const text = `${deckToken} 和 ${sheetToken} 再看 ${deckToken}`
      Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? text : '' } })
      textarea().dispatchEvent(event)
    })
    expect(readComposer(textarea())).toBe(`前${deckToken} 和 ${sheetToken} 再看 ${deckToken}后`)
    expect(pills().map((pill) => pill.getAttribute('data-mention-id'))).toEqual([DECK, SHEET, DECK])
  })

  it.each(['main', 'aside'] as const)('keeps pending typing and consecutive App citations in the %s composer', async (surface) => {
    await act(async () => root.render(createElement(Host, { chatId: 'group-1', onSend: vi.fn(async () => {}), surface })))
    await flush()
    await type('Fresh instructions')
    await act(async () => {
      for (const ref of [deckPill, sheetPill]) document.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, {
        bubbles: true, detail: { chatId: 'group-1', text: '', refs: [ref] },
      }))
    })
    expect(readComposer(textarea())).toBe(`Fresh instructions\n${deckToken}\n${sheetToken}`)
    expect(pills()).toHaveLength(2)
  })

  it('restores the inline order after a failed send', async () => {
    const onSend = vi.fn(async () => { throw new Error('offline') })
    await mount(onSend)
    const text = `改 ${deckToken}，保留 ${sheetToken}`
    await draft(text)
    await send()
    expect(readComposer(textarea())).toBe(text)
    expect(pills()).toHaveLength(2)
    expect(toastMock).toHaveBeenCalledWith('发送失败：offline', 'error')
  })

  it('restores a failed send to its original chat without leaking into another draft', async () => {
    let reject!: (reason: Error) => void
    const onSend = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    await mount(onSend)
    const text = `改 ${deckToken}，保留 ${sheetToken}`
    await draft(text)
    await send()
    await mount(onSend, 'group-2')
    await type('第二个群的草稿')
    await act(async () => { reject(new Error('offline')); await Promise.resolve() })
    await flush()
    expect(readComposer(textarea())).toBe('第二个群的草稿')
    expect(pills()).toHaveLength(0)
    expect(store.drafts['group-1']).toBe(text)
    await mount(onSend)
    expect(readComposer(textarea())).toBe(text)
    expect(pills()).toHaveLength(2)
  })

  it('keeps the reply above the editor and sends its relation alongside inline file citations', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend, 'group-1', { messageId: 'message-1', senderName: 'Alice', content: '原消息', source: { sender_user_id: 'alice', to_user_ids: null, is_whisper: false } })
    await draft(deckToken)
    expect(container.textContent).toContain('原消息')
    expect(textarea().textContent).not.toContain('原消息')
    await send()
    expect(onSend.mock.calls[0]).toEqual([deckToken, expect.objectContaining({ replyToMessageId: 'message-1' })])
  })
})
