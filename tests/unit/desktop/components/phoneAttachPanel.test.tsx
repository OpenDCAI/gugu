// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { NATIVE_BACK_EVENT } from '@/components/ui/sheetStack'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
beforeEach(() => {
  harness = createReactHarness()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }))
  // jsdom has no image decoder: this stands for a format the device cannot decode (the file goes as it is).
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('undecodable') }))
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
  it('sends picked photos from the preview page in one batch with the caption, compressed unless Original is on', async () => {
    const onSendAttachments = await mount()
    const photos = q<HTMLInputElement>('input[accept="image/*"][multiple]')!
    const a = new File(['a'], 'a.png', { type: 'image/png' }), b = new File(['b'], 'b.png', { type: 'image/png' })
    await pick(photos, [a, b])
    expect(q('[data-testid="chat-photo-preview"]')).not.toBeNull()
    expect(q('[data-testid="chat-photo-original"]')?.getAttribute('aria-checked'), 'Original is off by default').toBe('false')
    const caption = q<HTMLInputElement>('.gg-phone-photos-caption')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(caption, 'look')
      caption.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickElement(q('[data-testid="chat-photo-send"]')!)
    await act(async () => { await Promise.resolve() })
    expect(onSendAttachments).toHaveBeenCalledExactlyOnceWith([a, b], expect.objectContaining({ caption: 'look' }))
    expect(q('[data-testid="chat-photo-preview"]')).toBeNull()
  })
  it('drops one photo from the strip, and the back key cancels the whole pick', async () => {
    const onSendAttachments = await mount()
    const photos = q<HTMLInputElement>('input[accept="image/*"][multiple]')!
    await pick(photos, [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })])
    expect(q('[data-testid="chat-photo-send"]')?.textContent).toBe('发送(2)')
    await clickElement(document.querySelectorAll<HTMLElement>('.gg-phone-photos-remove')[0])
    expect(q('[data-testid="chat-photo-send"]')?.textContent).toBe('发送(1)')
    await act(async () => { window.dispatchEvent(new Event(NATIVE_BACK_EVENT)) })
    expect(q('[data-testid="chat-photo-preview"]')).toBeNull()
    expect(onSendAttachments).not.toHaveBeenCalled()
  })
})
