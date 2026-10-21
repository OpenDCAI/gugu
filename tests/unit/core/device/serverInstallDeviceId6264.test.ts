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

const { deterministicDeviceId, resolveLocalDeviceId, SERVER_INSTALL_ID_FILE } = await import(
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
      select: () => ({ eq: () => ({ eq: (_c: string, machineId: string) => chain(machineId) }) }),
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
