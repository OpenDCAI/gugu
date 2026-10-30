// @vitest-environment jsdom
// A project file kept on a machine that is off now: the viewer says so, from a fresh read of where the version is kept
// after the read failed — never a state the folder remembered from when it loaded, and never the generic "unavailable".
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { FilePreviewHost } from '../../../../apps/desktop/src/components/chat/filePreviewHost'

const { readBytes, metadata } = vi.hoisted(() => ({
  readBytes: vi.fn(async () => { throw new Error('File device is unavailable or its transfer timed out') }),
  metadata: vi.fn(),
}))
vi.mock('@/lib/guguLinks', () => ({ openLinkTarget: vi.fn() }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/lib/attachmentBytes', () => ({
  attachmentBytes: readBytes, sourceKeyOf: () => 'notes', attachmentPreview: vi.fn(), openAttachmentInSystemApp: vi.fn(),
}))
vi.mock('@/lib/fileAccess', () => ({ fileMetadata: metadata }))
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({
  MessageFilePreviewPanel: ({ error }: { error?: string }) => createElement('aside', null, error ?? ''),
}))

const { useMessageFilePreview } = await import('@/components/chat/useMessageFilePreview')

function Conversation() {
  const preview = useMessageFilePreview({ mobile: false, visible: true, closeRightSurfaces: () => undefined, toast: () => undefined, onForward: () => undefined })
  return createElement('div', null,
    createElement('button', { onClick: () => preview.open({ kind: 'file', fileName: 'notes.md', mimeType: 'text/markdown', sizeBytes: 28, source: { kind: 'item', itemId: 'notes', version: 2 } }) }, 'open'),
    preview.panel)
}
const kept = (online: boolean, label: string | null) => ({ status: 'ready', revision: { source: 'local', host_online: online, host_label: label } })

describe('a project file whose machine is off', () => {
  let harness: ReturnType<typeof createReactHarness>
  let pane: HTMLElement
  beforeEach(() => { harness = createReactHarness(); pane = document.createElement('section'); document.body.append(pane) })
  afterEach(() => { harness.cleanup(); pane.remove(); vi.clearAllMocks() })
  const open = async () => {
    await harness.render(createElement(FilePreviewHost.Provider, { value: { target: pane, onOpenChange: () => undefined } }, createElement(Conversation)))
    await act(async () => { harness.container.querySelector('button')!.click() })
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }

  it('names the machine that keeps that version, asked for that version after the read failed', async () => {
    metadata.mockResolvedValue(kept(false, 'Studio Mac'))
    await open()
    expect(metadata).toHaveBeenCalledWith('notes', 2)
    expect(pane.textContent).toBe('Studio Mac 离线，上线后才能打开这个文件。')
  })
  it('keeps the ordinary message when that machine is on, or the file is in the cloud', async () => {
    for (const answer of [kept(true, 'Studio Mac'), { status: 'ready', revision: { source: 'managed-object' } }]) {
      metadata.mockResolvedValue(answer)
      await open()
      expect(pane.textContent).toBe('文件暂时打不开')
      harness.cleanup(); harness = createReactHarness(); pane.replaceChildren()
    }
  })
})
