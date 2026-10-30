// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ v3: true }))
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { appSettings: { getWithMeta: async () => ({ value: { v3: settings.v3 }, defaults: { v3: false }, overrides: {} }) } },
}))
import { queryClient } from '@renderer/lib/query-client'
import { appSettingsMetaQueryKey } from '@renderer/features/settings/app-settings-client'
import { globalSearchV3Enabled, useGlobalSearchV3 } from './global-search-flag'

describe('globalSearch.v3 in the renderer', () => {
  it('stays read while the chat store is mounted, long past the query cache collection time', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const seen: boolean[] = []
    function Probe() { seen.push(useGlobalSearchV3()); return null }
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => { root.render(<Probe />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(seen.at(-1)).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000) })
      expect(queryClient.getQueryData(appSettingsMetaQueryKey('globalSearch'))).toBeDefined()
      expect(seen.at(-1)).toBe(true)
      // The feed reads the same observer outside React.
      expect(globalSearchV3Enabled()).toBe(true)
    } finally {
      act(() => root.unmount())
      vi.useRealTimers()
    }
  })
})
