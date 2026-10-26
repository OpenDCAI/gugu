// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { Editor } from '../../../../packages/session-ui/node_modules/@tiptap/core'
import { expect, it, vi } from 'vitest'
import { CONTENT_MENU_EVENT, type ContentMenuSnapshot } from '@gugu/session-shared/content-menu'
import { PromptEditor } from '../../../../packages/session-ui/src/react/components/prompt-editor/prompt-editor'
import { createReactHarness } from '../../../support/testHarness'

it('snapshots the editor history instead of Chromium history without changing the document', async () => {
  const harness = createReactHarness()
  try {
    await harness.render(createElement(PromptEditor))
    const element = harness.container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable=true]')!
    const editor = element.editor
    const snapshot = () => {
      const detail: ContentMenuSnapshot = { action: 'snapshot' }
      element.dispatchEvent(new CustomEvent(CONTENT_MENU_EVENT, { detail }))
      return detail.editorHistory
    }
    await vi.waitFor(() => expect(snapshot()).toEqual({ undo: false, redo: false }))
    await act(() => { editor.view.dispatch(editor.state.tr.insertText('menu history')) })
    expect(snapshot()).toEqual({ undo: true, redo: false })
    expect(editor.getText()).toBe('menu history')
    await act(() => {
      const command = new CustomEvent(CONTENT_MENU_EVENT, { detail: { action: 'undo' }, cancelable: true })
      element.dispatchEvent(command)
      expect(command.defaultPrevented).toBe(true)
    })
    expect(snapshot()).toEqual({ undo: false, redo: true })
    await act(() => {
      element.dispatchEvent(new CustomEvent(CONTENT_MENU_EVENT, { detail: { action: 'redo' }, cancelable: true }))
    })
    expect(editor.getText()).toBe('menu history')
    expect(snapshot()).toEqual({ undo: true, redo: false })
  } finally { harness.cleanup() }
})
