// @vitest-environment jsdom
import { createElement } from 'react'
import type { Editor } from '../../../../packages/session-ui/node_modules/@tiptap/core'
import { expect, it, vi } from 'vitest'
import { PromptEditor } from '../../../../packages/session-ui/src/react/components/prompt-editor/prompt-editor'
import { createReactHarness } from '../../../support/testHarness'

function editorOf(harness: ReturnType<typeof createReactHarness>): Editor {
  return harness.container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable=true]')!.editor
}

it('destroys its real editor before cleanup returns and the DOM environment can be removed', async () => {
  const harness = createReactHarness()
  await harness.render(createElement(PromptEditor))
  const editor = editorOf(harness)
  const destroyed = vi.fn()
  editor.on('destroy', destroyed)
  try {
    harness.cleanup()
    expect(editor.isDestroyed).toBe(true)
    expect(destroyed).toHaveBeenCalledTimes(1)
    expect(harness.container.isConnected).toBe(false)
  } finally { editor.destroy() }
})

it('only disposes editors owned by the root being cleaned up', async () => {
  const owner = createReactHarness()
  const other = createReactHarness()
  await owner.render(createElement(PromptEditor))
  await other.render(createElement(PromptEditor))
  const ownedEditor = editorOf(owner)
  const otherEditor = editorOf(other)
  try {
    owner.cleanup()
    expect(ownedEditor.isDestroyed).toBe(true)
    expect(otherEditor.isDestroyed).toBe(false)
  } finally {
    ownedEditor.destroy()
    other.cleanup()
    otherEditor.destroy()
  }
})

it('cleans up ordinary editable DOM without an editor instance', async () => {
  const harness = createReactHarness()
  await harness.render(createElement('div', { contentEditable: true }))
  expect(() => harness.cleanup()).not.toThrow()
  expect(harness.container.isConnected).toBe(false)
})
