// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthBrandMotion } from '../../../../apps/desktop/src/pages/login/AuthBrandMotion'

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme') })
it('creates a prepared animation document and replaces its frame on theme changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let deliver!: (visible: boolean) => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      deliver = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    observe() {} disconnect() {}
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(<AuthBrandMotion />) })
    expect(host.querySelector('iframe')).toBeNull()
    const motion = host.firstElementChild as HTMLElement
    motion.style.color = 'rgb(255, 255, 255)'
    await act(async () => { deliver(true) })
    const first = host.querySelector('iframe')!
    expect(first.getAttribute('sandbox')).toBe('allow-scripts')
    expect(first.srcdoc).toContain('<canvas id="sky"')
    expect(first.srcdoc).toContain('<script>')
    expect(first.srcdoc).not.toContain('__MOTION_RGB__')
    motion.style.color = 'rgb(24, 24, 24)'
    await act(async () => { document.documentElement.setAttribute('data-theme', 'dark') })
    const themed = host.querySelector('iframe')!
    expect(themed).not.toBe(first)
    expect(themed.srcdoc).toContain("'24,24,24'")
    await act(async () => { deliver(false) })
    expect(host.querySelector('iframe')).toBeNull()
  } finally { await act(async () => { root.unmount() }); host.remove() }
})
