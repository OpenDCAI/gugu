// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../support/testHarness'
import { PromptEditor } from '../../../packages/session-ui/src/react/components/prompt-editor/prompt-editor'

// TipTap keeps the editor while a suspended EditorContent has no view. Its view.dom getter throws in that interval.
const lifecycle = vi.hoisted(() => ({ options: null as Record<string, unknown> | null, dom: null as HTMLElement | null }))
vi.mock('@tiptap/react', async (original) => {
  const actual = await original<typeof import('@tiptap/react')>()
  const editor = { get view() { if (!lifecycle.dom) throw new Error('The editor view is not available'); return { dom: lifecycle.dom } } }
  return { ...actual, useEditor: (options: Record<string, unknown>) => { lifecycle.options = options; return editor }, EditorContent: () => null }
})
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); lifecycle.dom = null; lifecycle.options = null })
afterEach(() => harness.cleanup())
it.each([true, false])('waits for the mounted view before wiring the input and ARIA (input ref: %s)', async (withRef) => {
  const input = vi.fn()
  await harness.render(createElement(PromptEditor, { ...(withRef ? { inputRef: input } : {}) }))
  expect(input.mock.calls.some(([value]) => value !== null)).toBe(false)
  const dom = document.createElement('div')
  await act(async () => {
    lifecycle.dom = dom
    ;(lifecycle.options!.onCreate as (event: unknown) => void)({ editor: { view: { dom } } })
  })
  if (withRef) expect(input).toHaveBeenLastCalledWith(dom)
  expect(dom.hasAttribute('aria-expanded')).toBe(false)
  await act(async () => {
    lifecycle.dom = null
    ;(lifecycle.options!.onUnmount as () => void)()
  })
  if (withRef) expect(input).toHaveBeenLastCalledWith(null)
})
