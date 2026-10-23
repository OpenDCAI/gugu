// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { FilePreviewHost } from '../../../../apps/desktop/src/components/chat/filePreviewHost'

const { openGroupFile, readBytes } = vi.hoisted(() => ({
  openGroupFile: vi.fn(async () => true),
  readBytes: vi.fn(async () => ({ status: 'ready', blob: { text: async () => '# 预算\n余量260元', arrayBuffer: async () => new ArrayBuffer(0) } })),
}))
vi.mock('@/components/markdown/fileLinks', () => ({ openGroupFile }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/lib/attachmentBytes', () => ({
  attachmentBytes: readBytes, sourceKeyOf: () => 'budget', attachmentResolver: { resolve: vi.fn(), forget: vi.fn() }, openAttachmentInSystemApp: vi.fn(),
}))
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({
  MessageFilePreviewPanel: ({ content, onClose, fill }: { content: string | null; onClose: () => void; fill: boolean }) =>
    createElement('aside', { 'data-fill': String(fill) }, content ?? '', createElement('button', { onClick: onClose }, '关闭预览')),
}))

const { useMessageFilePreview } = await import('@/components/chat/useMessageFilePreview')

function Conversation({ restore }: { restore?: () => void } = {}) {
  const preview = useMessageFilePreview({ mobile: false, visible: true, closeRightSurfaces: () => undefined, toast: () => undefined, downloadFailed: 'failed', onForward: () => undefined })
  return createElement('div', null,
    createElement('button', { onClick: () => preview.open({ kind: 'file', fileName: 'budget.md', mimeType: 'text/markdown', sizeBytes: 28, source: { kind: 'item', itemId: 'budget', version: 1 } }, undefined, restore) }, '打开附件'),
    preview.panel)
}

describe('personal assistant file preview', () => {
  let harness: ReturnType<typeof createReactHarness>
  let target: HTMLElement | undefined
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => { harness.cleanup(); target?.remove(); target = undefined; vi.clearAllMocks() })

  it('shows the actual Markdown in the dedicated right pane, with no Folder App', async () => {
    const pane = document.createElement('section'); document.body.append(pane); target = pane
    const onOpenChange = vi.fn()
    await harness.render(createElement(FilePreviewHost.Provider, { value: { target: pane, onOpenChange } }, createElement(Conversation)))
    await act(async () => { harness.container.querySelector('button')!.click() })
    expect(openGroupFile).not.toHaveBeenCalled()
    expect(readBytes).toHaveBeenCalledTimes(1)
    expect(pane.textContent).toContain('余量260元')
    expect(pane.querySelector('aside')?.getAttribute('data-fill')).toBe('true')
    expect(harness.container.querySelector('aside')).toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await act(async () => { pane.querySelector('button')!.click() })
    expect(pane.textContent).toBe('')
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('waits for the right-pane slot instead of inserting another column into the chat', async () => {
    const onOpenChange = vi.fn()
    await harness.render(createElement(FilePreviewHost.Provider, { value: { target: null, onOpenChange } }, createElement(Conversation)))
    await act(async () => { harness.container.querySelector('button')!.click() })
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(harness.container.querySelector('aside')).toBeNull()
    expect(openGroupFile).not.toHaveBeenCalled()
  })

  it('keeps the existing App opener and message return for ordinary chat attachments', async () => {
    const restore = vi.fn()
    await harness.render(createElement(Conversation, { restore }))
    await act(async () => { harness.container.querySelector('button')!.click() })
    expect(openGroupFile).toHaveBeenCalledWith('budget', undefined, undefined, restore)
    expect(readBytes).not.toHaveBeenCalled()
  })
})
