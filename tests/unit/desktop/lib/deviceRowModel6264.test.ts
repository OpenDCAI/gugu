import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { deviceRowModel, filterDevices, hasOtherMachines } from '@/lib/deviceRowModel'

function device(overrides: Partial<Device> & { caps?: Partial<Device['capabilities']> } = {}): Device {
  const { caps, ...rest } = overrides
  return {
    device_id: 'dev',
    label: 'Linux 1',
    hostname: 'ip-172-31-0-1',
    platform: 'linux',
    status: 'online',
    last_seen_at: '2026-09-23T00:00:00Z',
    is_online: true,
    is_current_device: false,
    capabilities: { terminals: [], runtimes: [], ...caps },
    ...rest,
  }
}

describe('#6264 设备行模型', () => {
  it('咕咕 server:系统 · 架构、版本、升级状态、经 SSH 的地址', () => {
    const model = deviceRowModel(
      device({ caps: { host_kind: 'server', os_name: 'Ubuntu 22.04.5 LTS', arch: 'arm64', app_version: '0.2.99', server_update: { state: 'ready', version: '0.3.0' } } }),
      'alice@box:2222',
    )
    expect(model).toEqual({
      kind: 'server',
      system: 'Ubuntu 22.04.5 LTS · arm64',
      version: '0.2.99',
      update: { state: 'ready', version: '0.3.0' },
      notices: [],
      connection: { via: 'ssh', address: 'alice@box:2222' },
    })
  })

  it('别的电脑用远程 SSH 加的 server:这里没有地址,标「远程 SSH」(经云端连);远程隧道 / 老宿主不报的标云端', () => {
    expect(deviceRowModel(device({ caps: { host_kind: 'server', connect_via: 'ssh' } }), null).connection).toEqual({ via: 'sshElsewhere' })
    expect(deviceRowModel(device({ caps: { host_kind: 'server', connect_via: 'ssh' } }), 'alice@box').connection).toEqual({ via: 'ssh', address: 'alice@box' })
    expect(deviceRowModel(device({ caps: { host_kind: 'server', connect_via: 'tunnel' } }), null).connection).toEqual({ via: 'cloud' })
    expect(deviceRowModel(device({ caps: { host_kind: 'server' } }), null).connection).toEqual({ via: 'cloud' })
  })

  it('本机永远是 this、不标连法;老宿主不报系统名就退回平台名;别的电脑经云端', () => {
    expect(deviceRowModel(device({ is_current_device: true, platform: 'darwin' }), 'x').connection).toEqual({ via: 'this' })
    const old = deviceRowModel(device({ platform: 'darwin' }), null)
    expect(old).toMatchObject({ kind: 'desktop', system: 'macOS', version: null, update: null, connection: { via: 'cloud' } })
    // 桌面行即便带了升级字段也不显示(那是 server 自己升级的状态)
    expect(deviceRowModel(device({ caps: { host_kind: 'desktop', server_update: { state: 'ready', version: '1' } } }), null).update).toBeNull()
    expect(deviceRowModel(device({ device_id: 'cloud:u', platform: 'cloud' }), null)).toMatchObject({ kind: 'cloud', system: null, version: null })
  })

  it('搜索名字 / 主机名 / 系统 / SSH 地址,按在线状态筛', () => {
    const list = [
      device({ device_id: 'a', label: 'Lab GPU', caps: { os_name: 'Ubuntu 22.04' } }),
      device({ device_id: 'b', label: 'Linux 2', is_online: false, status: 'offline' }),
      device({ device_id: 'c', label: 'Mac mini', platform: 'darwin' }),
    ]
    const ssh = (id: string) => (id === 'b' ? 'bob@cluster.example.org' : null)
    const ids = (query: string, filter: 'all' | 'online' | 'offline' = 'all') => filterDevices(list, { query, filter, sshAddress: ssh }).map((d) => d.device_id)
    expect(ids('gpu')).toEqual(['a'])
    expect(ids('ubuntu')).toEqual(['a'])
    expect(ids('cluster.example')).toEqual(['b'])
    expect(ids('macos')).toEqual(['c'])
    expect(ids('', 'offline')).toEqual(['b'])
    expect(ids('', 'online')).toEqual(['a', 'c'])
    expect(ids('nothing')).toEqual([])
  })

  it('只有本机 ⇒ 空状态', () => {
    expect(hasOtherMachines([device({ is_current_device: true })])).toBe(false)
    expect(hasOtherMachines([device({ is_current_device: true }), device({ device_id: 'x' })])).toBe(true)
  })
})

describe('#6264 设备行上要人知道的事', () => {
  it('desktop and server task hosts share protocol mismatch notices', () => {
    for (const host_kind of ['desktop', 'server'] as const) {
      expect(deviceRowModel(device({ caps: { host_kind, remote_protocol: 11 } }), null).notices)
        .toEqual([{ kind: 'server-too-old' }])
      expect(deviceRowModel(device({ caps: { host_kind, min_client_protocol: 99 } }), null).notices)
        .toEqual([{ kind: 'desktop-too-old' }])
    }
  })

  it('server 行带上磁盘快满 / 升级被退回;桌面行即便带了这些字段也不显示', () => {
    const caps = { server_disk: { free_bytes: 300 * 1024 * 1024, total_bytes: 20 * 1024 ** 3 }, server_rollback: { version: '0.3.1', restored: '0.3.0' } }
    expect(deviceRowModel(device({ caps: { host_kind: 'server', ...caps } }), null).notices).toEqual([
      { kind: 'disk-low', freeBytes: 300 * 1024 * 1024 },
      { kind: 'rolled-back', version: '0.3.1', restored: '0.3.0' },
    ])
    expect(deviceRowModel(device({ caps: { host_kind: 'desktop', ...caps } }), null).notices).toEqual([])
  })
})
