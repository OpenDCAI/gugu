// @vitest-environment jsdom
// The bar a search leaves over the conversation it opened: 「n/N」, previous / next (⌘G), 「结果」 reopens the panel as
// it was left, × puts the search away. It shows only on the conversation that holds the current hit.
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const opened = vi.hoisted(() => [] as unknown[])
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink: (target: unknown) => { opened.push(target); return true } }))

const { SearchTrailBar } = await import('../../../../apps/desktop/src/components/chat/SearchTrailBar')
const { commandRegistry } = await import('../../../../apps/desktop/src/session/renderer/lib/commands/registry')
const { resetSearchSession, updateSearchSession, useSearchSession } = await import('../../../../apps/desktop/src/session/renderer/features/global-search/search-session')

const [C1, C2, M1, M2, M3] = ['0b1e7c1a-0000-4000-8000-0000000000c1', '0b1e7c1a-0000-4000-8000-0000000000c2', '0b1e7c1a-0000-4000-8000-0000000000a1', '0b1e7c1a-0000-4000-8000-0000000000a2', '0b1e7c1a-0000-4000-8000-0000000000a3']
const hits = [{ chatId: C1, messageId: M1 }, { chatId: C1, messageId: M2 }, { chatId: C2, messageId: M3 }]
let harness: ReturnType<typeof createReactHarness>
let index = () => -1
function Surface({ chatId }: { chatId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const { trail } = useSearchSession()
  index = () => trail?.index ?? -1
  return createNode('div', { ref, 'data-chat-surface': chatId }, createNode(SearchTrailBar, { chatId, surface: ref, enabled: true }))
}
const bar = () => harness.container.querySelector<HTMLElement>('[data-testid=search-trail-bar]')
const button = (label: RegExp) => [...bar()!.querySelectorAll<HTMLElement>('button')].find((b) => label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!

beforeEach(() => {
  // jsdom omits CSS.escape. This fixture only uses selector-safe UUIDs, but a
  // real paint frame still calls the browser API before looking up a row.
  vi.stubGlobal('CSS', { escape: vi.fn((id: string) => id) })
  harness = createReactHarness(); opened.length = 0
})
afterEach(() => { harness.cleanup(); resetSearchSession(); vi.unstubAllGlobals() })

describe('search trail bar', () => {
  it('exercises the deferred paint lookup while the toolbar remains mounted', async () => {
    updateSearchSession({ trail: { hits, index: 0, query: '蓝鲸' } })
    await renderWithAppProviders(harness, createNode(Surface, { chatId: C1 }))
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    expect(CSS.escape).toHaveBeenCalledWith(M1)
  })

  it('shows the position on the conversation holding the current hit, and nothing elsewhere', async () => {
    updateSearchSession({ trail: { hits, index: 1, query: '蓝鲸' } })
    await renderWithAppProviders(harness, createNode(Surface, { chatId: C1 }))
    expect(bar()?.textContent).toContain('2/3')
    expect(bar()?.textContent).toContain('蓝鲸')
    await renderWithAppProviders(harness, createNode(Surface, { chatId: C2 }))
    expect(bar()).toBeNull()
  })

  it('next and previous step through the hits, wrapping, and open each one where it was said', async () => {
    updateSearchSession({ trail: { hits, index: 1, query: '蓝鲸' } })
    await renderWithAppProviders(harness, createNode(Surface, { chatId: C1 }))
    await clickElement(button(/Previous|上一条/))
    expect(index()).toBe(0)
    expect(opened).toEqual([conversationLink(C1, M1)])
    await clickElement(button(/Previous|上一条/))
    expect(index()).toBe(2)
    expect(opened[1]).toEqual(conversationLink(C2, M3))
  })

  it('⌘G is the next hit while this conversation is the search target', async () => {
    updateSearchSession({ trail: { hits, index: 0, query: '蓝鲸' } })
    await renderWithAppProviders(harness, createNode(Surface, { chatId: C1 }))
    await act(async () => { commandRegistry.setContext(bar()!); expect(commandRegistry.dispatch('app.findNext')).toBe(true) })
    expect(index()).toBe(1)
    expect(opened).toEqual([conversationLink(C1, M2)])
    commandRegistry.setContext(document.body)
  })

  it('「结果」 reopens the panel without starting over, and × puts the search away', async () => {
    const openPanel = vi.fn()
    const unregister = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', execute: openPanel }] })
    try {
      updateSearchSession({ text: '蓝鲸', trail: { hits, index: 0, query: '蓝鲸' } })
      await renderWithAppProviders(harness, createNode(Surface, { chatId: C1 }))
      await clickElement(harness.container.querySelector<HTMLElement>('[data-testid=search-trail-results]')!)
      expect(openPanel).toHaveBeenCalledOnce()
      expect(index()).toBe(0)
      await clickElement(button(/Close search|退出搜索/))
      expect(bar()).toBeNull()
    } finally { unregister() }
  })
})
