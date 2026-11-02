// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUICK_CHAT_CHANNELS } from '../../../../apps/desktop/src/lib/quickChatIpc'
import { QuickChatHost } from '../../../../apps/desktop/src/components/assistant/QuickChatHost'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }))

let harness: ReturnType<typeof createReactHarness> | undefined
let frame: HTMLIFrameElement | undefined
afterEach(() => {
  harness?.cleanup()
  frame?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(shownDuringOpen: boolean) {
  harness = createReactHarness()
  frame = document.createElement('iframe')
  document.body.append(frame)
  const child = frame.contentWindow!
  vi.spyOn(child, 'close').mockImplementation(() => {})
  const listeners = new Map<string, (value: unknown) => void>()
  const emit = (value: boolean) => listeners.get(QUICK_CHAT_CHANNELS.visibility)?.(value)
  const invoke = vi.fn(async (channel: string) => {
    if (channel === QUICK_CHAT_CHANNELS.hide) emit(false)
    if (channel === QUICK_CHAT_CHANNELS.state) return { supported: true, enabled: true, registered: true, accelerator: 'Alt+Shift+Space' }
    return undefined
  })
  vi.stubGlobal('electronAPI', { invoke, eventOn: (channel: string, fn: (value: unknown) => void) => {
    listeners.set(channel, fn)
    return () => { listeners.delete(channel) }
  } })
  vi.spyOn(window, 'open').mockImplementation(() => {
    if (shownDuringOpen) emit(true)
    return child
  })
  await renderWithAppProviders(harness, createNode(QuickChatHost, {
    assistant: null, assistantState: 'none', chatId: null, chatFailed: null, retryChat: () => {},
  }))
  return { child, invoke, emit }
}

describe('Quick Chat empty-state native visibility', () => {
  it('receives an immediate show notification while the native child is being adopted', async () => {
    const { child } = await mount(true)
    expect(child.document.querySelector('[data-testid="quick-chat-none"]')).not.toBeNull()
    expect(child.document.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(false)
  })

  it('keeps the pre-created empty state inert until a native show notification', async () => {
    const { child, emit } = await mount(false)
    const root = child.document.querySelector('[data-testid="quick-chat"]')!
    expect(root.hasAttribute('inert')).toBe(true)
    await act(async () => emit(true))
    expect(root.hasAttribute('inert')).toBe(false)
    await act(async () => emit(false))
    expect(root.hasAttribute('inert')).toBe(true)
  })

  it('closes the no-assistant window through its real header button', async () => {
    const { child, invoke } = await mount(true)
    const close = child.document.querySelector<HTMLButtonElement>('[data-testid="quick-chat-close"]')!
    expect(close).not.toBeNull()
    expect(close.disabled).toBe(false)
    await clickElement(close)
    expect(invoke).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.hide)
    expect(child.document.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(true)
  })
})
