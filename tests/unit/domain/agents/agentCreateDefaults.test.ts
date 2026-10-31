import { describe, expect, it } from 'vitest'
import {
  readAgentCreateDefaults,
  rememberAgentCreateDevice,
  rememberAgentCreateProject
} from '@gugu/core/cloud/agentCreateDefaults'
import {
  agentCreateDeviceBlockMessage,
  parseAgentCreateDefaults,
  resolveAgentCreateDevice,
  resolveAgentCreateProject,
  EMPTY_AGENT_CREATE_DEFAULTS,
  type AgentCreateDefaults
} from '@gugu/core/shared/ui/agentCreateDefaultsModels'
import type { Device } from '@gugu/core/shared/types/chat'
import { fakeSettingsClient } from '../../../support/userSettingsTestDouble'

// #2525 「设备/项目默认值记忆」。规范：首次默认本机 / 记住最近一次选择 / 已记忆设备离线不得静默
// 回落 / 项目列表按设备过滤。这些规则全在 core 的纯函数里，所以这里就是它们的合同测试。

function device(overrides: Partial<Device> & { device_id: string }): Device {
  return {
    label: overrides.device_id,
    hostname: 'host',
    platform: 'darwin',
    status: 'online',
    last_seen_at: '2026-07-30T00:00:00.000Z',
    is_online: true,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 1 },
    ...overrides
  }
}

const LOCAL = device({ device_id: 'dev-local', label: '本机 Mac', is_current_device: true })
const REMOTE_ONLINE = device({ device_id: 'dev-studio', label: 'Mac Studio', is_current_device: false })
const REMOTE_OFFLINE = device({
  device_id: 'dev-studio',
  label: 'Mac Studio',
  is_current_device: false,
  status: 'offline',
  is_online: false
})

function defaults(overrides: Partial<AgentCreateDefaults> = {}): AgentCreateDefaults {
  return { deviceId: null, projectByDevice: {}, projectByChat: {}, ...overrides }
}

describe('agent create defaults — 存储格式', () => {
  it('把读不懂的配置当作"没有记忆"，而不是猜一个出来', () => {
    expect(parseAgentCreateDefaults(null)).toEqual(EMPTY_AGENT_CREATE_DEFAULTS)
    expect(parseAgentCreateDefaults('nonsense')).toEqual(EMPTY_AGENT_CREATE_DEFAULTS)
    expect(parseAgentCreateDefaults({})).toEqual(EMPTY_AGENT_CREATE_DEFAULTS)
    expect(parseAgentCreateDefaults({ agent_create: [] })).toEqual(EMPTY_AGENT_CREATE_DEFAULTS)
    // 空串/非字符串的 device_id 不算一次选择
    expect(parseAgentCreateDefaults({ agent_create: { device_id: '  ' } }).deviceId).toBeNull()
    expect(parseAgentCreateDefaults({ agent_create: { device_id: 7 } }).deviceId).toBeNull()
  })

  it('解析出设备与按设备分桶的项目，丢掉脏条目', () => {
    expect(
      parseAgentCreateDefaults({
        agent_create: {
          device_id: 'dev-studio',
          project_by_device: { 'dev-local': 'proj-a', 'dev-studio': 42, 'dev-x': '' }
        }
      })
    ).toEqual({ deviceId: 'dev-studio', projectByDevice: { 'dev-local': 'proj-a' }, projectByChat: {} })
  })
})

