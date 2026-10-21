// #6264 — Docker 容器 / 精简发行版没有 /etc/machine-id 也没有 dbus 那份:设备身份要退到咕咕自己发的那个,
// 而且同一台机器只能发一次(重启、两个进程同时首跑都拿到同一个值),否则每次心跳 ENOENT、设备永远上不了线。
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const systemIds = new Map<string, string>()
/** 本例的咕咕状态目录:这底下的 writeFile 都拉开「建出文件 → 写进内容」那段窗口,与真盘一样不是一步到位。 */
let slowWritesUnder = ''

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFileMock = (path: unknown, options?: unknown) => {
    if (path === '/etc/machine-id' || path === '/var/lib/dbus/machine-id') {
      const value = systemIds.get(path)
      if (value === undefined) return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }))
      return Promise.resolve(value)
    }
    return (actual.readFile as (p: unknown, o?: unknown) => Promise<unknown>)(path, options)
  }
  // 真 writeFile 先建文件(flag 照用,'wx' 抢输照样 EEXIST)、再写内容;这里把两步之间拉开 20 ms,
  // 让「读到建出来还没写的空文件」这种并发首跑在每一轮都发生,❌ 靠 CI 负载碰运气。
  const writeFileMock = async (path: unknown, data: unknown, options?: unknown) => {
    const write = actual.writeFile as (p: unknown, d: unknown, o?: unknown) => Promise<void>
    if (!slowWritesUnder || typeof path !== 'string' || !path.startsWith(slowWritesUnder)) return write(path, data, options)
    await write(path, '', options)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write(path, data, { ...(typeof options === 'object' && options ? options : {}), flag: 'w' })
  }
  return { ...actual, readFile: readFileMock, writeFile: writeFileMock }
})

const { machineHardwareIdentifier } = await import('@gugu/core/cloud/deviceRuntime')

const originalGuguHome = process.env.GUGU_HOME
let guguHome = ''
beforeEach(async () => {
  systemIds.clear()
  guguHome = await mkdtemp(join(tmpdir(), 'gugu-machine-id-6264-'))
  process.env.GUGU_HOME = guguHome
  slowWritesUnder = guguHome
})
afterEach(() => {
  if (originalGuguHome === undefined) delete process.env.GUGU_HOME
  else process.env.GUGU_HOME = originalGuguHome
})

const signal = () => new AbortController().signal

test('系统 machine-id 在时照旧用它', async () => {
  systemIds.set('/etc/machine-id', 'abc123\n')
  expect(await machineHardwareIdentifier(signal())).toBe('abc123')
})

test('只有 dbus 那份时用 dbus 那份', async () => {
  systemIds.set('/var/lib/dbus/machine-id', 'dbus456\n')
  expect(await machineHardwareIdentifier(signal())).toBe('dbus456')
})

test('两份都没有:发一个、落盘、之后一直是它', async () => {
  const first = await machineHardwareIdentifier(signal())
  expect(first).toMatch(/^[0-9a-f]{32}$/)
  expect((await readFile(join(guguHome, 'machine-id'), 'utf8')).trim()).toBe(first)
  expect(await machineHardwareIdentifier(signal())).toBe(first)
})

test('并发首跑只发一个身份,抢输的一方 ❌ 读到写了一半的文件', async () => {
  const ids = await Promise.all(Array.from({ length: 8 }, () => machineHardwareIdentifier(signal())))
  expect(new Set(ids).size).toBe(1)
  expect(ids[0]).toMatch(/^[0-9a-f]{32}$/)
  // 临时文件都收掉了:状态目录里只剩那一份。
  expect((await readdir(guguHome)).filter((name) => name.startsWith('machine-id'))).toEqual(['machine-id'])
})

test('改前竞态留下的空文件当作没有:发一个新的、写进去,❌ 每次都抛「文件是空的」', async () => {
  await writeFile(join(guguHome, 'machine-id'), '')
  const id = await machineHardwareIdentifier(signal())
  expect(id).toMatch(/^[0-9a-f]{32}$/)
  expect((await readFile(join(guguHome, 'machine-id'), 'utf8')).trim()).toBe(id)
  expect(await machineHardwareIdentifier(signal())).toBe(id)
})
