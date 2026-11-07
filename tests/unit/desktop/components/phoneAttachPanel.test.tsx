// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

// jsdom has no image decoder; only big.png compresses here. The real encoder has its own browser test.
const compressed = new File(['s'], 'big.jpg', { type: 'image/jpeg' })
vi.mock('@/components/chat/compressPhoto', () => ({ compressPhoto: async (file: File) => file.name === 'big.png' ? compressed : file }))

let harness: ReturnType<typeof createReactHarness>
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
beforeEach(() => {
  harness = createReactHarness()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }))
})
afterEach(() => { harness.cleanup(); Object.defineProperty(window, 'innerWidth', width); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
async function mount(onSendAttachments = vi.fn(async () => {})) {
  await renderWithAppProviders(harness, <ChatMessageComposer chatId="chat" onSend={vi.fn(async () => {})} onSendAttachments={onSendAttachments} />)
  return onSendAttachments
}
async function pick(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('phone "+" panel (owner 11-05: photos and files are two different things)', () => {
  it('offers Photos, Camera and File as separate entries, each opening its own picker', async () => {
    await mount()
    await clickElement(q('[data-testid="chat-composer-attach-menu"]')!)
    const panel = q('[data-testid="chat-composer-attach-panel"]')!
    expect([...panel.querySelectorAll('[data-testid^="chat-composer-attach-"]')].map((el) => el.getAttribute('data-testid')))
      .toEqual(['chat-composer-attach-photos', 'chat-composer-attach-camera', 'chat-composer-attach-file'])
    const opened: HTMLInputElement[] = []
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { opened.push(this) })
    for (const id of ['photos', 'camera', 'file']) {
      if (!q('[data-testid="chat-composer-attach-panel"]')) await clickElement(q('[data-testid="chat-composer-attach-menu"]')!)
      await clickElement(q(`[data-testid="chat-composer-attach-${id}"]`)!)
      expect(q('[data-testid="chat-composer-attach-panel"]'), 'picking closes the panel').toBeNull()
    }
    const [photos, camera, file] = opened
    // A single image type: with several, the Android shell falls back to the file picker.
    expect([photos.accept, photos.multiple, photos.getAttribute('capture')]).toEqual(['image/*', true, null])
    expect([camera.accept, camera.getAttribute('capture')]).toEqual(['image/*', 'environment'])
    expect([file.accept, file.multiple]).toEqual(['', true])
  })
  const tray = () => q('[data-chat-composer-host]')!.textContent
  const submit = async () => {
    await clickElement(q('[data-slot="composer-actions-end"] [data-slot="button"]')!)
    await act(async () => { await Promise.resolve() })
  }
  it('adds picked photos to the composer tray; only the composer send sends them, in one batch', async () => {
    const onSendAttachments = await mount()
    const a = new File(['a'], 'a.png', { type: 'image/png' }), b = new File(['b'], 'b.png', { type: 'image/png' })
    await pick(q<HTMLInputElement>('input[accept="image/*"][multiple]')!, [a, b])
    expect(document.querySelector('[role="dialog"]'), 'no page opens over the composer').toBeNull()
    expect(tray()).toContain('a.png')
    expect(tray()).toContain('b.png')
    expect(onSendAttachments).not.toHaveBeenCalled()
    await submit()
    expect(onSendAttachments).toHaveBeenCalledExactlyOnceWith([a, b], expect.anything())
  })
  it('takes a camera shot into the tray too', async () => {
    const onSendAttachments = await mount()
    await pick(q<HTMLInputElement>('input[capture="environment"]')!, [new File(['c'], 'c.png', { type: 'image/png' })])
    expect(tray()).toContain('c.png')
    expect(onSendAttachments).not.toHaveBeenCalled()
  })
  it('sends the compressed photo unless the chip is switched to the original', async () => {
    const onSendAttachments = await mount()
    const big = new File(['big'], 'big.png', { type: 'image/png' })
    await pick(q<HTMLInputElement>('input[accept="image/*"][multiple]')!, [big])
    await act(async () => { await Promise.resolve() })
    expect(tray()).toContain('big.jpg')
    await clickElement(q('[aria-label="发原图"]')!)
    expect(tray()).toContain('big.png')
    await clickElement(q('[aria-label="用压缩图"]')!)
    await clickElement(q('[aria-label="发原图"]')!)
    await submit()
    expect(onSendAttachments).toHaveBeenCalledExactlyOnceWith([big], expect.anything())
  })
  it('persists a compressed photo with its original, so the switch survives a chat switch', async () => {
    const setDraftAttachments = vi.fn()
    await renderWithAppProviders(harness, <ChatMessageComposer chatId="chat" onSend={vi.fn(async () => {})} onSendAttachments={vi.fn(async () => {})} />, { chat: { setDraftAttachments } })
    const big = new File(['big'], 'big.png', { type: 'image/png' })
    await pick(q<HTMLInputElement>('input[accept="image/*"][multiple]')!, [big])
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    expect(setDraftAttachments.mock.lastCall).toEqual(['chat', [expect.objectContaining({ file: compressed, photo: { original: big, compressed } })]])
  })
})
