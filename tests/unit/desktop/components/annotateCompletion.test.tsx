// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { addShape, newDocument } from '../../../../apps/desktop/src/components/imageAnnotate/annotateModel'
import { useAnnotateActions } from '../../../../apps/desktop/src/components/imageAnnotate/useAnnotateActions'
import { AnnotateDoneMenu } from '../../../../apps/desktop/src/components/imageAnnotate/AnnotateDoneMenu'
import zh from '../../../../apps/desktop/src/i18n/locales/zh-CN/main'
import type { ImageViewerItem } from '../../../../apps/desktop/src/lib/imageViewer'

const calls = vi.hoisted(() => ({ compose: vi.fn(), draft: vi.fn(), session: vi.fn(), done: vi.fn(), output: vi.fn(), t: vi.fn() }))
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: calls.t }) }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: calls.session }))
vi.mock('@/session/shared/extensions/app-send-core', () => ({ composeInChat: calls.compose }))
vi.mock('@/lib/composeDraft', () => ({ composeChatDraft: calls.draft }))
vi.mock('@/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }))
vi.mock('@/lib/imageClipboard', () => ({ writeImageBlobToClipboard: vi.fn() }))

let harness: ReturnType<typeof createReactHarness>, actions: ReturnType<typeof useAnnotateActions>
const item: ImageViewerItem = { url: 'blob:original', alt: 'image.png', source: { chatId: 'group', messageId: 'original' } }
const doc = addShape(newDocument(1200, 800), { id: 'one', kind: 'marker', at: { x: 100, y: 100 }, radius: 12, color: 'danger', lineWidth: 3, note: 'Check this' })
function Probe({ image = item, mobile = false }: { image?: ImageViewerItem; mobile?: boolean }) {
  actions = useAnnotateActions(image, doc, calls.output, calls.done)
  return <AnnotateDoneMenu actions={actions} mobile={mobile} />
}
beforeEach(() => {
  vi.clearAllMocks()
  calls.t.mockImplementation((key: keyof typeof zh.imageAnnotate) => zh.imageAnnotate[key] ?? key)
  calls.session.mockReturnValue({ access_token: 'test-token', user: { id: 'me' } })
  calls.compose.mockResolvedValue({ chatId: 'group', text: '① Check this', images: [] })
  calls.output.mockResolvedValue(Object.assign(new Blob(['png'], { type: 'image/png' }), { arrayBuffer: async () => new ArrayBuffer(3) }))
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup() })

describe('annotation completion', () => {
  it.each([false, true])('puts the edited PNG and numbered notes in the existing composer on Done (mobile=%s)', async mobile => {
    await harness.render(createNode(Probe, { mobile }))
    expect(harness.container.querySelector('input,textarea')).toBeNull()
    await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === '完成')!)
    expect(calls.compose).toHaveBeenCalledWith(expect.anything(), {
      chat: 'group', text: '① Check this', images: [{ name: 'image-annotated.png', type: 'image/png', bytes: expect.any(ArrayBuffer) }],
    })
    await expect(calls.compose.mock.calls[0][0].account()).resolves.toEqual({ token: 'test-token', userId: 'me' })
    expect(calls.draft).toHaveBeenCalledWith(await calls.compose.mock.results[0].value)
    expect(calls.done).toHaveBeenCalledOnce()
  })
  it('keeps the editor open when PNG export or composer preparation fails', async () => {
    await harness.render(createNode(Probe))
    calls.output.mockRejectedValueOnce(new Error('PNG export failed'))
    await act(async () => { await actions.putInComposer() })
    expect(actions.error).toBe('PNG export failed')
    expect(calls.compose).not.toHaveBeenCalled()
    calls.compose.mockRejectedValueOnce(new Error('membership refused'))
    await act(async () => { await actions.putInComposer() })
    expect(actions.error).toBe('membership refused')
    expect(calls.draft).not.toHaveBeenCalled()
    expect(calls.done).not.toHaveBeenCalled()
  })
  it.each([false, true])('keeps source-free images export-only without inventing a chat (mobile=%s)', async mobile => {
    await harness.render(createNode(Probe, { image: { url: 'blob:local', alt: 'local.png' }, mobile }))
    await clickElement(harness.container.querySelector('button')!)
    expect(document.body.textContent).toContain('复制图片')
    expect(document.body.textContent).toContain('保存到本机')
    expect(document.body.textContent).not.toContain('存进群文件夹')
    expect(calls.output).not.toHaveBeenCalled()
    expect(calls.compose).not.toHaveBeenCalled()
    expect(calls.done).not.toHaveBeenCalled()
  })
  it('does not complete or post from the removed Ctrl+Enter shortcut', async () => {
    await harness.render(createNode(Probe))
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(calls.output).not.toHaveBeenCalled()
    expect(calls.compose).not.toHaveBeenCalled()
    expect(calls.done).not.toHaveBeenCalled()
  })
})
