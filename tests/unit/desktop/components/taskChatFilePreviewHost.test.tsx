// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createReactHarness, clickElement } from '../../../support/testHarness'
import { TaskChatFilePreviewHost } from '../../../../apps/desktop/src/components/assistant/TaskChatFilePreviewHost'
import { useMessageFilePreview } from '../../../../apps/desktop/src/components/chat/useMessageFilePreview'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { Sheet } from '../../../../apps/desktop/src/components/ui/Sheet'
import { NATIVE_BACK_EVENT } from '../../../../apps/desktop/src/components/ui/sheetStack'

vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/lib/attachmentBytes', () => ({
  attachmentBytes: async () => ({ status: 'ready', blob: new Blob(['original text']) }),
  sourceKeyOf: () => 'session-file', attachmentPreview: vi.fn(), openAttachmentInSystemApp: vi.fn(),
}))
function Conversation({ mobile }: { mobile: boolean }) {
  const [draft] = useState('unfinished task draft')
  const preview = useMessageFilePreview({ mobile, visible: true, closeRightSurfaces() {}, toast() {}, onForward() {} })
  return <>
    <textarea defaultValue={draft} aria-label="task draft" />
    <button onClick={() => preview.open({ kind: 'file', fileName: 'notes.txt', mimeType: 'text/plain', sizeBytes: 13, source: { kind: 'attachment', attachmentId: 'file-id' } })}>Open file</button>
    {preview.panel}
  </>
}
let ui: ReturnType<typeof createReactHarness>
beforeEach(() => { ui = createReactHarness(); setLocalePreference('en-US') })
afterEach(() => ui.cleanup())
describe('file preview within a task conversation', () => {
  it('uses the original desktop task pane, preserves its mounted draft, and restores it on close', async () => {
    await ui.render(<TaskChatFilePreviewHost mobile={false}><Conversation mobile={false} /></TaskChatFilePreviewHost>)
    const draft = ui.container.querySelector('textarea')!
    await clickElement(ui.container.querySelector('button')!)
    await act(async () => {})
    const pane = ui.container.querySelector('[data-testid="task-chat-file-preview"]')!
    expect(pane.textContent).toContain('original text')
    expect(pane.querySelector('aside')?.style.width).toBe('100%')
    expect(ui.container.querySelector('.task-chat-conversation')?.classList.contains('hidden')).toBe(true)
    expect(ui.container.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('unfinished task draft')
    const back = pane.querySelector<HTMLButtonElement>('header button[aria-label="Back"]')!
    expect(back.getAttribute('aria-label')).toBe('Back')
    await clickElement(back)
    expect(pane.textContent).toBe('')
    expect(pane.classList.contains('hidden')).toBe(true)
    expect(ui.container.querySelector('.task-chat-conversation')?.classList.contains('hidden')).toBe(false)
    expect(ui.container.querySelector('textarea')).toBe(draft)
  })
  it('Escape returns to the same draft, while a composing Escape is left to the input method', async () => {
    await ui.render(<TaskChatFilePreviewHost mobile={false}><Conversation mobile={false} /></TaskChatFilePreviewHost>)
    const draft = ui.container.querySelector('textarea')!
    await clickElement(ui.container.querySelector('button')!)
    await act(async () => {})
    const pane = ui.container.querySelector('[data-testid="task-chat-file-preview"]')!
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true })) })
    expect(pane.textContent).toContain('original text')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })
    expect(pane.textContent).toBe('')
    expect(ui.container.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('unfinished task draft')
    expect(ui.container.querySelector('.task-chat-conversation')?.classList.contains('hidden')).toBe(false)
  })
  it('leaves an open child dialog in charge of Back before returning from the file', async () => {
    function WithPicker() {
      const [picker, setPicker] = useState(false)
      return <TaskChatFilePreviewHost mobile={false}>
        <Conversation mobile={false} />
        <button onClick={() => setPicker(true)}>Choose recipient</button>
        {picker && <Sheet ariaLabel="Recipients" onClose={() => setPicker(false)}>Recipients</Sheet>}
      </TaskChatFilePreviewHost>
    }
    await ui.render(<WithPicker />)
    await clickElement(ui.container.querySelector('button')!)
    await act(async () => {})
    await clickElement(Array.from(ui.container.querySelectorAll('button')).find(button => button.textContent === 'Choose recipient')!)
    const pane = ui.container.querySelector('[data-testid="task-chat-file-preview"]')!
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })
    expect(pane.textContent).toContain('original text')
    await act(async () => { window.dispatchEvent(new Event(NATIVE_BACK_EVENT)) })
    expect(pane.textContent).toContain('original text')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })
    expect(pane.textContent).toBe('')
  })
  it('keeps the existing mobile file sheet and its single close action', async () => {
    await ui.render(<TaskChatFilePreviewHost mobile><Conversation mobile /></TaskChatFilePreviewHost>)
    await clickElement(ui.container.querySelector('button')!)
    await act(async () => {})
    expect(ui.container.querySelector('[data-testid="task-chat-file-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="message-file-preview-sheet"]')?.textContent).toContain('original text')
    await clickElement(document.querySelector<HTMLButtonElement>('[data-testid="message-file-preview-sheet"] [data-slot="pane-header"] button')!)
    expect(document.querySelector('[data-testid="message-file-preview-sheet"]')).toBeNull()
  })
})
