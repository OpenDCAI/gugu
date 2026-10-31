// @vitest-environment jsdom
// Where a project file is kept is shown with whether that machine is on (native #107: the folder's mark stayed 「在线」 for
// minutes after the machine went off). The device list's own facts say when a device went on or off; that, not every
// heartbeat, has main read the folders on screen again.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const { devicesOnlineChanged, state } = vi.hoisted(() => ({
  devicesOnlineChanged: vi.fn(async () => ({ success: true })),
  state: { devices: [] as { device_id: string; status: string; last_seen_at?: string }[] },
}))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpc: { extensions: { devicesOnlineChanged, groupWorkspaceChanged: vi.fn(), chatMembersChanged: vi.fn() } }, events: { on: () => () => undefined } }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron', capabilities: { agentRuntime: true } } }))
vi.mock('@/store/chatContext', () => ({ useChatStore: () => ({ subscribeAccountRevision: () => () => undefined }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: state.devices }) }))

const { useExtensionWorkspaceRevisions } = await import('@/components/extensionBundle/useExtensionWorkspaceRevisions')
function Host() { useExtensionWorkspaceRevisions(); return null }

describe('a device going on or off', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => { harness.cleanup(); vi.clearAllMocks() })
  const show = async (devices: typeof state.devices) => { state.devices = devices; await harness.render(createElement(Host, { key: 'host' })) }

  it('has main read the folders on screen again; a heartbeat or the first read does not', async () => {
    await show([{ device_id: 'mac', status: 'online', last_seen_at: '1' }, { device_id: 'laptop', status: 'online' }])
    await show([{ device_id: 'mac', status: 'online', last_seen_at: '2' }, { device_id: 'laptop', status: 'online' }])
    expect(devicesOnlineChanged).not.toHaveBeenCalled()
    await show([{ device_id: 'mac', status: 'offline', last_seen_at: '2' }, { device_id: 'laptop', status: 'online' }])
    expect(devicesOnlineChanged).toHaveBeenCalledTimes(1)
    await show([{ device_id: 'mac', status: 'online', last_seen_at: '3' }, { device_id: 'laptop', status: 'online' }])
    expect(devicesOnlineChanged).toHaveBeenCalledTimes(2)
  })
})
