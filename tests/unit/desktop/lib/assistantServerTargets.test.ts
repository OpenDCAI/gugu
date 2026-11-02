import { expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { assistantServerTargets } from '../../../../apps/desktop/src/lib/assistantServerTargets'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { normalizeDeviceRow } from '@gugu/core/cloud/devices'

const server = (patch: Partial<Device> = {}): Device => ({ device_id: 'server', label: 'Server', hostname: 'host', platform: 'linux', is_online: true, status: 'online', last_seen_at: '2026-11-02T00:00:00Z',
  capabilities: { terminals: [], runtimes: [], host_kind: 'server', arch: 'x64', remote_protocol: REMOTE_PROTOCOL_VERSION, assistant_home_setup: 1 }, ...patch })
it('only lists account-owned self-hosted servers, preserving exact disabled reasons', () => {
  const source = server()
  const rows = [source,
    server({ device_id: 'offline', is_online: false }),
    server({ device_id: 'mac', platform: 'darwin' }),
    server({ device_id: 'old', capabilities: { ...source.capabilities, assistant_home_setup: undefined } }),
    server({ device_id: 'arch', capabilities: { ...source.capabilities, arch: 'riscv64' } }),
    server({ device_id: 'desktop', capabilities: { ...source.capabilities, host_kind: 'desktop' } }),
    server({ device_id: 'cloud', capabilities: { ...source.capabilities, assistant_home: true } }),
    server({ device_id: 'cloud-state', cloud_computer: 'awake' }),
  ]
  expect(assistantServerTargets(rows)).toEqual([
    { deviceId: 'server', label: 'Server', selectable: true, reason: null },
    { deviceId: 'offline', label: 'Server', selectable: false, reason: 'target_offline' },
    { deviceId: 'mac', label: 'Server', selectable: false, reason: 'unsupported_platform' },
    { deviceId: 'old', label: 'Server', selectable: false, reason: 'server_update_required' },
    { deviceId: 'arch', label: 'Server', selectable: false, reason: 'unsupported_arch' },
  ])
})
it('rejects a future host whose minimum client is newer, and accepts supported arm64', () => {
  const row = server()
  expect(assistantServerTargets([server({ capabilities: { ...row.capabilities, arch: 'arm64' } })])[0]?.selectable).toBe(true)
  expect(assistantServerTargets([server({ capabilities: { ...row.capabilities, min_client_protocol: REMOTE_PROTOCOL_VERSION + 1 } })])[0]?.reason).toBe('server_update_required')
})
it('preserves the capability through the real device directory normalizer', () => {
  const row = normalizeDeviceRow(server())
  expect(assistantServerTargets([row])[0]).toMatchObject({ selectable: true })
  const legacy = normalizeDeviceRow(server({ capabilities: { ...server().capabilities, assistant_home_setup: undefined } }))
  expect(assistantServerTargets([legacy])[0]).toMatchObject({ reason: 'server_update_required' })
})
