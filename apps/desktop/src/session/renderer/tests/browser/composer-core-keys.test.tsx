/**
 * Composer core keys - wiring layer (session-browser).
 *
 * These criteria render the real ChatComposer and send keyboard events to its real ProseMirror
 * contenteditable. The node-side extension tests cover decisions; these prove the keys reach them.
 */
import {
  ChatComposer,
  MessageProvider,
  type CommandItem,
  type MentionItem,
  type PromptEditorRef
} from '@gugu/session-ui/react/components'
import { page, userEvent } from 'vitest/browser'
import {
  registerSessionLocaleResources,
  translateSessionMessage
} from '@renderer/localization/locale-store'
import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

const MENTION: MentionItem = {
  id: 'src/prompt-editor.tsx',
  label: 'src/prompt-editor.tsx',
  name: 'prompt-editor.tsx',
  kind: 'file'
}

const COMMAND: CommandItem = {
  id: 'review',
  name: 'review',
  label: 'Review changes',
  behavior: 'execute'
}

let root: Root | null = null
let container: HTMLDivElement | null = null
const onSubmit = vi.fn()
const onInputChange = vi.fn()
const queryMentions = vi.fn(async () => [MENTION])
const queryCommands = vi.fn(async () => [COMMAND])
const editorApiRef = createRef<PromptEditorRef>()

function render(callbacks: {
  onImageFilesDropped?: (files: File[]) => void
  onFilesDropped?: (files: File[]) => void
} = {}): void {
  container = document.createElement('div')
  container.className = 'emlight gugu-skin bg-background'
  document.body.appendChild(container)
  root = createRoot(container)
  root.render(
    <MessageProvider locale="zh-CN" translate={translateSessionMessage}>
      <ChatComposer
        onSubmit={onSubmit}
        onInputChange={onInputChange}
        onStop={() => {}}
        onImageFilesDropped={callbacks.onImageFilesDropped}
        onFilesDropped={callbacks.onFilesDropped}
        editorApiRef={editorApiRef}
        queryMentions={queryMentions}
        queryCommands={queryCommands}
      />
    </MessageProvider>
  )
}

const editor = () => page.getByTestId('prompt-editor')
const editorText = (): string =>
  (document.querySelector<HTMLElement>('[data-testid="prompt-editor"]')?.textContent ?? '').trim()
const popupCount = (): number => document.querySelectorAll('[role="listbox"]').length
const mentionOption = () => page.getByRole('option', { name: /prompt-editor\.tsx/ })
const mentionOptionVisible = (): boolean => mentionOption().query()?.checkVisibility() === true
const calledWithEmptyQuery = (mock: { mock: { calls: unknown[][] } }): boolean =>
  mock.mock.calls.some((call) => call.length === 1 && call[0] === '')
const mentionCount = (): number => document.querySelectorAll('[data-mention-id]').length
const composerBarMounted = (): boolean => document.querySelector('[data-slot="composer-bar"]') != null

