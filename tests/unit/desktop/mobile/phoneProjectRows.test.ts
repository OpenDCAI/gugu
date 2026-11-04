import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { phoneProjectRows } from '../../../../apps/desktop/src/mobile/assistant/phoneProjectRows'

// #1629 parity on the phone: the personal assistant's host is not one of the person's projects.
// Host identity comes from the device row, never from the project name; nothing is deleted.

const device = (id: string, extra: Partial<Device> = {}): Device => ({
  device_id: id,
  label: id,
  is_online: true,
  is_current_device: false,
  cloud_computer: null,
  capabilities: {},
  ...extra,
} as unknown as Device)

const project = (localProjectId: string, name: string, createdAt = '2026-11-01T00:00:00.000Z'): DeviceProject => ({
  localProjectId,
  name,
  rootPath: `/home/${localProjectId}`,
  createdAt,
  chatId: null,
  folders: [{ workspaceId: `${localProjectId}-root`, kind: 'root', path: `/home/${localProjectId}`, attachedAt: null }],
})

const ids = (rows: { id: string }[]) => rows.map(row => row.id).sort()

describe('phone projects list hides the assistant host (#1629 parity)', () => {
  it('drops projects on a host that reports assistant_home, keeps a same-named project on an ordinary computer', () => {
    const devices = [
      device('cloud-host', { capabilities: { assistant_home: true } as Device['capabilities'] }),
      device('laptop'),
    ]
    const records = {
      'cloud-host': [project('assistant-home', '助理')],
      laptop: [project('p-assistant-name', '助理'), project('p-paper', 'Paper')],
    }
    const rows = phoneProjectRows(records, devices, null)
    expect(ids(rows)).toEqual(['laptop/p-assistant-name', 'laptop/p-paper'])
    expect(rows.find(row => row.id === 'laptop/p-assistant-name')?.label).toBe('助理')
  })

  it('drops projects on the cloud host known only by the device-row cloud_computer field or the cloud host id', () => {
    const devices = [
      device('cloud-a', { cloud_computer: { status: 'paused' } as unknown as Device['cloud_computer'] }),
      device('cloud-b'),
      device('desk'),
    ]
    const records = {
      'cloud-a': [project('a1', '助理')],
      'cloud-b': [project('b1', '助理')],
      desk: [project('d1', 'Desk work')],
    }
    expect(ids(phoneProjectRows(records, devices, 'cloud-b'))).toEqual(['desk/d1'])
  })

  it('drops projects of the cloud host even before its device row is listed', () => {
    const records = { 'cloud-x': [project('x1', '助理')], desk: [project('d1', 'Desk work')] }
    expect(ids(phoneProjectRows(records, [device('desk')], 'cloud-x'))).toEqual(['desk/d1'])
  })

  it('keeps every project on the person\'s own computer when the assistant lives there (home is not the cloud host)', () => {
    // Non-member: the assistant lives on "laptop"; the cloud host id (if any) is a different device.
    const devices = [device('laptop'), device('desk')]
    const records = {
      laptop: [project('l1', '助理'), project('l2', 'Thesis')],
      desk: [project('d1', 'Desk work')],
    }
    expect(ids(phoneProjectRows(records, devices, null))).toEqual(['desk/d1', 'laptop/l1', 'laptop/l2'])
    expect(ids(phoneProjectRows(records, devices, 'cloud-elsewhere'))).toEqual(['desk/d1', 'laptop/l1', 'laptop/l2'])
  })

  it('does not mutate the published account records', () => {
    const devices = [device('cloud-host', { capabilities: { assistant_home: true } as Device['capabilities'] }), device('laptop')]
    const records = { 'cloud-host': [project('h1', '助理')], laptop: [project('l1', 'Paper')] }
    const before = JSON.stringify(records)
    phoneProjectRows(records, devices, null)
    expect(JSON.stringify(records)).toBe(before)
  })
})
