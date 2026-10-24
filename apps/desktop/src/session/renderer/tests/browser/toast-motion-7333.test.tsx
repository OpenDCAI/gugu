import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdp, userEvent } from 'vitest/browser'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ToastProvider } from '@/components/Toast'
import { useToast, type ToastType } from '@/components/toastContext'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { dismissNotice, notify } from '@/lib/notices'
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
const toast = (kind: ToastType) => document.querySelector<HTMLElement>(`[data-sonner-toast][data-type="${kind}"]`)
const dismissOf = (element: HTMLElement) => element.querySelector<HTMLButtonElement>('[data-close-button]')
const click = (element: Element) => act(async () => { await userEvent.click(element) })
const trigger = (kind: ToastType) => click([...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === kind)!)
const toastTransition = (kind: ToastType) => Number.parseFloat(getComputedStyle(toast(kind)!).transitionDuration)

describe('notice appearance and reduced motion (#7333, #137)', () => {
  it('all four real toast tiers use 14/20 and surface corners, preserving dismissal and click-through', async () => {
    await emulate('reduce')
    await mount()
    for (const kind of ['success', 'info', 'warning', 'error'] as const) {
      await trigger(kind)
      await until(`the ${kind} toast appears`, () => toast(kind) !== null)
      const element = toast(kind)!
      const style = getComputedStyle(element)
      expect({ size: Number.parseFloat(style.fontSize), leading: Math.round(Number.parseFloat(style.lineHeight)), radius: style.borderRadius }).toEqual({ size: 14, leading: 20, radius: '12px' })
      const readable = kind === 'error' || kind === 'warning'
      expect(style.pointerEvents).toBe(readable ? 'auto' : 'none')
      const dismiss = dismissOf(element)
      expect(Boolean(dismiss)).toBe(readable)
      if (dismiss) {
        await click(dismiss)
        await until('the dismissed toast leaves', () => toast(kind) === null)
      }
    }
  })

  it('the product tokens win over sonner\'s own light/dark colors, whatever order the stylesheets load in', async () => {
    await mount()
    await click([...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'error')!)
    await until('the error toast appears', () => toast('error') !== null)
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.background = 'var(--surface-white)'
    const surface = getComputedStyle(probe).backgroundColor
    probe.remove()
    const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]')!
    for (const theme of ['light', 'dark']) {
      toaster.setAttribute('data-sonner-theme', theme)
      expect(getComputedStyle(toast('error')!).backgroundColor, theme).toBe(surface)
    }
  })

  it('the same key updates one notice in place instead of stacking, and the waiting look is the product loading indicator', async () => {
    await mount()
    await act(async () => { notify({ key: 'machine:d1', title: 'Reconnecting Mac 1', tier: 'info', ongoing: true, waiting: true }) })
    await until('the waiting notice appears', () => document.querySelectorAll('[data-sonner-toast]').length === 1)
    const waiting = document.querySelector<HTMLElement>('[data-sonner-toast]')!
    expect(waiting.textContent).toContain('Reconnecting Mac 1')
    expect(dismissOf(waiting), 'an ongoing notice can always be closed').not.toBeNull()
    await act(async () => { notify({ key: 'machine:d1', title: 'Mac 1 is offline', tier: 'info', ongoing: true }) })
    await until('the same notice now reads offline', () => document.querySelector('[data-sonner-toast]')?.textContent?.includes('Mac 1 is offline') === true)
    expect(document.querySelectorAll('[data-sonner-toast]')).toHaveLength(1)
    await act(async () => { dismissNotice('machine:d1') })
    await until('the keyed notice is dismissed', () => document.querySelector('[data-sonner-toast]') === null)
  })

  it('a reused key carries nothing over from its earlier life: a click-through success never makes the next ongoing notice unclosable', async () => {
    await mount()
    await act(async () => { notify({ key: 'machine:d1', title: 'Connected', tier: 'success' }) })
    await until('the success notice appears', () => toast('success') !== null)
    expect(getComputedStyle(toast('success')!).pointerEvents).toBe('none')
    await act(async () => { dismissNotice('machine:d1') })
    await until('the success notice leaves', () => document.querySelector('[data-sonner-toast]') === null)
    await act(async () => { notify({ key: 'machine:d1', title: 'Mac 1 is offline', tier: 'error', ongoing: true, onDismiss: () => {} }) })
    await until('the ongoing notice appears', () => toast('error') !== null)
    const ongoing = toast('error')!
    expect(getComputedStyle(ongoing).pointerEvents).toBe('auto')
    expect(dismissOf(ongoing)).not.toBeNull()
    await click(dismissOf(ongoing)!)
    await until('the user closes it', () => toast('error') === null)
  })

  it('a media change after mount reaches subscribers without an app interaction, and toasts stop animating', async () => {
    await emulate('no-preference')
    await mount()
    expect(harness.container.querySelector('output')!.textContent).toBe('animated')
    await trigger('error')
    await until('the error toast appears', () => toast('error') !== null)
    expect(toastTransition('error')).toBeGreaterThan(0)
    await emulate('reduce')
    await until('the existing subscriber updates', () => harness.container.querySelector('output')!.textContent === 'reduced')
    expect(toastTransition('error')).toBe(0)
  })
})
