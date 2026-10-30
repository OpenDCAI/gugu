// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatChannelList, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer'
import { createReactHarness } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({ owner: 0, list: vi.fn(), peek: vi.fn(), save: vi.fn(), client: vi.fn() }))
vi.mock('@/lib/chatChannels', () => ({ rendererChatChannelsClient: mocks.client }))
vi.mock('@/lib/sessionPublication', () => ({
  getRendererSession: () => ({ user: { id: `channel-owner-${mocks.owner}` } }),
  observeRendererSession: () => () => {},
}))
vi.mock('@/components/assistant/assistant-panel-cache', () => ({ assistantPanelCacheStore: () => ({
  accountState: () => ({ peek: mocks.peek, save: mocks.save }),
}) }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }))

import { useChatChannels } from '@/components/settings/channels/useChatChannels'
let state: ReturnType<typeof useChatChannels>
function Probe() {
  state = useChatChannels()
  return <output>{state.status}: {state.error}</output>
}
const snapshot: ChatChannelList = { channels: [], kinds: ['wechat'], suggestedAgentId: null }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner += 1
  mocks.peek.mockReturnValue(null)
  mocks.client.mockReturnValue({ list: mocks.list } as unknown as ChatChannelsClient)
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

describe('channel service failures', () => {
  it('reports configuration failure and recovers when the user retries', async () => {
    mocks.list.mockRejectedValueOnce(new CloudComputerError(503, 'unavailable', 'Channel service signing key is not configured.'))
    await harness.render(<Probe />)
    await act(async () => {})
    expect(state.status).toBe('failed')
    expect(harness.container.textContent).toContain('signing key is not configured')
    expect(mocks.save).not.toHaveBeenCalled()

    mocks.list.mockResolvedValueOnce(snapshot)
    await act(async () => state.refresh())
    expect(state.status).toBe('ready')
    expect(state.error).toBe('')
    expect(mocks.save).toHaveBeenCalledWith(snapshot)
  })

  it('keeps the cached connection list and the failure reason when refreshing fails', async () => {
    mocks.peek.mockReturnValue(snapshot)
    mocks.list.mockRejectedValueOnce(new CloudComputerError(503, 'unavailable', 'Channel service encryption key is not configured.'))
    await harness.render(<Probe />)
    await act(async () => {})
    expect(state.status).toBe('ready')
    expect(state.list).toEqual(snapshot)
    expect(state.error).toContain('encryption key is not configured')
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
