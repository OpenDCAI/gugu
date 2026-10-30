// @vitest-environment node
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMobileShell, useMobileShell } from '@/hooks/useMobileShell'
import { platform } from '@/platform'

const kind = Object.getOwnPropertyDescriptor(platform, 'kind')!
const setKind = (value: 'web' | 'electron' | 'capacitor') => Object.defineProperty(platform, 'kind', { configurable: true, value })
function Probe() { return <output>{String(useMobileShell())}</output> }
afterEach(() => { vi.unstubAllGlobals(); Object.defineProperty(platform, 'kind', kind) })

describe('mobile shell detection across rendering environments', () => {
  it('renders the web shell without a browser global during server rendering', () => {
    setKind('web')
    vi.stubGlobal('window', undefined)
    expect(renderToStaticMarkup(<Probe />)).toBe('<output>false</output>')
  })
  it.each([[719, true], [720, false]] as const)('keeps browser width %s detection at %s', (width, expected) => {
    setKind('web')
    vi.stubGlobal('window', { innerWidth: width })
    expect(readMobileShell()).toBe(expected)
  })
  it.each([['capacitor', true], ['electron', false]] as const)('keeps %s native routing at %s without inspecting the viewport', (value, expected) => {
    setKind(value)
    vi.stubGlobal('window', undefined)
    expect(readMobileShell()).toBe(expected)
  })
  it('updates a mounted browser hook when its viewport crosses the breakpoint', async () => {
    setKind('web')
    const dom = new JSDOM('<!doctype html><div id="root"></div>')
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1024 })
    const container = dom.window.document.getElementById('root')!
    const root = createRoot(container)
    try {
      await act(async () => root.render(<Probe />))
      expect(container.textContent).toBe('false')
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 719 })
      await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
      expect(container.textContent).toBe('true')
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 720 })
      await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
      expect(container.textContent).toBe('false')
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
})
