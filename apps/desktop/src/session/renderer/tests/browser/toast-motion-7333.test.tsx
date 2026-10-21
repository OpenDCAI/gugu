import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdp, userEvent } from 'vitest/browser'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ToastProvider } from '@/components/Toast'
import { useToast, type ToastType } from '@/components/toastContext'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))

type Cdp = { send: (method: string, params: object) => Promise<unknown> }
const query = '(prefers-reduced-motion: reduce)'
async function emulate(value: 'reduce' | 'no-preference' | null) {
  await act(async () => {
    await (cdp() as unknown as Cdp).send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value }] : [] })
  })
  if (value) await until('the media preference changed', () => matchMedia(query).matches === (value === 'reduce'))
}
function Controls() {
  const { toast } = useToast()
  const reduced = usePrefersReducedMotion()
  return <><output>{reduced ? 'reduced' : 'animated'}</output>{(['success', 'info', 'warning', 'error'] as const).map((kind) => <button key={kind} onClick={() => toast(`toast:${kind}`, kind)}>{kind}</button>)}</>
}
let harness: ReturnType<typeof createReactHarness>
afterEach(async () => {
  harness?.cleanup()
  await emulate(null)
})
async function mount() {
  harness = createReactHarness()
  await renderWithAppProviders(harness, <ToastProvider><Controls /></ToastProvider>)
}
const toast = (kind: ToastType) => document.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.toastItem}"][data-toast-type="${kind}"]`)
const trigger = (kind: ToastType) => userEvent.click([...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === kind)!)
function appearance(element: HTMLElement) {
  const style = getComputedStyle(element)
  return { opacity: Number(style.opacity), x: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m41 }
}
async function sampleToast() {
  const frames: Array<{ opacity: number; x: number }> = []
  let frame = 0
  let running = true
  const sample = () => {
    const element = toast('error')
    if (element) frames.push(appearance(element))
    if (running) frame = requestAnimationFrame(sample)
  }
  frame = requestAnimationFrame(sample)
  try {
    await trigger('error')
    await until('the toast reaches its visible resting position', () => {
      const element = toast('error')
      if (!element) return false
      const state = appearance(element)
      return state.opacity === 1 && Math.abs(state.x) < 0.01
    })
    frames.push(appearance(toast('error')!))
    return frames
  } finally {
    running = false
    cancelAnimationFrame(frame)
  }
}

describe('toast appearance and JS reduced motion (#7333)', () => {
  it('all four real toast tiers use 14/20 and surface corners, preserving selection, dismissal and click-through', async () => {
    await emulate('reduce')
    await mount()
    for (const kind of ['success', 'info', 'warning', 'error'] as const) {
      await trigger(kind)
      const element = toast(kind)!
      expect(element).not.toBeNull()
      const style = getComputedStyle(element)
      expect({ size: Number.parseFloat(style.fontSize), leading: Math.round(Number.parseFloat(style.lineHeight)), radius: style.borderRadius }).toEqual({ size: 14, leading: 20, radius: '12px' })
      const readable = kind === 'error' || kind === 'warning'
      expect(style.pointerEvents).toBe(readable ? 'auto' : 'none')
      expect(style.userSelect).toBe(readable ? 'text' : 'none')
      const dismiss = element.querySelector<HTMLButtonElement>(`[data-testid="${AUTOMATION_TEST_IDS.toastDismiss}"]`)
      expect(Boolean(dismiss)).toBe(readable)
      if (dismiss) {
        await userEvent.click(dismiss)
        await until('the dismissed toast leaves', () => toast(kind) === null)
      }
    }
  })

  it('a media change after mount reaches subscribers without an app interaction, then a toast appears with no displaced or faded frames', async () => {
    await emulate('no-preference')
    await mount()
    expect(harness.container.querySelector('output')!.textContent).toBe('animated')
    await emulate('reduce')
    await until('the existing subscriber updates', () => harness.container.querySelector('output')!.textContent === 'reduced')
    const frames = await sampleToast()
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.filter((state) => state.opacity !== 1 || Math.abs(state.x) > 0.01)).toHaveLength(0)
  })

  it('the same frame sampler sees normal entrance motion when reduction is off', async () => {
    await emulate('no-preference')
    await mount()
    const frames = await sampleToast()
    expect(frames.some((state) => state.opacity < 1 || Math.abs(state.x) > 0.01)).toBe(true)
  })
})
