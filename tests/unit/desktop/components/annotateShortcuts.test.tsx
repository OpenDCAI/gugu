// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'
import { ImagePreviewProvider } from '../../../../apps/desktop/src/components/ImagePreviewProvider'
import { openImageViewer } from '../../../../apps/desktop/src/lib/imageViewer'
import * as platformMock from '../../../support/capacitorPlatformTestDouble'
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder'
import { commandRegistry } from '@renderer/lib/commands/registry'

const mocks = vi.hoisted(() => ({ image: vi.fn(), keyboard: {} as Record<string, string> }))
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: mocks.keyboard }) }))
vi.mock('@tanstack/react-hotkeys', async original => ({ ...await original<typeof import('@tanstack/react-hotkeys')>(), detectPlatform: () => 'linux' }))
vi.mock('@/components/imageAnnotate/annotateRender', async original => ({ ...await original<typeof import('@/components/imageAnnotate/annotateRender')>(), loadAnnotationImage: mocks.image }))
vi.mock('@/components/imageAnnotate/annotateSource', () => ({ annotationItem: async (item: unknown) => item }))
vi.mock('@/components/imageAnnotate/useAnnotateActions', () => ({ useAnnotateActions: vi.fn() }))
vi.mock('@/platform', () => import('../../../support/capacitorPlatformTestDouble'))

let harness: ReturnType<typeof createReactHarness>, remove: () => void
const open = vi.fn()
const item = { url: 'blob:image', alt: 'image.png' }
const bindings: Record<string, string>[] = [{}, { 'app.quickSwitcher': 'Mod+K' }]
async function mount() {
  await renderWithAppProviders(harness, createNode(ImagePreviewProvider, null,
    createNode(CommandShortcutBinder), createNode('button', { 'data-page': true }, 'Underlying page')))
}
async function edit() {
  await act(async () => openImageViewer([item], 0))
  await waitForCondition(() => document.querySelector('[data-testid="image-preview-edit"]') !== null, 'viewer did not open')
  await clickElement(document.querySelector<HTMLElement>('[data-testid="image-preview-edit"]')!)
  await waitForCondition(() => document.querySelector('.ia-editor') !== null, 'editor did not open')
  document.querySelector<HTMLButtonElement>('.ia-editor button')!.focus()
}
async function cancel() {
  await clickElement(document.querySelector<HTMLElement>('.ia-editor button')!)
  await waitForCondition(() => document.querySelector('.ia-editor') === null, 'editor did not close')
}
async function press(key: string) {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })) })
}
beforeEach(async () => {
  await import('photoswipe')
  await import('../../../../apps/desktop/src/components/imageAnnotate/AnnotateEditor')
  open.mockClear(); mocks.keyboard = {}
  platformMock.platform.kind = 'desktop'
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
  commandRegistry.setShortcutsPaused(false)
  remove = commandRegistry.register({ scopeId: 'app', getCommands: () => [
    { id: 'app.quickSwitcher', execute: open }, { id: 'app.commandPalette', execute: open },
  ] })
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); remove(); commandRegistry.setShortcutsPaused(false); commandRegistry.setContext(document.body); vi.unstubAllGlobals() })

describe('annotation global shortcut ownership', () => {
  it.each(bindings)('blocks capture-phase commands during image loading and errors, then restores them (%j)', async keyboard => {
    mocks.keyboard = keyboard
    const pending = deferred<HTMLImageElement>()
    mocks.image.mockReturnValue(pending.promise)
    await mount()
    harness.container.querySelector('button')!.focus()
    const quickKey = keyboard['app.quickSwitcher'] ? 'k' : 'o'
    await press(quickKey); expect(open).toHaveBeenCalledOnce()
    await edit()
    await press(quickKey); await press('p')
    expect(open).toHaveBeenCalledOnce()
    await act(async () => pending.reject(new Error('Image unavailable')))
    expect(document.querySelector('.ia-editor [role="alert"]')?.textContent).toContain('Image unavailable')
    await press(quickKey); await press('p')
    expect(open).toHaveBeenCalledOnce()
    await cancel()
    expect(commandRegistry.shortcutsPaused).toBe(false)
    await clickElement(document.querySelector<HTMLElement>('[data-testid="image-preview-close"]')!)
    harness.container.querySelector('button')!.focus()
    await press(quickKey); await press('p')
    expect(open).toHaveBeenCalledTimes(3)
  })
  it('preserves a pause that was already active before editing', async () => {
    mocks.image.mockReturnValue(new Promise(() => {}))
    commandRegistry.setShortcutsPaused(true)
    await mount(); await edit(); await cancel()
    expect(commandRegistry.shortcutsPaused).toBe(true)
  })
})
