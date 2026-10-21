/**
 * #7111(复核 156 第 3 轮):「@」重查的两条新路径。
 *
 * 1. ComboboxPopup:先高亮 B,列表再变成 [N, A, B, C]。带 keepActiveOnChange(同一个查询重查回来)时高亮仍在 B;
 *    不带(用户又打了字)时回到第一条 N —— 后一条同时就是前一条的阴控。
 * 2. PromptEditor:提供方 onResultsChanged 触发的重查带 `{ requery: true }`;用户自己打「@」走的 search 不带。
 *    否则停在「@」上会 search('') → 重扫 → 重查 search('') → 又重扫,闭环。
 * 判据都是「等到某件必然发生的事」,❌ 墙钟。
 */
import { ChatComposer, MessageProvider, type ContextMentionProvider, type MentionItem } from '@gugu/session-ui/react/components'
import { ComboboxPopup, type ComboboxPopupHandle, type ComboboxPopupItem } from '@gugu/session-ui/react/primitives'
import { userEvent } from 'vitest/browser'
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

let root: Root | null = null
let container: HTMLDivElement | null = null

function mountHost(): Root {
  container = document.createElement('div')
  container.className = 'emlight gugu-skin bg-background'
  document.body.appendChild(container)
  root = createRoot(container)
  return root
}

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
})

const item = (id: string): ComboboxPopupItem => ({ id, label: id })
// 高亮那一条带一个「↵」提示,判的是条目本身
const activeLabel = (): string | null =>
  document.querySelector('[role="option"][aria-selected="true"]')?.textContent?.replace('↵', '').trim() ?? null

describe('ComboboxPopup keeps the highlighted item across a refresh only when told to', () => {
  async function highlightBThenChange(keepActiveOnChange: boolean): Promise<string | null> {
    const ref = createRef<ComboboxPopupHandle>()
    const r = mountHost()
    const rect = new DOMRect(100, 100, 10, 20)
    const render = (items: ComboboxPopupItem[]) =>
      r.render(<ComboboxPopup ref={ref} items={items} anchorRect={rect} onSelect={() => {}} keepActiveOnChange={keepActiveOnChange} />)
    act(() => render([item('A'), item('B'), item('C')]))
    await until('popup is up with A highlighted', () => activeLabel() === 'A')
    act(() => void ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })))
    await until('B highlighted', () => activeLabel() === 'B')
    act(() => render([item('N'), item('A'), item('B'), item('C')]))
    await until('the new list is on screen', () => document.querySelectorAll('[role="option"]').length === 4)
    return activeLabel()
  }

  it('keepActiveOnChange: still on B after the list became [N, A, B, C]', async () => {
    expect(await highlightBThenChange(true)).toBe('B')
  })

  it('without it (the user typed): back to the first item N', async () => {
    expect(await highlightBThenChange(false)).toBe('N')
  })
})

describe('PromptEditor re-queries with { requery: true } only when the provider says results changed', () => {
  beforeEach(() => registerSessionLocaleResources())

  it('typing "@" searches without requery; onResultsChanged re-queries the same query with requery', async () => {
    const FILE: MentionItem = { id: 'a.txt', label: 'a.txt', name: 'a.txt', kind: 'file' }
    let changed: (() => void) | null = null
    const search = vi.fn<ContextMentionProvider['search']>(async () => [FILE])
    const provider: ContextMentionProvider = {
      search,
      onResultsChanged(listener) {
        changed = listener
        return () => {
          changed = null
        }
      },
    }
    mountHost().render(
      <MessageProvider locale="zh-CN" translate={translateSessionMessage}>
        <ChatComposer onSubmit={() => {}} onStop={() => {}} mentionProvider={provider} />
      </MessageProvider>
    )
    const editor = () => container!.querySelector<HTMLElement>('[contenteditable="true"]')
    await until('editor mounted', () => editor() != null && changed != null)
    editor()!.focus()
    await userEvent.keyboard('@')
    await until('"@" asked the provider', () => search.mock.calls.length > 0)
    await until('suggestions on screen', () => document.querySelector('[role="option"]') != null)
    expect(search.mock.calls.every(([, options]) => !options?.requery)).toBe(true)

    const typed = search.mock.calls.length
    act(() => changed!())
    await until('re-queried once', () => search.mock.calls.length === typed + 1)
    expect(search.mock.calls.at(-1)).toEqual(['', { requery: true }])
  })
})
