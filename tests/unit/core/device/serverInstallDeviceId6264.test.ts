// #6264 — 咕咕 server 的设备 id 不能按 /etc/machine-id 认机器:同一镜像起的容器、克隆的虚拟机 machine-id
// 一模一样,好几台 server 会在云端并成同一行。server 改为「一次安装 = 一台机器」;桌面一个字节都不许变。
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'

const SHARED_MACHINE_ID = 'b696bd17shared'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFileMock = (path: unknown, options?: unknown) => {
    if (path === '/etc/machine-id') return Promise.resolve(`${SHARED_MACHINE_ID}\n`)
    return (actual.readFile as (p: unknown, o?: unknown) => Promise<unknown>)(path, options)
  }
  return { ...actual, readFile: readFileMock }
})

const { deterministicDeviceId, resolveLocalDeviceId, syncDeviceHeartbeat, SERVER_INSTALL_ID_FILE } = await import(
  '@gugu/core/cloud/deviceRuntime'
)
type HeartbeatClient = Parameters<typeof resolveLocalDeviceId>[0]['heartbeatClient']

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'

/** 云端还没有任何设备行(新装机)。记下每次按哪个 machine_id 查的。 */
function emptyCloud(lookups: string[] = []): HeartbeatClient {
  const chain = (machineId: string) => ({
    eq: () => ({
      limit: () => ({
        maybeSingle: async () => {
          lookups.push(machineId)
          return { data: null, error: null }
        },
      }),
    }),
  })
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: (_c: string, machineId: string) => ({ ...chain(machineId), order: () => chain(machineId).eq() }) }) }),
      upsert: async () => ({ error: null }),
    }),
    rpc: async () => ({ error: null }),
  } as unknown as HeartbeatClient
}

const noCache = async () => {}
let guguHome = ''
beforeEach(async () => {
  guguHome = await mkdtemp(join(tmpdir(), 'gugu-desktop-home-6264-'))
})

async function serverEnv(): Promise<NodeJS.ProcessEnv> {
  const serverHome = await mkdtemp(join(tmpdir(), 'gugu-server-home-6264-'))
  return { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: serverHome, GUGU_HOME: join(serverHome, 'accounts', USER_A, 'home') }
}

const resolve = (env: NodeJS.ProcessEnv, userId = USER_A, lookups?: string[]) =>
  resolveLocalDeviceId({ env, userId, heartbeatClient: emptyCloud(lookups), deviceIdCacheWriter: noCache })

test('桌面的设备 id 公式不变(金值:改动前的算法算出来的)', () => {
  expect(deterministicDeviceId(SHARED_MACHINE_ID, USER_A)).toBe('90853ad3-5b9e-437e-8e45-350cc9a5f67f')
  expect(deterministicDeviceId(SHARED_MACHINE_ID, USER_A, 'beta')).toBe('87a95959-0ad2-4890-853f-e427596f3a37')
})

test('桌面(含 Linux 桌面)照旧按 /etc/machine-id 认机器', async () => {
  const lookups: string[] = []
  const id = await resolve({ GUGU_HOME: guguHome }, USER_A, lookups)
  expect(id).toBe('90853ad3-5b9e-437e-8e45-350cc9a5f67f')
  expect(lookups).toEqual([SHARED_MACHINE_ID])
})

test('两次安装共用同一个 /etc/machine-id,设备 id 也不同', async () => {
  const [a, b] = await Promise.all([serverEnv(), serverEnv()])
  const idA = await resolve(a)
  const idB = await resolve(b)
  expect(idA).not.toBe(idB)
  // 也不会撞上同一台机器上的桌面
  expect(idA).not.toBe(deterministicDeviceId(SHARED_MACHINE_ID, USER_A))
  expect(idB).not.toBe(deterministicDeviceId(SHARED_MACHINE_ID, USER_A))
})

test('云端按安装 id 查「这台机器这个人」的旧行,不按 /etc/machine-id', async () => {
  const env = await serverEnv()
  const lookups: string[] = []
  await resolve(env, USER_A, lookups)
  const installId = (await readFile(join(env.GUGU_SERVER_HOME!, SERVER_INSTALL_ID_FILE), 'utf8')).trim()
  expect(installId).toMatch(/^[0-9a-f]{32}$/)
  expect(lookups).toEqual([installId])
})

test('同一次安装:重启(换一个进程环境对象、换账号目录)后设备 id 不变', async () => {
  const env = await serverEnv()
  const first = await resolve(env)
  const restarted = { ...env, GUGU_HOME: join(env.GUGU_SERVER_HOME!, 'accounts', USER_A, 'home') }
  expect(await resolve(restarted)).toBe(first)
  const installId = (await readFile(join(env.GUGU_SERVER_HOME!, SERVER_INSTALL_ID_FILE), 'utf8')).trim()
  expect(first).toBe(deterministicDeviceId(installId, USER_A, 'production'))
})

test('同一次安装里两个账号:共用安装 id,设备 id 各不相同', async () => {
  const env = await serverEnv()
  const lookups: string[] = []
  const idA = await resolve(env, USER_A, lookups)
  const idB = await resolve({ ...env, GUGU_HOME: join(env.GUGU_SERVER_HOME!, 'accounts', USER_B, 'home') }, USER_B, lookups)
  expect(idA).not.toBe(idB)
  expect(new Set(lookups).size).toBe(1)
})