describe('agent create defaults — 设备解析', () => {
  it('①首次创建默认本机（且首次不写库：deviceId 仍为 null）', () => {
    const resolution = resolveAgentCreateDevice(defaults(), [REMOTE_ONLINE, LOCAL])
    expect(resolution).toEqual({ kind: 'ready', device: LOCAL })
    expect(agentCreateDeviceBlockMessage(resolution)).toBeNull()
  })

  it('②记住最近一次选择：记忆命中就用它，不再回到本机', () => {
    const resolution = resolveAgentCreateDevice(defaults({ deviceId: 'dev-studio' }), [
      LOCAL,
      REMOTE_ONLINE
    ])
    expect(resolution.kind).toBe('blocked')
    expect(resolution).toMatchObject({ device: { device_id: 'dev-studio' } })
  })

  it('③记忆的设备离线 → 返回**那台离线设备**并阻止提交，❌ 不静默换成本机', () => {
    const resolution = resolveAgentCreateDevice(defaults({ deviceId: 'dev-studio' }), [
      LOCAL,
      REMOTE_OFFLINE
    ])
    expect(resolution).toEqual({ kind: 'blocked', device: REMOTE_OFFLINE, reason: 'offline' })
    const message = agentCreateDeviceBlockMessage(resolution)
    // 文案必须点名那台设备并给出下一步，❌ 不许只说"失败"
    expect(message).not.toBeNull()
    expect(message ?? '').toContain('Mac Studio')
    expect(message ?? '').toContain('离线')
    expect(message ?? '').toContain('改选')
  })

  it('在线但非本机 → 明确挡住（跨设备创建属另一条车道），❌ 不偷偷在本机建', () => {
    const resolution = resolveAgentCreateDevice(defaults({ deviceId: 'dev-studio' }), [
      LOCAL,
      REMOTE_ONLINE
    ])
    expect(resolution).toEqual({ kind: 'blocked', device: REMOTE_ONLINE, reason: 'remote' })
    expect(agentCreateDeviceBlockMessage(resolution) ?? '').toContain('Mac Studio')
  })

  it('记忆的设备在这里选不到了 → 就是「还没选」：不报错、不露设备 id，❌ 不静默换一台', () => {
    const resolution = resolveAgentCreateDevice(defaults({ deviceId: 'dev-gone' }), [LOCAL])
    expect(resolution).toEqual({ kind: 'missing', deviceId: 'dev-gone' })
    expect(agentCreateDeviceBlockMessage(resolution)).toBeNull()
  })

  it('没有任何设备 / 没有本机时不编造一个默认值', () => {
    expect(resolveAgentCreateDevice(defaults(), [])).toEqual({ kind: 'none' })
    expect(resolveAgentCreateDevice(defaults(), [REMOTE_ONLINE])).toEqual({ kind: 'none' })
    expect(agentCreateDeviceBlockMessage({ kind: 'none' }) ?? '').toContain('没有可用设备')
  })

  it('本机自己离线（心跳过期）也照实挡住，不因为"是本机"就放行', () => {
    const staleLocal = device({
      device_id: 'dev-local',
      label: '本机 Mac',
      is_current_device: true,
      status: 'offline',
      is_online: false
    })
    expect(resolveAgentCreateDevice(defaults(), [staleLocal])).toEqual({
      kind: 'blocked',
      device: staleLocal,
      reason: 'offline'
    })
  })
})

describe('agent create defaults — 项目解析（按设备过滤）', () => {
  const remembered = defaults({
    deviceId: 'dev-local',
    projectByDevice: { 'dev-local': 'proj-a', 'dev-studio': 'proj-b' }
  })

  it('记忆命中所选设备的可用列表 → 沿用', () => {
    expect(resolveAgentCreateProject(remembered, 'dev-local', ['proj-a', 'proj-c'])).toBe('proj-a')
  })

  it('切换设备后旧项目不在新设备的列表里 → 清空为「未选择项目」，❌ 不回落到列表第一个', () => {
    expect(resolveAgentCreateProject(remembered, 'dev-local', ['proj-c', 'proj-d'])).toBeNull()
  })

  it('项目记忆按设备分桶，不串台', () => {
    expect(resolveAgentCreateProject(remembered, 'dev-studio', ['proj-a'])).toBeNull()
    expect(resolveAgentCreateProject(remembered, 'dev-studio', ['proj-b'])).toBe('proj-b')
  })

  it('没有设备 / 该设备没记过项目 → 未选择项目', () => {
    expect(resolveAgentCreateProject(remembered, null, ['proj-a'])).toBeNull()
    expect(resolveAgentCreateProject(remembered, 'dev-new', ['proj-a'])).toBeNull()
  })
})

