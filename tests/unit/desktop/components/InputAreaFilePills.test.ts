// @vitest-environment jsdom
import { act, createElement, useCallback, useMemo, useState, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputArea } from '../../../../apps/desktop/src/components/chat/InputArea'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { ChatStoreProvider, type DraftAttachment, type DraftMention, type DraftRef } from '../../../../apps/desktop/src/store/chatContext'
import { chatStore } from '../../../support/testHarness'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'

/**
 * App 引用 pill, the group composer (owner 10-14, A): the pills a compose's refs make — or a pasted one — sit in the row
 * above the input, beside the files; ✕ takes one out whole; on send they go under the words, as the bubble draws them;
 * a send that fails gives them back to the row, not to the words. The chat's store holds them per chat (`draftRefs`).
 */

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))
vi.mock('textarea-caret', () => ({ default: vi.fn(() => ({ left: 0, top: 5, height: 20 })) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: toastMock }) }))

const DECK = 'gugu-file://0c000000-0000-4000-8000-0000000000a1?v=7#slide=3&shape=12'
const SHEET = 'gugu-file://0c000000-0000-4000-8000-0000000000a2?v=2#range=销售!B2:D4'
const deckPill: DraftRef = { label: '演示稿 · 第 3 页 · 标题', link: DECK }
const sheetPill: DraftRef = { label: '预算 · 销售!B2:D4 · 3×3', link: SHEET }
const deckToken = `@[演示稿 · 第 3 页 · 标题](${DECK})`
const sheetToken = `@[预算 · 销售!B2:D4 · 3×3](${SHEET})`

let container: HTMLDivElement
let root: Root
/** The store's per-chat pills, as the chat shell sees them (MainLayout writes a compose's here). */
let store: { refs: Record<string, DraftRef[]>; setRefs: (chatId: string, refs: DraftRef[]) => void }

function Host({ chatId, onSend }: { chatId: string; onSend: (content: string, opts?: unknown) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [draftMentions, setDM] = useState<Record<string, DraftMention[]>>({})
  const [draftAttachments, setDA] = useState<Record<string, DraftAttachment[]>>({})
  const [draftRefs, setDR] = useState<Record<string, DraftRef[]>>({})
  const setDraft = useCallback((id: string, update: SetStateAction<string>) => setDrafts((p) => ({ ...p, [id]: typeof update === 'function' ? update(p[id] ?? '') : update })), [])
  const setDraftMentions = useCallback((id: string, m: DraftMention[]) => setDM((p) => ({ ...p, [id]: m })), [])
  const setDraftAttachments = useCallback((id: string, a: DraftAttachment[]) => setDA((p) => ({ ...p, [id]: a })), [])
  const setDraftRefs = useCallback((id: string, r: DraftRef[]) => setDR((p) => ({ ...p, [id]: r })), [])
  store = { refs: draftRefs, setRefs: setDraftRefs }
  const value = useMemo(
    () => ({ ...chatStore(), drafts, draftMentions, draftAttachments, draftRefs, setDraft, setDraftMentions, setDraftAttachments, setDraftRefs }),
    [drafts, draftMentions, draftAttachments, draftRefs, setDraft, setDraftMentions, setDraftAttachments, setDraftRefs],
  )
  return createElement(ChatStoreProvider, { value }, createElement(InputArea, { onSend, chatId, isGroupChat: true, groupMembers: [] }))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
const pills = () => [...container.querySelectorAll<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.composerFilePill}"]`)]
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement
const sendButton = () => [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送') as HTMLButtonElement
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
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
async function mount(onSend: (content: string, opts?: unknown) => Promise<void>) {
  await act(async () => {
    root.render(createElement(Host, { chatId: 'group-1', onSend }))
  })
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

describe('the group composer holds an App’s pills in the row above the input', () => {
  it('a compose’s pills show in the row, each whole, with what the App called it; the words stay the person’s', async () => {
    await mount(vi.fn(async () => {}))
    await act(async () => store.setRefs('group-1', [deckPill, sheetPill]))
    await flush()
    expect(pills().map((pill) => pill.textContent)).toEqual([deckPill.label, sheetPill.label])
    // The version it was picked on, on hover — the bubble's words.
    expect(pills()[0]!.title).toBe(`${deckPill.label} · 第 7 版上选的`)
    expect(textarea().value).toBe('')
    // Pills alone can be sent.
    expect(sendButton().disabled).toBe(false)
  })

  it('send: the words, then the pills under them as the bubble draws them; the row empties', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend)
    await act(async () => store.setRefs('group-1', [deckPill, sheetPill]))
    await type('把这两处改成蓝色')
    await send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]![0]).toBe(`把这两处改成蓝色\n\n${deckToken} ${sheetToken}`)
    expect(pills()).toHaveLength(0)
    expect(store.refs['group-1']).toEqual([])
  })

  it('pills alone go as they are', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend)
    await act(async () => store.setRefs('group-1', [deckPill]))
    await send()
    expect(onSend.mock.calls[0]![0]).toBe(deckToken)
  })

  it('✕ takes a pill out whole: the other stays, and is what goes', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {})
    await mount(onSend)
    await act(async () => store.setRefs('group-1', [deckPill, sheetPill]))
    await flush()
    const remove = pills()[0]!.querySelector('button') as HTMLButtonElement
    expect(remove.getAttribute('aria-label')).toBe(`移除 ${deckPill.label}`)
    await act(async () => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(pills().map((pill) => pill.textContent)).toEqual([sheetPill.label])
    await type('看这一格')
    await send()
    expect(onSend.mock.calls[0]![0]).toBe(`看这一格\n\n${sheetToken}`)
  })

  it('a pill pasted into the words (a bubble copied) goes to the row; a second copy of one held is not added', async () => {
    await mount(vi.fn(async () => {}))
    await act(async () => store.setRefs('group-1', [deckPill]))
    await type(`看 ${deckToken} 和 ${sheetToken} 这两处`)
    expect(textarea().value).toBe('看 和 这两处')
    expect(pills().map((pill) => pill.textContent)).toEqual([deckPill.label, sheetPill.label])
    // Control: an @[…](…) that is no group file's stays in the words (the session page's own mentions).
    await type('问 @[Claude 1](aid:abc) 一下')
    expect(textarea().value).toBe('问 @[Claude 1](aid:abc) 一下')
    expect(pills()).toHaveLength(2)
  })

  it('a send that fails gives the pills back to the row, not to the words', async () => {
    const onSend = vi.fn(async (_content: string, _opts?: unknown) => {
      throw new Error('offline')
    })
    await mount(onSend)
    await act(async () => store.setRefs('group-1', [deckPill]))
    await type('改一下')
    await send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(textarea().value).toBe('改一下')
    expect(pills().map((pill) => pill.textContent)).toEqual([deckPill.label])
    expect(toastMock).toHaveBeenCalledWith('发送失败：offline', 'error')
  })
})
