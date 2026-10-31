import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeOsName,
  linuxNameFromOsRelease,
  macosVersionFromDarwin,
  parseServerRollback,
  parseServerUpdateState,
  readDiskSpace,
  resetDeviceHostInfoCacheForTest,
  resolveDeviceHostInfo,
  SERVER_UPDATE_READY_STALE_MS,
} from '../../../../packages/core/src/cloud/deviceHostInfo'
import { createDeviceRuntimeHostLoop, normalizeDeviceRow, type DeviceRuntimeIdentityClient } from '@gugu/core'
import {
  MIN_CLIENT_PROTOCOL,
  REMOTE_PROTOCOL_VERSION,
  serverMachineNotices,
  SERVER_DISK_LOW_BYTES,
} from '../../../../packages/core/src/cloud/serverMachineHealth'
import { isolatedGuguEnv, pollOnlyRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'

afterEach(() => resetDeviceHostInfoCacheForTest())

describe('#6264 设备行上报「这是台什么机器」', () => {
  it('系统名:macOS 按内核主版本换算(25 起跳到 26),Linux 取 os-release,认不出不编', () => {
    expect(macosVersionFromDarwin('24.6.0')).toBe('15')
    expect(macosVersionFromDarwin('25.5.0')).toBe('26')
    expect(macosVersionFromDarwin('19.0.0')).toBeNull()
    expect(linuxNameFromOsRelease('NAME="Ubuntu"\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04.5 LTS"\n')).toBe('Ubuntu 22.04.5 LTS')
    expect(linuxNameFromOsRelease('NAME=Alpine\nVERSION_ID=3.20\n')).toBe('Alpine 3.20')
    expect(describeOsName({ platform: 'linux', release: '6.1', osReleaseText: null })).toBe('Linux')
    expect(describeOsName({ platform: 'darwin', release: '25.5.0', osReleaseText: null })).toBe('macOS 26')
    expect(describeOsName({ platform: 'freebsd', release: '14', osReleaseText: null })).toBeUndefined()
  })

  it('升级状态:只认两种状态;下载中 2 小时、就绪 10 分钟没续写就当过期', () => {
    const now = 1_000_000_000
    expect(parseServerUpdateState(JSON.stringify({ state: 'ready', version: '0.3.0', at: now - 1000 }), now)).toEqual({ state: 'ready', version: '0.3.0' })
    expect(parseServerUpdateState(JSON.stringify({ state: 'ready', version: '0.3.0', at: now - SERVER_UPDATE_READY_STALE_MS - 1 }), now)).toBeNull()
    expect(parseServerUpdateState(JSON.stringify({ state: 'downloading', version: '0.3.0', at: now - 60 * 60 * 1000 }), now)).toEqual({ state: 'downloading', version: '0.3.0' })
    expect(parseServerUpdateState(JSON.stringify({ state: 'weird', version: '0.3.0', at: now }), now)).toBeNull()
    expect(parseServerUpdateState('{not json', now)).toBeNull()
  })

  it('server 报 host_kind=server 并带上升级状态;桌面报 desktop、不读升级文件', () => {
    const files: Record<string, string> = {
      '/etc/os-release': 'PRETTY_NAME="Ubuntu 22.04.5 LTS"\n',
      '/srv/gugu/data/server-update.json': JSON.stringify({ state: 'ready', version: '0.3.0', at: 5_000 }),
    }
    const readText = vi.fn((path: string) => files[path] ?? null)
    const deps = { platform: () => 'linux', release: () => '6.1', arch: () => 'arm64', readText, nowMs: () => 6_000, uid: () => 1000, homedir: () => '/home/ubuntu' }
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv/gugu' }, deps)).toEqual({
      host_kind: 'server',
      arch: 'arm64',
      os_name: 'Ubuntu 22.04.5 LTS',
      home_dir: '/home/ubuntu',
      server_update: { state: 'ready', version: '0.3.0' },
      remote_protocol: REMOTE_PROTOCOL_VERSION,
      min_client_protocol: MIN_CLIENT_PROTOCOL,
    })
    readText.mockClear()
    expect(resolveDeviceHostInfo({ GUGU_SERVER_HOME: '/srv/gugu' }, deps)).toEqual({ host_kind: 'desktop', arch: 'arm64', os_name: 'Ubuntu 22.04.5 LTS', home_dir: '/home/ubuntu' })
    expect(readText).not.toHaveBeenCalledWith('/srv/gugu/data/server-update.json')
  })

  it('远程 SSH / 远程隧道随心跳报(账号目录里记的那一条);没记的不报(= 远程隧道);桌面不报;设备行按形状收', () => {
    const files: Record<string, string> = {
      '/srv/gugu/accounts/u1/data/connect-via.json': JSON.stringify({ via: 'ssh', at: '2026-09-25T00:00:00Z' }),
      '/srv/gugu/accounts/u2/data/connect-via.json': JSON.stringify({ via: 'tunnel', at: '2026-09-25T00:00:00Z' }),
    }
    const deps = { platform: () => 'linux', release: () => '6.1', arch: () => 'x64', readText: (p: string) => files[p] ?? null, uid: () => 1000 }
    const server = (account: string) => ({ GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv/gugu', GUGU_TASK_HOST_USER_DATA: `/srv/gugu/accounts/${account}/data` })
    expect(resolveDeviceHostInfo(server('u1'), deps).connect_via).toBe('ssh')
    expect(resolveDeviceHostInfo(server('u2'), deps).connect_via).toBe('tunnel')
    expect(resolveDeviceHostInfo(server('u3'), deps).connect_via).toBeUndefined()
    expect(resolveDeviceHostInfo({ GUGU_TASK_HOST_USER_DATA: '/srv/gugu/accounts/u1/data' }, deps).connect_via).toBeUndefined()
    const base = { device_id: 'd', label: 'x', hostname: 'h', platform: 'linux', status: 'online', last_seen_at: '2026-09-23T00:00:00Z' }
    expect(normalizeDeviceRow({ ...base, capabilities: { host_kind: 'server', connect_via: 'ssh' } }).capabilities.connect_via).toBe('ssh')
    expect(normalizeDeviceRow({ ...base, capabilities: { host_kind: 'server', connect_via: 'wormhole' } }).capabilities.connect_via).toBeUndefined()
  })

  // #113 别的端据此认出那台机器上的「~」项目,那台离线、那一端又从没连上过它时也认得出。
  it('桌面与 server 都报主目录;读侧收完整的路径,太长(截了就是另一个路径)当没报', () => {
    const deps = { platform: () => 'linux', release: () => '6.1', arch: () => 'x64', readText: () => null, uid: () => 1000 }
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1' }, { ...deps, homedir: () => '/home/ubuntu' }).home_dir).toBe('/home/ubuntu')
    expect(resolveDeviceHostInfo({}, { ...deps, homedir: () => '/Users/apple' }).home_dir).toBe('/Users/apple')
    expect(resolveDeviceHostInfo({}, { ...deps, homedir: () => '' }).home_dir).toBeUndefined()
    const base = { device_id: 'd', label: 'x', hostname: 'h', platform: 'linux', status: 'online', last_seen_at: '2026-09-23T00:00:00Z' }
    expect(normalizeDeviceRow({ ...base, capabilities: { home_dir: '/home/ubuntu' } }).capabilities.home_dir).toBe('/home/ubuntu')
    expect(normalizeDeviceRow({ ...base, capabilities: { home_dir: `/${'x'.repeat(4096)}` } }).capabilities.home_dir).toBeUndefined()
    expect(normalizeDeviceRow({ ...base, capabilities: { home_dir: 7 } }).capabilities.home_dir).toBeUndefined()
    expect(normalizeDeviceRow({ ...base, capabilities: {} }).capabilities.home_dir).toBeUndefined()
  })

  it('root 跑的 server 报 runs_as_root(设备列表据此写「以管理员身份运行」);普通用户、桌面都不报', () => {
    const deps = { platform: () => 'linux', release: () => '6.1', arch: () => 'x64', readText: () => null, uid: () => 0 }
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1' }, deps).runs_as_root).toBe(true)
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1' }, { ...deps, uid: () => 1000 }).runs_as_root).toBeUndefined()
    expect(resolveDeviceHostInfo({}, deps).runs_as_root).toBeUndefined()
    const base = { device_id: 'd', label: 'x', hostname: 'h', platform: 'linux', status: 'online', last_seen_at: '2026-09-23T00:00:00Z' }
    expect(normalizeDeviceRow({ ...base, capabilities: { runs_as_root: true } }).capabilities.runs_as_root).toBe(true)
    expect(normalizeDeviceRow({ ...base, capabilities: { runs_as_root: 'yes' } }).capabilities.runs_as_root).toBeUndefined()
  })

  it('读侧:老宿主不报就缺席,❌ 补默认值;坏形状的升级状态丢掉', () => {
    const base = { device_id: 'd', label: 'Linux 1', hostname: 'h', platform: 'linux', status: 'online', last_seen_at: '2026-09-23T00:00:00Z' }
    const old = normalizeDeviceRow({ ...base, capabilities: { terminals: [], runtimes: [] } }).capabilities
    expect(old.host_kind).toBeUndefined()
    expect(old.os_name).toBeUndefined()
    expect(old.server_update).toBeUndefined()
    const fresh = normalizeDeviceRow({
      ...base,
      capabilities: { host_kind: 'server', os_name: 'Ubuntu 22.04', arch: 'x64', server_update: { state: 'downloading', version: '0.3.0' } },
    }).capabilities
    expect(fresh).toMatchObject({ host_kind: 'server', os_name: 'Ubuntu 22.04', arch: 'x64', server_update: { state: 'downloading', version: '0.3.0' } })
    expect(normalizeDeviceRow({ ...base, capabilities: { host_kind: 'toaster', server_update: { state: 'x' } } }).capabilities.host_kind).toBeUndefined()
    // #7199 手机当设备:手机登记的行 host_kind = phone,读侧认得它(「在哪跑」靠它把手机分出去)。
    expect(normalizeDeviceRow({ ...base, capabilities: { host_kind: 'phone' } }).capabilities.host_kind).toBe('phone')
  })
})

describe('#6264 被移除的 server:库拒收心跳 ⇒ 宿主只通知一次', () => {
  it('DEVICE_REMOVED 触发 onDeviceRemoved 恰好一次,别的心跳错误不触发', async () => {
    const env = await isolatedGuguEnv('gugu-device-removed-6264-')
    const client = pollOnlyRuntimeIdentityClient([], 'device removed #6264')
    let upsertError: string | null = 'boom: network'
    const originalFrom = client.from.bind(client) as (table: string) => unknown
    ;(client as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      const real = originalFrom(table) as Record<string, unknown>
      if (table !== 'gugu_devices') return real
      return { ...real, upsert: async () => ({ data: null, error: upsertError ? { message: upsertError } : null }) }
    }
    const onDeviceRemoved = vi.fn()
    const host = createDeviceRuntimeHostLoop({
      env,
      intervalMs: 60_000,
      subscribeCommandWake: () => () => undefined,
      machineIdentifier: () => 'machine-6264',
      authProvider: { getAuth: async () => ({ accessToken: 'token-1', userId: 'user-1' }) },
      makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
      capabilities: { terminals: [], runtimes: [] },
      onDeviceRemoved,
      warn: () => undefined,
    })
    await host.tickOnce().catch(() => undefined)
    expect(onDeviceRemoved).not.toHaveBeenCalled()
    upsertError = 'DEVICE_REMOVED: this machine was removed from the account; sign in again on it to use it'
    await host.tickOnce().catch(() => undefined)
    await host.tickOnce().catch(() => undefined)
    expect(onDeviceRemoved).toHaveBeenCalledTimes(1)
    expect(String(onDeviceRemoved.mock.calls[0][0])).toContain('DEVICE_REMOVED')
    await host.stop()
  })
})

describe('#6264 server 要人知道的事:磁盘、升级被退回、两边版本', () => {
  it('server 报数据目录所在盘的余量与退回记录;统计不到磁盘就不报', () => {
    const files: Record<string, string> = {
      '/srv/gugu/data/server-rollback.json': JSON.stringify({ version: '0.3.1', restored: '0.3.0', at: 5_000 }),
      '/srv/gugu/data/supervisor-health.json': JSON.stringify({ version: '0.3.0', pid: 1, startedAt: 5_500, at: 5_900 }),
    }
    const deps = {
      platform: () => 'linux', release: () => '6.1', arch: () => 'x64', readText: (p: string) => files[p] ?? null, nowMs: () => 6_000,
      statfs: () => ({ bavail: 1000, blocks: 4000, bsize: 4096 }),
    }
    // 报心跳的账号进程钉在和桌面匹配的 0.3.5 上(ThinkPad 10-07 的形状):退回说的是守护进程,照报。
    const info = resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv/gugu', GUGU_TASK_HOST_VERSION: '0.3.5' }, deps)
    expect(info.server_disk).toEqual({ free_bytes: 4_096_000, total_bytes: 16_384_000 })
    expect(info.server_rollback).toEqual({ version: '0.3.1', restored: '0.3.0' })
    files['/srv/gugu/data/supervisor-health.json'] = JSON.stringify({ version: '0.3.2', pid: 1, startedAt: 5_500, at: 5_900 })
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv/gugu', GUGU_TASK_HOST_VERSION: '0.3.0' }, deps).server_rollback).toBeUndefined()
    const noDisk = resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/srv/gugu' }, { ...deps, statfs: () => { throw new Error('ENOSYS') } })
    expect(noDisk.server_disk).toBeUndefined()
  })

  it('退回记录:一周后、或守护进程已经升上去了(它跑的不是退回到的那一版)就不再报', () => {
    const text = JSON.stringify({ version: '0.3.1', restored: '0.3.0', at: 0 })
    expect(parseServerRollback(text, 1_000, '0.3.0')).toEqual({ version: '0.3.1', restored: '0.3.0' })
    expect(parseServerRollback(text, 8 * 24 * 3_600_000, '0.3.0')).toBeNull()
    expect(parseServerRollback(text, 1_000, '0.3.2')).toBeNull()
    expect(parseServerRollback('{', 1_000, '0.3.0')).toBeNull()
    expect(readDiskSpace('/x', () => ({ bavail: 10n, blocks: 20n, bsize: 512n }))).toEqual({ free_bytes: 5_120, total_bytes: 10_240 })
  })

  it('读侧收下这几项,坏形状丢掉', () => {
    const base = { device_id: 'd', label: 'Linux 1', hostname: 'h', platform: 'linux', status: 'online', last_seen_at: '2026-09-23T00:00:00Z' }
    const caps = normalizeDeviceRow({
      ...base,
      capabilities: {
        terminals: [], runtimes: [], host_kind: 'server',
        server_disk: { free_bytes: 10, total_bytes: 100 }, server_rollback: { version: 'b', restored: 'a' },
        remote_protocol: 2, min_client_protocol: 1,
      },
    }).capabilities
    expect(caps).toMatchObject({ server_disk: { free_bytes: 10, total_bytes: 100 }, server_rollback: { version: 'b', restored: 'a' }, remote_protocol: 2, min_client_protocol: 1 })
    const bad = normalizeDeviceRow({
      ...base,
      capabilities: { terminals: [], runtimes: [], server_disk: { free_bytes: 200, total_bytes: 100 }, server_rollback: { version: 'b' }, remote_protocol: 1.5 },
    }).capabilities
    expect(bad.server_disk).toBeUndefined()
    expect(bad.server_rollback).toBeUndefined()
    expect(bad.remote_protocol).toBeUndefined()
  })

  it('要人知道的事按要紧程度排;老宿主不报就不下结论;桌面复用协议提示', () => {
    const own = { protocol: 2, minServer: 2 }
    expect(serverMachineNotices({ host_kind: 'server', min_client_protocol: 3, server_disk: { free_bytes: 5, total_bytes: 10 } }, own)).toEqual([
      { kind: 'desktop-too-old' },
      { kind: 'disk-low', freeBytes: 5 },
    ])
    expect(serverMachineNotices({ host_kind: 'server', remote_protocol: 1 }, own)).toEqual([{ kind: 'server-too-old' }])
    expect(serverMachineNotices({ host_kind: 'server', server_disk: { free_bytes: SERVER_DISK_LOW_BYTES, total_bytes: 2 * SERVER_DISK_LOW_BYTES } }, own)).toEqual([])
    expect(serverMachineNotices({ host_kind: 'server', server_rollback: { version: 'b', restored: 'a' } }, own)).toEqual([{ kind: 'rolled-back', version: 'b', restored: 'a' }])
    expect(serverMachineNotices({ host_kind: 'server' }, own)).toEqual([])
    expect(serverMachineNotices({ host_kind: 'desktop', min_client_protocol: 9 }, own)).toEqual([{ kind: 'desktop-too-old' }])
    expect(serverMachineNotices({ host_kind: 'desktop', remote_protocol: 1 }, own)).toEqual([{ kind: 'server-too-old' }])
  })

  it('rejects peers that cannot exchange canonical file patch entities', () => {
    const patched = { host_kind: 'server' as const, remote_protocol: REMOTE_PROTOCOL_VERSION, min_client_protocol: MIN_CLIENT_PROTOCOL }
    expect(serverMachineNotices(patched, { protocol: 10, minServer: 9 })).toEqual([{ kind: 'desktop-too-old' }])
    expect(serverMachineNotices({ host_kind: 'server', remote_protocol: 10, min_client_protocol: 9 })).toEqual([{ kind: 'server-too-old' }])
    expect(serverMachineNotices(patched)).toEqual([])
  })

  it('#6264 一套工作台:这一版 server 让协议 1 的旧桌面说「请更新这台电脑上的咕咕」,与现在的桌面互认', () => {
    const served = { host_kind: 'server' as const, remote_protocol: REMOTE_PROTOCOL_VERSION, min_client_protocol: MIN_CLIENT_PROTOCOL }
    // 旧桌面(0.2.155 及以前)的判据:自己协议 1、要 server 至少 1。
    expect(serverMachineNotices(served, { protocol: 1, minServer: 1 })).toEqual([{ kind: 'desktop-too-old' }])
    // #6914 之前的桌面(协议 2)对这一版 server 同样要更新。
    expect(serverMachineNotices(served, { protocol: 2, minServer: 1 })).toEqual([{ kind: 'desktop-too-old' }])
    // 现在的桌面对这一版 server 不报版本问题;#6914 之前的 server(报 1 或 2)不认这条线上现在的方法 ⇒ 太旧。
    expect(serverMachineNotices(served)).toEqual([])
    expect(serverMachineNotices({ host_kind: 'server', remote_protocol: 2, min_client_protocol: 2 })).toEqual([{ kind: 'server-too-old' }])
    expect(serverMachineNotices({ host_kind: 'server', remote_protocol: 1, min_client_protocol: 1 })).toEqual([{ kind: 'server-too-old' }])
    // #6985 协议 4 的 server(远程 SSH 那一版不接咕咕云)对现在的桌面一律太旧 —— 远程隧道的也算,空闲时自己升级
    // 之前照样标着(有意的代价:手机和别的电脑要靠这一句知道它为什么点不动)。
    expect(serverMachineNotices({ host_kind: 'server', remote_protocol: 4, min_client_protocol: 4 })).toEqual([{ kind: 'server-too-old' }])
    // 一套说法(协议 6):推送改按订阅号走,协议 4、5 的桌面听不到 ⇒ 这一版 server 让它们更新;同协议的桌面照常。
    expect(serverMachineNotices(served, { protocol: 5, minServer: 5 })).toEqual([{ kind: 'desktop-too-old' }])
    expect(serverMachineNotices(served, { protocol: MIN_CLIENT_PROTOCOL, minServer: MIN_CLIENT_PROTOCOL })).toEqual([])
  })
})
