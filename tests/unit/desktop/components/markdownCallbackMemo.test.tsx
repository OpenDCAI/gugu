// @vitest-environment jsdom
// A message bubble re-renders (its sender's status changed, the pointer moved over it) and passes Markdown a new inline
// link callback each time. Markdown reads that callback through a ref, so the same content must not render, and parse,
// again; giving or dropping a callback still counts.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Markdown calls useTranslation once per render of its body: counting those counts the renders memo let through.
const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-i18next', async (original) => {
  const actual = await original<typeof import('react-i18next')>()
  return { ...actual, useTranslation: (...args: Parameters<typeof actual.useTranslation>) => { renders.count += 1; return actual.useTranslation(...args) } }
})
const { Markdown } = await import('../../../../apps/desktop/src/components/markdown/Markdown')

let host: HTMLDivElement
let root: Root
beforeEach(() => { renders.count = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it('renders the same content once however often the link callback is a new arrow', () => {
  const render = (props: Partial<Parameters<typeof Markdown>[0]>) => act(() => root.render(createElement(Markdown, { content: '**hi** there', trust: 'chat', ...props })))
  render({ onOpenLink: () => false })
  render({ onOpenLink: () => false })
  render({ onOpenLink: () => true })
  expect(renders.count).toBe(1)
  render({ content: '**hi** again', onOpenLink: () => false })
  expect(renders.count).toBe(2)
})
