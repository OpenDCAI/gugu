// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { resolveWindowMaterial, WINDOW_MATERIAL_CHANGED_CHANNEL, WINDOW_MATERIAL_GET_CHANNEL, type WindowMaterial } from '../../../../apps/desktop/shared/window-material'
import { installWindowMaterialAttribute } from '../../../../apps/desktop/src/lib/windowMaterial'
import { installWindowMaterial, type WindowMaterialWindow } from '../../../../apps/desktop/electron/window-material'

describe('window material decision (#7333)', () => {
  const mac = { platform: 'darwin' as const, prefersReducedTransparency: false, highContrast: false }

  it('lets the native material show only on mac with no accessibility override', () => {
    expect(resolveWindowMaterial(mac)).toBe('native')
  })

  it('falls to opaque when the user asked the system to reduce transparency or increase contrast', () => {
    expect(resolveWindowMaterial({ ...mac, prefersReducedTransparency: true })).toBe('opaque')
    expect(resolveWindowMaterial({ ...mac, highContrast: true })).toBe('opaque')
  })

  it('never claims a material on hosts that have none', () => {
    expect(resolveWindowMaterial({ ...mac, platform: 'win32' })).toBe('opaque')
    expect(resolveWindowMaterial({ ...mac, platform: 'linux' })).toBe('opaque')
  })
})

/** nativeTheme / ipcMain / the vibrant window, faked: the negative cases are simulated here, never by a switch in the product. */
function rig(initial: { reduce?: boolean; contrast?: boolean } = {}) {
  const theme = { prefersReducedTransparency: !!initial.reduce, shouldUseHighContrastColors: !!initial.contrast, updated: [] as (() => void)[] }
  const handlers = new Map<string, (event: { sender: unknown }) => unknown>()
  const sent: [string, unknown][] = []
  const vibrant: WindowMaterialWindow = { isDestroyed: () => false, webContents: { send: (channel, value) => { sent.push([channel, value]) } } }
  const other = { send: vi.fn() }
  const host = installWindowMaterial({
    platform: 'darwin',
    nativeTheme: {
      get prefersReducedTransparency() { return theme.prefersReducedTransparency },
      get shouldUseHighContrastColors() { return theme.shouldUseHighContrastColors },
      on: (_event, listener) => theme.updated.push(listener),
    },
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    materialWindow: () => vibrant,
  })
  const ask = (sender: unknown): unknown => {
    return handlers.get(WINDOW_MATERIAL_GET_CHANNEL)!({ sender })
  }
  const systemChanged = (next: { reduce?: boolean; contrast?: boolean }) => {
    theme.prefersReducedTransparency = !!next.reduce
    theme.shouldUseHighContrastColors = !!next.contrast
    for (const listener of theme.updated) listener()
  }
  return { host, ask, sent, vibrant, other, systemChanged }
}

describe('window material wiring in the main process (#7333)', () => {
  it('answers native only to the window that actually carries the vibrancy', () => {
    const { ask, vibrant, other } = rig()
    expect(ask(vibrant.webContents)).toBe('native')
    expect(ask(other)).toBe('opaque')
  })

  it('starts opaque when the system already reduces transparency', () => {
    const { host, ask, vibrant } = rig({ reduce: true })
    expect(host.current()).toBe('opaque')
    expect(ask(vibrant.webContents)).toBe('opaque')
  })

  it('pushes a change to the vibrant window and the listeners, and stays quiet when nothing changed', () => {
    const { host, sent, systemChanged, other } = rig()
    const seen: WindowMaterial[] = []
    host.onChange((material) => seen.push(material))
    systemChanged({}) // e.g. a light/dark switch: nativeTheme says updated, the material did not change
    expect(sent).toEqual([])
    systemChanged({ contrast: true })
    expect(sent).toEqual([[WINDOW_MATERIAL_CHANGED_CHANNEL, 'opaque']])
    expect(seen).toEqual(['opaque'])
    systemChanged({})
    expect(seen).toEqual(['opaque', 'native'])
    expect(other.send).not.toHaveBeenCalled()
  })
})

describe('window material attribute (#7333)', () => {
  it('writes the main-process decision and follows its changes', async () => {
    const root = document.createElement('html')
    let push: ((material: WindowMaterial) => void) | null = null
    const dispose = await installWindowMaterialAttribute(root, {
      getMaterial: async () => 'native',
      onMaterialChange: (callback) => {
        push = callback
        return () => {
          push = null
        }
      },
    })
    expect(root.dataset.windowMaterial).toBe('native')
    push!('opaque')
    expect(root.dataset.windowMaterial).toBe('opaque')
    dispose()
    expect(push).toBeNull()
  })

  it('leaves the attribute absent (= opaque) where there is no main process', async () => {
    const root = document.createElement('html')
    await installWindowMaterialAttribute(root, undefined)
    expect(root.dataset.windowMaterial).toBeUndefined()
  })
})