describe('agent create defaults — per-user 持久化', () => {
  it('没有行时读成"没有记忆"', async () => {
    const fake = fakeSettingsClient()
    await expect(readAgentCreateDefaults(fake.client, 'user-1')).resolves.toEqual(
      EMPTY_AGENT_CREATE_DEFAULTS
    )
  })

  it('设备选择写进 scope=user，且**不带 device 维度**——记忆跟着账号走，不跟着这台机器走', async () => {
    const fake = fakeSettingsClient()
    await rememberAgentCreateDevice(fake.client, 'user-1', 'dev-studio')
    expect(fake.upserts).toHaveLength(1)
    expect(fake.upserts[0]).toMatchObject({ user_id: 'user-1', scope: 'user' })
    expect(fake.rows['user-1::user']).toEqual({
      agent_create: { device_id: 'dev-studio', project_by_device: {}, project_by_chat: {} }
    })
    // 同一账号在另一个客户端读回来的就是这一份
    await expect(readAgentCreateDefaults(fake.client, 'user-1')).resolves.toEqual({
      deviceId: 'dev-studio',
      projectByDevice: {},
      projectByChat: {}
    })
  })

  it('再次切换覆盖旧默认值，且不动已记住的项目分桶', async () => {
    const fake = fakeSettingsClient({
      'user-1::user': {
        agent_create: { device_id: 'dev-local', project_by_device: { 'dev-local': 'proj-a' } }
      }
    })
    await expect(rememberAgentCreateDevice(fake.client, 'user-1', 'dev-studio')).resolves.toEqual({
      deviceId: 'dev-studio',
      projectByDevice: { 'dev-local': 'proj-a' },
      projectByChat: {}
    })
  })

  it('项目选择按设备分桶写入；选「不使用项目」清掉该设备的桶', async () => {
    const fake = fakeSettingsClient()
    await rememberAgentCreateProject(fake.client, 'user-1', 'dev-local', 'proj-a')
    await rememberAgentCreateProject(fake.client, 'user-1', 'dev-studio', 'proj-b')
    expect(fake.rows['user-1::user']).toEqual({
      agent_create: {
        device_id: null,
        project_by_device: { 'dev-local': 'proj-a', 'dev-studio': 'proj-b' },
        project_by_chat: {}
      }
    })
    await expect(
      rememberAgentCreateProject(fake.client, 'user-1', 'dev-local', null)
    ).resolves.toEqual({ deviceId: null, projectByDevice: { 'dev-studio': 'proj-b' }, projectByChat: {} })
  })

  it('gugu-dev#181 在一个对话里选的项目记成这个对话的,也是最近一次选的;别的对话回落到最近一次', async () => {
    const fake = fakeSettingsClient()
    await rememberAgentCreateProject(fake.client, 'user-1', 'dev-local', 'proj-a', 'chat-design')
    const read = await rememberAgentCreateProject(fake.client, 'user-1', 'dev-local', 'proj-b', 'chat-ops')
    expect(read.projectByChat).toEqual({
      'chat-design': { deviceId: 'dev-local', projectId: 'proj-a' },
      'chat-ops': { deviceId: 'dev-local', projectId: 'proj-b' },
    })
    const available = ['proj-a', 'proj-b']
    expect(resolveAgentCreateProject(read, 'dev-local', available, 'chat-design')).toBe('proj-a')
    expect(resolveAgentCreateProject(read, 'dev-local', available, 'chat-new')).toBe('proj-b')
    // 记的是另一台设备上的项目:这台设备上回落到最近一次
    expect(resolveAgentCreateProject(read, 'dev-studio', ['proj-a'], 'chat-design')).toBeNull()
    await expect(readAgentCreateDefaults(fake.client, 'user-1')).resolves.toEqual(read)
  })

  it('不吞掉 user scope 下无关的键', async () => {
    const fake = fakeSettingsClient({ 'user-1::user': { unrelated: 'keep-me' } })
    await rememberAgentCreateDevice(fake.client, 'user-1', 'dev-local')
    expect(fake.rows['user-1::user']).toMatchObject({ unrelated: 'keep-me' })
  })

  it('两个不同账号的记忆互不可见', async () => {
    const fake = fakeSettingsClient()
    await rememberAgentCreateDevice(fake.client, 'user-1', 'dev-studio')
    await expect(readAgentCreateDefaults(fake.client, 'user-2')).resolves.toEqual(
      EMPTY_AGENT_CREATE_DEFAULTS
    )
  })
})
