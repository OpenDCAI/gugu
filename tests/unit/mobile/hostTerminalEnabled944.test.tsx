// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'
import { useHostTerminalEnabled } from '../../../apps/desktop/src/mobile/agent-watch/use-host-terminal-enabled'

const rpc = vi.hoisted(() => ({ get: vi.fn(), link: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: (deviceId: string) => ({ appSettings: { get: (key: string) => rpc.get(deviceId, key) } }),
  onLinkChange: rpc.link,
}))
let harness: ReturnType<typeof createReactHarness>
let refresh: () => void
function Read({ deviceId, online = true }: { deviceId: string; online?: boolean }) {
  const state = useHostTerminalEnabled(deviceId, online)
  refresh = state.refresh
  return <output>{String(state.enabled)}</output>
}
const enabled = () => harness.container.querySelector('output')?.textContent
beforeEach(() => {
  harness = createReactHarness()
  rpc.get.mockReset().mockResolvedValue({ enabled: true })
  rpc.link.mockReset().mockReturnValue(() => undefined)
})
afterEach(() => harness.cleanup())

it('reads the selected host setting and hides the switch when the read fails', async () => {
  await harness.render(createNode(Read, { deviceId: 'host-a' }))
  expect(rpc.get).toHaveBeenCalledWith('host-a', 'terminal')
  expect(enabled()).toBe('true')
  rpc.get.mockRejectedValueOnce(new Error('host unavailable'))
  await act(async () => refresh())
  expect(enabled()).toBe('false')
})

it('never borrows another host’s reading or accepts its late response', async () => {
  const late = deferred<{ enabled: boolean }>()
  rpc.get.mockImplementation((id: string) => id === 'host-a' ? late.promise : Promise.resolve({ enabled: false }))
  await harness.render(createNode(Read, { deviceId: 'host-a' }))
  await harness.render(createNode(Read, { deviceId: 'host-b' }))
  expect(enabled()).toBe('false')
  await act(async () => { late.resolve({ enabled: true }); await late.promise })
  expect(enabled()).toBe('false')
})

it('rechecks after a host reconnects', async () => {
  await harness.render(createNode(Read, { deviceId: 'host-a' }))
  const onLink = rpc.link.mock.calls[0]![1] as (open: boolean) => void
  rpc.get.mockResolvedValueOnce({ enabled: false })
  await act(async () => onLink(true))
  expect(enabled()).toBe('false')
})

it('does not read an offline host or the phone runtime', async () => {
  await harness.render(createNode(Read, { deviceId: 'phone', online: false }))
  expect(rpc.get).not.toHaveBeenCalled()
  expect(enabled()).toBe('false')
})


it('hides a previous host’s enabled switch while the next host is still being read', async () => {
  await harness.render(createNode(Read, { deviceId: 'host-a' }))
  expect(enabled()).toBe('true')
  const pending = deferred<{ enabled: boolean }>()
  rpc.get.mockReturnValueOnce(pending.promise)
  await harness.render(createNode(Read, { deviceId: 'host-b' }))
  expect(enabled()).toBe('false')
  await act(async () => { pending.resolve({ enabled: false }); await pending.promise })
})
