// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device } from '../../../support/testHarness'
const state = vi.hoisted(() => ({ mobile: false, sync: vi.fn(), bridge: vi.fn() }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => state.mobile }))
vi.mock('../../../../apps/desktop/src/hooks/useRemoteHostsBridge', () => ({ useRemoteHostsBridge: state.bridge }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/usePhoneAgentDirectory', () => ({ usePhoneAgentDirectory: state.sync }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [], phones: [device('phone', [], { platform: 'android', capabilities: { host_kind: 'phone', runtimes: ['pi'], terminals: [], host_runtime_capability: 1 } })] }) }))
vi.mock('../../../../apps/desktop/src/components/SshLinkSignIn', () => ({ SshLinkSignIn: () => null }))
vi.mock('../../../../apps/desktop/src/components/RemoteFolderPicker', () => ({ RemoteFolderPicker: () => null }))
import { RemoteMachinesHost } from '../../../../apps/desktop/src/components/sessionpage/RemoteMachinesHost'
import { phoneTaskDirectoryRequested, requestPhoneTaskDirectory } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { state.mobile = false; vi.clearAllMocks(); harness = createReactHarness() })
afterEach(() => harness.cleanup())
it('starts desktop polling only with task readers and stops when the last reader leaves', async () => {
  await harness.render(<RemoteMachinesHost enabled openSettingsSection={vi.fn()} />)
  expect(state.sync.mock.lastCall?.[0]).toEqual([])
  let release!: () => void
  act(() => { release = requestPhoneTaskDirectory() })
  expect(state.sync.mock.lastCall?.[0].map((row: { device_id: string }) => row.device_id)).toEqual(['phone'])
  act(() => release())
  expect(state.sync.mock.lastCall?.[0]).toEqual([])
  expect(phoneTaskDirectoryRequested()).toBe(false)
})
it('leaves mobile web polling to AgentWatchRoot even while a task reader is mounted', async () => {
  state.mobile = true
  const release = requestPhoneTaskDirectory()
  try {
    await harness.render(<RemoteMachinesHost enabled openSettingsSection={vi.fn()} />)
    expect(state.sync.mock.lastCall?.[0]).toEqual([])
  } finally { act(() => release()) }
})
