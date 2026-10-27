import { describe, expect, it } from 'vitest'
import {
  listDevices,
  normalizeDeviceRow,
  renameDevice,
  removeDevice,
  isDeviceHasAgentsError,
  adoptDeviceName,
  isDerivedDeviceLabel,
  type DeviceLabelClient,
} from '@gugu/core/cloud/devices'

describe('device cloud helpers', () => {
  it('normalizes device rows and reads online state straight off the row', () => {
    expect(
      normalizeDeviceRow(
        {
          device_id: 'device-1',
          label: 'Mac',
          hostname: 'mac.local',
          platform: 'darwin',
          status: 'online',
          last_seen_at: '2026-05-09T00:01:59.000Z',
          capabilities: { terminals: ['tmux', 'kitty'], runtimes: ['codex'] }
        }
      )
    ).toEqual({
      device_id: 'device-1',
      label: 'Mac',
      hostname: 'mac.local',
      platform: 'darwin',
      status: 'online',
      last_seen_at: '2026-05-09T00:01:59.000Z',
      is_online: true,
      capabilities: { terminals: ['tmux', 'kitty'], runtimes: ['codex'], host_runtime_capability: 0 },
      // #4277 老行没有 machine_id ⇒ null(展示层退回按 device_id 归类),❌ 缺列报错
      machine_id: null,
      // #5013 老行没有 session_digest ⇒ 空数组(离线时手机就没有会话可显示),同上不报错
      session_digest: []
    })
  })

  it('keeps a reported tier for configuration details and does not invent one for old rows', () => {
    const row = { device_id: 'mac-beta', label: 'Mac', hostname: 'mac', platform: 'darwin', status: 'online', last_seen_at: '2026-10-27T00:00:00Z' }
    expect(normalizeDeviceRow({ ...row, tier: 'beta' }).tier).toBe('beta')
    expect(normalizeDeviceRow(row)).not.toHaveProperty('tier')
  })

  // @@@5912 在线只看 status。一行 status='online' 而 last_seen_at 很旧,改前会被算成**离线**
  // (客户端自己拿时间戳推),改后就是在线:租约过期与否由库的清扫者判。这一格红过。
  it.each([
    ['online', '2020-01-01T00:00:00.000Z', true],
    ['offline', new Date().toISOString(), false],
  ] as const)('#5912 status=%s + last_seen_at=%s ⇒ is_online=%s', (status, lastSeenAt, expected) => {
    expect(normalizeDeviceRow({
      device_id: 'device-1', label: 'Mac', hostname: 'mac.local', platform: 'darwin',
      status, last_seen_at: lastSeenAt,
    }).is_online).toBe(expected)
  })

  it('normalizes device capabilities with empty-array fallbacks', () => {
    const base = {
      device_id: 'device-1',
      label: 'Mac',
      hostname: 'mac.local',
      platform: 'darwin',
      status: 'online',
      last_seen_at: '2026-05-09T00:01:59.000Z',
    }

    expect(normalizeDeviceRow(base).capabilities).toEqual({ terminals: [], runtimes: [], host_runtime_capability: 0 })
    expect(normalizeDeviceRow({ ...base, capabilities: null }).capabilities).toEqual({
      terminals: [],
      runtimes: [],
      host_runtime_capability: 0,
    })
    expect(normalizeDeviceRow({
      ...base,
      capabilities: { terminals: ['tmux', 'ghostty', '', 1, 'terminal'], runtimes: ['codex', '', 2] },
    }).capabilities).toEqual({
      terminals: ['tmux', 'ghostty', 'terminal'],
      runtimes: ['codex'],
      host_runtime_capability: 0,
    })
  })

  // @@@fleet-version (#663) - app_version 透传；缺席/空串/非字符串 → 字段整个缺席（UI 显示版本未知），不伪造。
  it('passes app_version through and omits it when absent or invalid', () => {
    const base = {
      device_id: 'device-1',
      label: 'Mac',
      hostname: 'mac.local',
      platform: 'darwin',
      status: 'online',
      last_seen_at: '2026-05-09T00:01:59.000Z',
    }

    expect(
      normalizeDeviceRow({ ...base, capabilities: { app_version: '0.2.18' } }).capabilities.app_version
    ).toBe('0.2.18')
    expect(
      normalizeDeviceRow({ ...base, capabilities: { app_version: '' } }).capabilities.app_version
    ).toBeUndefined()
    expect(
      normalizeDeviceRow({ ...base, capabilities: { app_version: 42 } }).capabilities.app_version
    ).toBeUndefined()
  })

  it('keeps action summaries usable without fabricating full action documentation', () => {
    const action = {
      name: 'files.read', group: 'files', title: 'Read file', available: false,
      risk: 'low', confirm: 'never', unavailable_reason: 'not_granted', unavailable_detail: 'Enable files',
    }
    const actions = {
      v: 1, timezone: 'Asia/Shanghai', actions: [action],
      switched_off: [{ group: 'computer', detail: 'Enable the computer app' }],
    }
    const device = normalizeDeviceRow({
      device_id: 'device-1', label: 'Mac', hostname: 'fixture', platform: 'darwin', status: 'online',
      last_seen_at: '2026-10-24T00:00:00Z',
      capabilities: { terminals: ['terminal'], runtimes: ['codex'], actions },
    })
    expect(device.capabilities.actions).toEqual(actions)
    expect(device.capabilities.actions?.actions[0]).not.toHaveProperty('description')
    expect(device.capabilities.actions?.actions[0]).not.toHaveProperty('input_schema')
  })

  it('fails loudly on invalid device rows', () => {
    expect(() => normalizeDeviceRow({ device_id: 'device-1', status: 'weird' })).toThrow(
      'Invalid device status: weird'
    )
  })

  it('surfaces a missing computed field instead of retrying the full manifest query', async () => {
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: 'device_list_capabilities is not installed' } }) }) }) }),
    } as unknown as Parameters<typeof listDevices>[0]
    await expect(listDevices(client, 'owner-1')).rejects.toThrow('device_list_capabilities is not installed')
  })

  // @@@1962 列表必须按 owner 显式过滤(user_id = ownerId)——多账号同机时不混入他人 online 设备行。
  it('lists only the owner’s devices (filters by user_id) through the identity table boundary', async () => {
    let eqCalled = false
    const client = {
      from(table: 'gugu_devices') {
        expect(table).toBe('gugu_devices')
        return {
          select(columns: string) {
            expect(columns).toBe('device_id, label, hostname, platform, status, last_seen_at, capabilities:device_list_capabilities, machine_id, tier, session_digest')
            return {
              eq(column: string, value: string) {
                expect(column).toBe('user_id')       // 必须按 owner 过滤,绝不全表列举
                expect(value).toBe('owner-1')
                eqCalled = true
                return {
                  in() { throw new Error('a full list names no devices') },
                  async order(column: string, options: { ascending: boolean }) {
                    expect(column).toBe('last_seen_at')
                    expect(options).toEqual({ ascending: false })
                    return {
                      data: [
                        {
                          device_id: 'device-1',
                          label: 'Mac',
                          hostname: 'mac.local',
                          platform: 'darwin',
                          status: 'offline',
                          last_seen_at: '2026-05-09T00:00:00.000Z',
                          capabilities: { terminals: ['kitty'], runtimes: ['codex'] }
                        }
                      ],
                      error: null
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    await expect(
      listDevices(client, 'owner-1')
    ).resolves.toMatchObject([{
      device_id: 'device-1',
      is_online: false,
      capabilities: { terminals: ['kitty'], runtimes: ['codex'] },
    }])
    expect(eqCalled).toBe(true)
  })

  it('reads only the named rows of the owner when a revision names them', async () => {
    const asked: unknown[] = []
    const row = { device_id: 'device-2', label: 'B', hostname: 'b', platform: 'linux', status: 'online', last_seen_at: '2026-10-27T00:00:00.000Z', capabilities: { terminals: [], runtimes: [] } }
    const order = async () => ({ data: [row], error: null })
    const client = { from: () => ({ select: () => ({ eq: (column: string, value: string) => {
      asked.push([column, value])
      return { in: (inColumn: string, ids: readonly string[]) => { asked.push([inColumn, ids]); return { order } }, order: () => { throw new Error('must not read every row') } }
    } }) }) }
    await expect(listDevices(client, 'owner-1', { deviceIds: ['device-2'] })).resolves.toMatchObject([{ device_id: 'device-2' }])
    expect(asked).toEqual([['user_id', 'owner-1'], ['device_id', ['device-2']]])
  })

  // @@@1962 无 owner 作用域拒绝列举(fail-loud)——绝不退回全表/他人设备。
  it('refuses to list devices without an owner scope (fail-loud)', async () => {
    const client = {
      from() { throw new Error('query must not run without an owner scope') },
    } as unknown as Parameters<typeof listDevices>[0]
    await expect(listDevices(client, '')).rejects.toThrow(/ownerId/)
  })

  // #1749 rename 走 rename_device RPC（不是裸 UPDATE：心跳会覆写 label，RPC 打标记让触发器保护）。
  it('renames a device via rename_device rpc with trimmed label', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const client = {
      rpc(fn: 'rename_device' | 'remove_device', args: Record<string, unknown>) {
        calls.push({ fn, args })
        return Promise.resolve({ error: null })
      },
    }
    await renameDevice(client, 'device-1', '  我的 Mac  ')
    expect(calls).toEqual([{ fn: 'rename_device', args: { p_device_id: 'device-1', p_label: '我的 Mac' } }])
  })

  it('rejects an empty rename before hitting the rpc', async () => {
    let called = false
    const client = {
      rpc() {
        called = true
        return Promise.resolve({ error: null })
      },
    }
    await expect(renameDevice(client, 'device-1', '   ')).rejects.toThrow('设备名不能为空')
    expect(called).toBe(false)
  })

  it('removes a device via remove_device rpc (default non-cascade)', async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      rpc(_fn: 'remove_device', args: Record<string, unknown>) {
        calls.push(args)
        return Promise.resolve({ error: null })
      },
    }
    await removeDevice(client, 'device-1')
    await removeDevice(client, 'device-2', { cascade: true })
    expect(calls).toEqual([
      { p_device_id: 'device-1', p_cascade: false },
      { p_device_id: 'device-2', p_cascade: true },
    ])
  })

  it('propagates rpc errors fail-loud and recognizes the has-agents sentinel', async () => {
    const client = {
      rpc() {
        return Promise.resolve({ error: { message: 'DEVICE_HAS_AGENTS: 3 agent(s) bound to this device' } })
      },
    }
    await expect(removeDevice(client, 'device-1')).rejects.toThrow('DEVICE_HAS_AGENTS')
    expect(isDeviceHasAgentsError('DEVICE_HAS_AGENTS: 3 agent(s) bound to this device')).toBe(true)
    expect(isDeviceHasAgentsError('some other error')).toBe(false)
  })
})

describe('#6264 adoptDeviceName:库取的默认名换成人给的名字,人改过的不动', () => {
  const clientFor = (row: unknown) => {
    const renames: unknown[] = []
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        renames.push(args)
        return { error: null }
      },
    } as unknown as DeviceLabelClient
    return { client, renames }
  }

  it('isDerivedDeviceLabel 只认库的派生名', () => {
    expect(['Linux 2', 'Mac 1', 'Windows 3', 'Device 1'].every(isDerivedDeviceLabel)).toBe(true)
    expect(['d22', 'Linux', 'My Linux 2', 'Linux 2 box'].some(isDerivedDeviceLabel)).toBe(false)
  })

  it.each([
    ['默认名、没改过 ⇒ 改', { label: 'Linux 2', label_customized_at: null }, true],
    ['人改过 ⇒ 不动', { label: 'Linux 2', label_customized_at: '2026-09-01T00:00:00Z' }, false],
    ['已经是别的名字 ⇒ 不动', { label: 'gpu-box', label_customized_at: null }, false],
    ['还没有这一行 ⇒ 不动(第一次心跳自己带名字)', null, false],
  ] as const)('%s', async (_name, row, expected) => {
    const { client, renames } = clientFor(row)
    expect(await adoptDeviceName(client, 'dev-1', 'd22')).toBe(expected)
    expect(renames).toEqual(expected ? [{ p_device_id: 'dev-1', p_label: 'd22' }] : [])
  })
})
