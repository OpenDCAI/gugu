// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CommandPaletteModal } from './command-palette-modal'
import { resetSearchSession, useSearchSession } from '../global-search/search-session'

const calls = vi.hoisted(() => ({ dispatch: vi.fn(), titles: vi.fn().mockResolvedValue([]) }))
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { activeCommands: [], dispatch: calls.dispatch } }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { search: { commandPalette: calls.titles } } }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }))
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionPageStore: () => undefined }))
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: vi.fn() }) }))
vi.mock('./palette-projects-group', () => ({ PaletteProjectsGroup: () => null }))
vi.mock('./palette-chats', () => ({ PaletteChatGroups: () => null }))
vi.mock('./palette-session-item', () => ({ PaletteSessionItem: () => null }))
vi.mock('@/lib/guguLinks', () => ({ followLink: vi.fn() }))
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))

it('CmdEnter hands the words to global search even after the modal capture prevents default', async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetSearchSession({ chips: [{ kind: 'in', chatId: 'old-scope' }] })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const closed = vi.fn()
  function Snapshot() { const state = useSearchSession(); return <output>{JSON.stringify(state)}</output> }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <div onKeyDownCapture={(event) => { if (event.metaKey && event.key === 'Enter') event.preventDefault() }}>
        <CommandPaletteModal initialQuery="gu" onClose={closed} onSuccess={() => {}} />
      </div><Snapshot />
    </QueryClientProvider>))
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })))
    expect(closed).toHaveBeenCalledOnce()
    expect(calls.dispatch).toHaveBeenCalledWith('app.globalSearch')
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toMatchObject({ text: 'gu', chips: [] })
  } finally {
    await act(async () => root.unmount()); client.clear(); host.remove()
  }
})
