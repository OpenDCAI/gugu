import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, type ComposerAttachment } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { notify } from '@/lib/notices'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@/lib/notices', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/notices')>(), notify: vi.fn() }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => { await page.viewport(390, 844); vi.mocked(notify).mockClear() })
afterEach(() => harness?.cleanup())
const file = (i: number): ComposerAttachment => ({ id: `a${i}`, name: `notes-${i}.txt`, kind: 'file',
  previewText: `preview-${i}`, meta: '113 B' })
const failed = (i: number): ComposerAttachment => ({ ...file(i), state: 'error',
  meta: "Didn't reach that machine. Keep the original file and retry when the machine reconnects.", retryable: true })

describe('real mobile composer attachment grid', () => {
  it.each(['mobile-prop', 'phone-shell'] as const)('fits 1/5/6/10 tiles in five columns via %s without horizontal scrolling', async route => {
    harness = createReactHarness()
    const changed = vi.fn(), viewed = vi.fn()
    for (const width of [320, 390]) {
      let singleRowTop = 0
      for (const count of [1, 5, 6, 10]) {
        await harness.render(<div data-phone-shell={route === 'phone-shell' ? '' : undefined} style={{ width }}>
          <SessionLocalizationProvider><ChatComposer mobile={route === 'mobile-prop'} attachments={Array.from({ length: count }, (_, i) => file(i))}
            onAttachmentsChange={changed} onViewAttachment={viewed} onSubmit={() => {}} /></SessionLocalizationProvider>
        </div>)
        await until('real grid mounts', () => harness.container.querySelectorAll('[data-slot="composer-attachment"]').length === count)
        const row = harness.container.querySelector<HTMLElement>('[data-slot="composer-attachments"]')!
        const chips = [...row.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')]
        const first = chips[0]!.getBoundingClientRect()
        expect(getComputedStyle(row).display).toBe('grid')
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
        expect(harness.container.scrollWidth).toBeLessThanOrEqual(harness.container.clientWidth)
        for (const [i, chip] of chips.entries()) {
          const box = chip.getBoundingClientRect()
          expect(box.width).toBeGreaterThan(40)
          expect(box.width).toBeLessThanOrEqual(56)
          expect(box.height).toBeCloseTo(box.width, 1)
          expect(box.top).toBeCloseTo(first.top + Math.floor(i / 5) * (first.height + 8), 1)
          expect(box.right).toBeLessThanOrEqual(row.getBoundingClientRect().right)
          expect(chip.getAttribute('aria-label')).toContain(`notes-${i}.txt`)
          const remove = chip.querySelector<HTMLButtonElement>('button[aria-label^="Remove"],button[aria-label^="移除"]')!
          const button = remove.getBoundingClientRect()
          expect(button.width).toBeGreaterThan(0)
          expect(button.right).toBeLessThanOrEqual(box.right + 1)
          expect(button.bottom).toBeLessThanOrEqual(box.bottom + 1)
        }
        const inputTop = harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!.getBoundingClientRect().top
        if (count === 1) singleRowTop = inputTop
        expect(inputTop).toBeCloseTo(singleRowTop + (count > 5 ? first.height + 8 : 0), 1)
        const last = chips.at(-1)!
        await act(async () => last.click())
        expect(viewed).toHaveBeenLastCalledWith(file(count - 1))
        await act(async () => last.querySelector<HTMLButtonElement>('button')!.click())
        expect(changed.mock.calls.at(-1)![0]).toHaveLength(count - 1)
        expect(viewed.mock.calls.at(-1)![0].id).toBe(`a${count - 1}`)
      }
    }
  })

  it('keeps full failure details/retry, cancellation, image thumbnails and quality controls usable', async () => {
    harness = createReactHarness()
    const retry = vi.fn(), changed = vi.fn(), quality = vi.fn(), viewed = vi.fn()
    const image: ComposerAttachment = { id: 'image', name: 'image.png', kind: 'image', state: 'uploading', cancelable: true,
      progress: 40, previewUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', imageQuality: 'compressed' }
    await harness.render(<SessionLocalizationProvider><ChatComposer mobile attachments={[failed(0), image]}
      onAttachmentsChange={changed} onRetryAttachment={retry} onAttachmentQualityChange={quality} onViewAttachment={viewed} onSubmit={() => {}} /></SessionLocalizationProvider>)
    const error = harness.container.querySelector<HTMLElement>('[data-slot="composer-attachment-error"]')!
    expect(error.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(error.textContent).toContain(failed(0).meta)
    await act(async () => error.querySelector('button')!.click())
    expect(retry).toHaveBeenCalledWith('a0')
    const tile = harness.container.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')[1]!
    const imageBox = tile.querySelector('img')!.getBoundingClientRect()
    expect(imageBox.width).toBeCloseTo(tile.getBoundingClientRect().width, 1)
    const buttons = [...tile.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.getBoundingClientRect().width > 0)
    expect(buttons).toHaveLength(2)
    await act(async () => buttons[0]!.click())
    expect(quality).toHaveBeenCalledWith('image')
    await act(async () => buttons[1]!.click())
    expect(changed.mock.calls.at(-1)![0]).toEqual([failed(0)])
    expect(viewed).not.toHaveBeenCalled()
  })

  it('preserves desktop wrapping and visible names', async () => {
    harness = createReactHarness()
    await harness.render(<div style={{ width: 390 }}><SessionLocalizationProvider><ChatComposer
      attachments={Array.from({ length: 11 }, (_, i) => failed(i))} onSubmit={() => {}} /></SessionLocalizationProvider></div>)
    const chips = [...harness.container.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')]
    expect(chips).toHaveLength(11)
    expect(chips.at(-1)!.getBoundingClientRect().top).toBeGreaterThan(chips[0]!.getBoundingClientRect().top)
    const name = [...chips[0]!.querySelectorAll('span')].find(el => el.textContent === 'notes-0.txt')!
    expect(name.getBoundingClientRect().width).toBeGreaterThan(0)
    expect(harness.container.querySelector<HTMLElement>('[data-slot="composer-attachment-error"]')!.getBoundingClientRect().height).toBe(0)
  })

  it('limits real ordinary-chat file picks before preview work and allows a replacement after removal', async () => {
    harness = createReactHarness()
    await renderWithAppProviders(harness, <LocalizationProvider><ChatMessageComposer chatId="grid-chat" onSend={vi.fn(async () => {})} /></LocalizationProvider>)
    await until('chat picker mounts', () => !!harness.container.querySelector('input[type="file"]'))
    const pick = async (count: number) => act(async () => {
      const input = harness.container.querySelector<HTMLInputElement>('input[type="file"]')!
      const data = new DataTransfer()
      for (let i = 0; i < count; i++) data.items.add(new File(['x'], `pick-${i}.txt`, { type: 'text/plain' }))
      input.files = data.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await pick(11)
    await until('only ten chips added', () => harness.container.querySelectorAll('[data-slot="composer-attachment"]').length === 10)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({ key: 'mobile-attachment-limit', presentation: 'compact' })
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!.click())
    await pick(2)
    await until('removed slot refilled', () => harness.container.querySelectorAll('[data-slot="composer-attachment"]').length === 10)
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