describe('composer core keys - wiring layer (session-browser)', () => {
  beforeEach(async () => {
    registerSessionLocaleResources()
    await page.viewport(1100, 700)
    onSubmit.mockReset()
    onInputChange.mockReset()
    queryMentions.mockClear()
    queryMentions.mockImplementation(async () => [MENTION])
    queryCommands.mockClear()
    render()
    await editor().click()
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('wiring layer (session-browser): Enter reaches submit exactly once and does not add a line', async () => {
    await userEvent.keyboard('send this')
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.keyboard('{Enter}')

    await until('Enter submits the text', () => JSON.stringify(onSubmit.mock.calls) === JSON.stringify([['send this']]))
    expect(onSubmit.mock.calls).toEqual([['send this']])
    await until('editor clears after submit', () => editorText() === '')
  })

  it('wiring layer (session-browser): @ that only matches a disabled notice row still lets Enter submit', async () => {
    // 有机器还没读到会话列表时,@ 弹层末尾挂一行「没读到」(点不了);@ 谁都没匹配上,弹层里只剩它。
    queryMentions.mockImplementation(async () => [
      { id: 'not-read:dev-c', label: '', name: 'not read yet', kind: 'custom', disabled: true }
    ])
    await userEvent.keyboard('ask @zzz')
    await until('notice row visible', () => page.getByRole('option', { name: /not read yet/ }).query()?.checkVisibility() === true)

    await userEvent.keyboard('{Enter}')

    await until('Enter submits the text', () => JSON.stringify(onSubmit.mock.calls) === JSON.stringify([['ask @zzz']]))
  })

  it('wiring layer (session-browser): Shift+Enter reaches hard break and does not submit', async () => {
    await userEvent.keyboard('first{Shift>}{Enter}{/Shift}second')

    await until('input change reports the hard break', () => onInputChange.mock.calls.at(-1)?.[0] === 'first\nsecond')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('wiring layer (session-browser): paste routes image files to the ACP image host', async () => {
    const onImageFilesDropped = vi.fn()
    const image = new File(['png'], 'clipboard.png', { type: 'image/png' })
    const clipboardData = {
      items: [{ kind: 'file', type: image.type, getAsFile: () => image }],
      types: ['Files'],
      getData: () => '',
    }
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData })

    root?.unmount()
    root = null
    container?.remove()
    container = null
    render({ onImageFilesDropped })
    await editor().click()
    await until('composer bar mounted', composerBarMounted)
    const target = document.querySelector('[data-slot="composer-bar"]') as HTMLElement
    target.dispatchEvent(paste)

    await until('image paste reaches the host', () => onImageFilesDropped.mock.calls.length === 1)
    expect(onImageFilesDropped.mock.calls[0]?.[0]).toEqual([image])
  })

  it('wiring layer (session-browser): paste routes ordinary files to the local path host', async () => {
    const onFilesDropped = vi.fn()
    const documentFile = new File(['text'], 'notes.txt', { type: 'text/plain' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: documentFile.type, getAsFile: () => documentFile }],
        types: ['Files'],
        getData: () => '',
      },
    })
    root?.unmount()
    root = null
    container?.remove()
    container = null
    render({ onFilesDropped })
    await editor().click()
    await until('composer bar mounted', composerBarMounted)
    const target = document.querySelector('[data-slot="composer-bar"]') as HTMLElement
    target.dispatchEvent(paste)

    await until('file paste reaches the host', () => onFilesDropped.mock.calls.length === 1)
    expect(onFilesDropped.mock.calls[0]?.[0]).toEqual([documentFile])
    await page.screenshot({ path: 'task-composer-paste-image-and-file.png' })
  })

  it('wiring layer (session-browser): @ opens mention at the empty editor start but not inside a@b', async () => {
    await userEvent.keyboard('a@b')
    // The suggestion plugin view runs synchronously inside the editor's state update, and with
    // debounce 0 it calls `items` (→ queryMentions) in that same call. So once the editor state
    // holds 'a@b', a mention query would already have happened.
    await until('editor state holds a@b', () => editorApiRef.current?.getText() === 'a@b')
    expect(queryMentions.mock.calls.length).toBe(0)
    expect(popupCount()).toBe(0)

    editorApiRef.current?.clear()
    await userEvent.keyboard('@')

    await until('mention option visible', mentionOptionVisible)
    await expect.element(mentionOption()).toBeVisible()
    expect(queryMentions).toHaveBeenCalledWith('')
  })

  it('wiring layer (session-browser): @ opens mention after a hard break', async () => {
    await userEvent.keyboard('first{Shift>}{Enter}{/Shift}@')

    await until('mention query fires with an empty query', () => calledWithEmptyQuery(queryMentions))
    await until('mention option visible', mentionOptionVisible)
    await expect.element(mentionOption()).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('wiring layer (session-browser): @ does not open mention immediately after punctuation', async () => {
    await userEvent.keyboard('hello,@file')

    // Same completion fact as the a@b case: the suggestion plugin view has run once the state holds the text.
    await until('editor state holds hello,@file', () => editorApiRef.current?.getText() === 'hello,@file')
    expect(queryMentions.mock.calls.length).toBe(0)
    expect(popupCount()).toBe(0)
  })

  it('wiring layer (session-browser): selecting a mention leaves a separator for another @', async () => {
    await userEvent.keyboard('@')
    await page.getByRole('option', { name: /prompt-editor\.tsx/ }).click()
    await until('mention pill inserted', () => mentionCount() === 1)

    queryMentions.mockClear()
    await userEvent.keyboard('@')

    await until('mention query fires with an empty query', () => calledWithEmptyQuery(queryMentions))
    await until('mention option visible', mentionOptionVisible)
    await expect.element(mentionOption()).toBeVisible()
  })

  it('wiring layer (session-browser): mention is atomic when backspace is pressed at its boundary', async () => {
    await userEvent.keyboard('@')
    await page.getByRole('option', { name: /prompt-editor\.tsx/ }).click()
    await until('mention pill inserted', () => mentionCount() === 1)

    // The composer leaves a separator after a selected mention so another @ can be typed. Move
    // across that separator first, then Backspace must delete the atomic mention node as one unit.
    await userEvent.keyboard('{ArrowLeft}{Backspace}')
    await until('mention pill deleted as one unit', () => mentionCount() === 0)
    expect(editorText()).toBe('')
  })

  it('wiring layer (session-browser): / opens commands at any cursor position', async () => {
    await userEvent.keyboard('prefix /')
    await until('command query fires with an empty query', () => calledWithEmptyQuery(queryCommands))
    await until('command popup opens', () => popupCount() === 1)
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('/review')

    editorApiRef.current?.clear()
    await editor().click()
    await userEvent.keyboard('/')

    await until('command query fires with an empty query', () => calledWithEmptyQuery(queryCommands))
    await until('command popup opens', () => popupCount() === 1)
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('/review')
  })

  it('wiring layer (session-browser): / opens commands after a hard break', async () => {
    await userEvent.keyboard('first{Shift>}{Enter}{/Shift}/')

    await until('command query fires with an empty query', () => calledWithEmptyQuery(queryCommands))
    await until('command popup opens', () => popupCount() === 1)
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('/review')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
