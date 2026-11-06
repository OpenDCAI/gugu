import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, type ComposerAttachment } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())
const failed = (i: number): ComposerAttachment => ({ id: `a${i}`, name: `IMG_2026110${i}.jpg`, kind: 'image', state: 'error',
  meta: "Didn't reach that machine. Keep the original file and retry when the machine reconnects.", retryable: true })

describe('real mobile composer attachment row', () => {
  it.each(['mobile-prop', 'phone-shell'] as const)('keeps one, five and ten files at the same height via %s, with scrollable controls', async route => {
    harness = createReactHarness()
    const changed = vi.fn(), retry = vi.fn()
    const render = async (count: number) => {
      await harness.render(<div data-phone-shell={route === 'phone-shell' ? '' : undefined} style={{ width: 390 }}>
        <SessionLocalizationProvider><ChatComposer mobile={route === 'mobile-prop'} attachments={Array.from({ length: count }, (_, i) => failed(i))}
          onAttachmentsChange={changed} onRetryAttachment={retry} onSubmit={() => {}} /></SessionLocalizationProvider>
      </div>)
      await until('real attachment strip mounts', () => harness.container.querySelectorAll('[data-slot="composer-attachment"]').length === count)
    }
    await render(1)
    const input = () => harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
    const top = input().getBoundingClientRect().top
    const height = harness.container.getBoundingClientRect().height
    for (const count of [5, 10]) {
      await render(count)
      const row = harness.container.querySelector<HTMLElement>('[data-slot="composer-attachments"]')!
      expect(input().getBoundingClientRect().top).toBeCloseTo(top, 1)
      expect(harness.container.getBoundingClientRect().height).toBeCloseTo(height, 1)
      expect(row.scrollWidth).toBeGreaterThan(row.clientWidth)
      expect(harness.container.scrollWidth).toBeLessThanOrEqual(harness.container.clientWidth)
      const chips = [...row.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')]
      for (const chip of chips) {
        expect(chip.getBoundingClientRect().top).toBeCloseTo(chips[0]!.getBoundingClientRect().top, 1)
        expect(chip.getBoundingClientRect().height).toBeCloseTo(chips[0]!.getBoundingClientRect().height, 1)
        expect(chip.scrollHeight).toBeLessThanOrEqual(chip.clientHeight + 1)
        for (const control of chip.querySelectorAll('button')) {
          const box = control.getBoundingClientRect(), parent = chip.getBoundingClientRect()
          expect(box.width).toBeGreaterThan(0)
          expect(box.right).toBeLessThanOrEqual(parent.right + 1)
        }
      }
      const last = chips.at(-1)!
      row.scrollLeft = row.scrollWidth
      expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1)
      await act(async () => { last.querySelector<HTMLButtonElement>('button')!.click() })
      expect(retry).toHaveBeenLastCalledWith(`a${count - 1}`)
      await act(async () => { last.querySelectorAll<HTMLButtonElement>('button')[1]!.click() })
      expect(changed.mock.calls.at(-1)![0]).toHaveLength(count - 1)
    }
  })

  it('preserves desktop wrapping', async () => {
    harness = createReactHarness()
    await harness.render(<div style={{ width: 390 }}><SessionLocalizationProvider><ChatComposer
      attachments={Array.from({ length: 5 }, (_, i) => failed(i))} onSubmit={() => {}} /></SessionLocalizationProvider></div>)
    await until('desktop attachments mount', () => harness.container.querySelectorAll('[data-slot="composer-attachment"]').length === 5)
    const chips = [...harness.container.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')]
    expect(chips.at(-1)!.getBoundingClientRect().top).toBeGreaterThan(chips[0]!.getBoundingClientRect().top)
  })
})
