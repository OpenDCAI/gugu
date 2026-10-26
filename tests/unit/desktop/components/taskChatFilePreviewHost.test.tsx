// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createReactHarness, clickElement } from '../../../support/testHarness'
import { TaskChatFilePreviewHost } from '../../../../apps/desktop/src/components/assistant/TaskChatFilePreviewHost'
import { useMessageFilePreview } from '../../../../apps/desktop/src/components/chat/useMessageFilePreview'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/lib/attachmentBytes', () => ({
  attachmentBytes: async () => ({ status: 'ready', blob: new Blob(['original text']) }),
  sourceKeyOf: () => 'session-file', attachmentPreview: vi.fn(), openAttachmentInSystemApp: vi.fn(),
}))
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({
  MessageFilePreviewPanel: ({ content, onClose, fill }: { content: string | null; onClose: () => void; fill?: boolean }) =>
    <aside data-fill={fill}>{content}<button onClick={onClose}>Close preview</button></aside>,
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
    expect(pane.querySelector('aside')?.getAttribute('data-fill')).toBe('true')
    expect(ui.container.querySelector('.task-chat-conversation')?.classList.contains('hidden')).toBe(true)
    expect(ui.container.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('unfinished task draft')
    await clickElement(pane.querySelector('button')!)
    expect(pane.textContent).toBe('')
    expect(pane.classList.contains('hidden')).toBe(true)
    expect(ui.container.querySelector('.task-chat-conversation')?.classList.contains('hidden')).toBe(false)
    expect(ui.container.querySelector('textarea')).toBe(draft)
  })
  it('keeps the existing mobile file sheet and its single close action', async () => {
    await ui.render(<TaskChatFilePreviewHost mobile><Conversation mobile /></TaskChatFilePreviewHost>)
    await clickElement(ui.container.querySelector('button')!)
    await act(async () => {})
    expect(ui.container.querySelector('[data-testid="task-chat-file-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="message-file-preview-sheet"]')?.textContent).toContain('original text')
    await clickElement(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Close preview')!)
    expect(document.querySelector('[data-testid="message-file-preview-sheet"]')).toBeNull()
  })
})