test('并发首跑(登录与账号进程同时)只发一个安装 id', async () => {
  const env = await serverEnv()
  const ids = await Promise.all(Array.from({ length: 8 }, () => resolve({ ...env })))
  expect(new Set(ids).size).toBe(1)
})

test('server 模式却没有安装目录:直接报错,不悄悄退回硬件标识', async () => {
  await expect(resolve({ GUGU_SERVER_MODE: '1', GUGU_HOME: guguHome })).rejects.toThrow(/GUGU_SERVER_HOME/)
})

// #1005 — 账号进程跟着桌面在 beta / 正式版之间换构建:同一个 server 账号目录 ❌ 因 tier 换一行设备,
// 否则它托管的 agent 还绑在旧行上,云端按设备核对的写入(归档同步)永远 42501。
type Row = { device_id: string; user_id: string; machine_id: string; tier: string; last_seen_at: string }
function cloudTable(rows: Row[], writes: Record<string, unknown>[] = []): HeartbeatClient {
  const lookup = (match: (row: Row) => boolean, newestFirst: boolean) => ({
    limit: () => ({
      maybeSingle: async () => {
        const found = rows.filter(match).sort((a, b) => newestFirst ? b.last_seen_at.localeCompare(a.last_seen_at) : 0)[0]
        return { data: found ? { device_id: found.device_id } : null, error: null }
      },
    }),
  })
  return {
    from: () => ({
      select: () => ({ eq: (_u: string, userId: string) => ({ eq: (_m: string, machineId: string) => {
        const mine = (row: Row) => row.user_id === userId && row.machine_id === machineId
        return { eq: (_t: string, tier: string) => lookup((row) => mine(row) && row.tier === tier, false), order: () => lookup(mine, true) }
      } }) }),
      upsert: async (value: Record<string, unknown>) => {
        writes.push(value)
        const row = rows.find((r) => r.device_id === value.device_id)
        if (row) Object.assign(row, value)
        else rows.push({ tier: 'production', ...(value as Omit<Row, 'tier'>) })
        return { error: null }
      },
    }),
    rpc: async () => ({ error: null }),
  } as unknown as HeartbeatClient
}

async function heartbeat(env: NodeJS.ProcessEnv, client: HeartbeatClient): Promise<string> {
  const deviceId = await resolveLocalDeviceId({ env, userId: USER_A, heartbeatClient: client, deviceIdCacheWriter: noCache })
  await syncDeviceHeartbeat(client, { userId: USER_A, deviceId, capabilities: { terminals: [], runtimes: [] }, hostInfo: () => ({}) as never,
    nowIso: () => new Date().toISOString() }, env)
  return deviceId
}

test('同一个 server 账号目录在 beta 与正式版之间来回换构建:设备 id 不变,心跳不改行的 tier', async () => {
  const env = await serverEnv()
  const rows: Row[] = []
  const writes: Record<string, unknown>[] = []
  const client = cloudTable(rows, writes)
  const first = await heartbeat({ ...env, GUGU_TIER: 'beta' }, client)
  for (const tier of ['production', 'beta', 'production']) {
    expect(await heartbeat({ ...env, GUGU_TIER: tier }, client)).toBe(first)
  }
  expect(rows.map((row) => row.device_id)).toEqual([first])
  expect(writes.every((write) => !('tier' in write))).toBe(true)
})

test('已经因换构建分成两行的 server 账号目录:留在正在用的那行,不管现在是哪个 tier', async () => {
  const env = await serverEnv()
  await resolve(env)
  const machineId = (await readFile(join(env.GUGU_SERVER_HOME!, SERVER_INSTALL_ID_FILE), 'utf8')).trim()
  const rows: Row[] = [
    { device_id: 'old-beta', user_id: USER_A, machine_id: machineId, tier: 'beta', last_seen_at: '2026-10-29T13:33:54Z' },
    { device_id: 'in-use', user_id: USER_A, machine_id: machineId, tier: 'production', last_seen_at: '2026-10-30T02:15:13Z' },
  ]
  for (const tier of ['beta', 'production']) {
    expect(await heartbeat({ ...env, GUGU_TIER: tier }, cloudTable(rows))).toBe('in-use')
  }
  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.tier)).toEqual(['beta', 'production'])
})

test('同一个账号在同一台机器上的两个 server 安装:各是各的设备,不并成一行', async () => {
  const rows: Row[] = []
  const client = cloudTable(rows)
  const [a, b] = await Promise.all([serverEnv(), serverEnv()])
  const idA = await heartbeat({ ...a, GUGU_TIER: 'beta' }, client)
  const idB = await heartbeat({ ...b, GUGU_TIER: 'beta' }, client)
  expect(idA).not.toBe(idB)
  expect(await heartbeat({ ...a, GUGU_TIER: 'production' }, client)).toBe(idA)
  expect(rows).toHaveLength(2)
})

test('桌面各 tier 仍是各自的设备(各有各的目录)', async () => {
  const rows: Row[] = []
  const client = cloudTable(rows)
  const beta = await heartbeat({ GUGU_HOME: guguHome, GUGU_TIER: 'beta' }, client)
  const stable = await heartbeat({ GUGU_HOME: guguHome }, client)
  expect(beta).not.toBe(stable)
  expect(rows.map((row) => row.tier).sort()).toEqual(['beta', 'production'])
})
