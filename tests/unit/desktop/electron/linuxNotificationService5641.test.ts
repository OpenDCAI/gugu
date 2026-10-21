import { describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATION_BUS_NAME,
  createNotificationGate,
  decodeMessage,
  encodeMethodCall,
  externalAuthLine,
  resolveSessionBusPath,
} from '../../../../apps/desktop/electron/linux-notification-service'

/**
 * 这串字节是真会话总线接受过的 `Hello` 调用(d15 实测:发出去之后总线回了 METHOD_RETURN
 * 并分配了 unique name)。拿它当 golden,测的就是真协议,而不是"我以为的协议"。
 */
const REAL_HELLO_HEX = [
  '6c 01 00 01 00 00 00 00 01 00 00 00 6e 00 00 00',
  '01 01 6f 00 15 00 00 00 2f 6f 72 67 2f 66 72 65',
  '65 64 65 73 6b 74 6f 70 2f 44 42 75 73 00 00 00',
  '06 01 73 00 14 00 00 00 6f 72 67 2e 66 72 65 65',
  '64 65 73 6b 74 6f 70 2e 44 42 75 73 00 00 00 00',
  '02 01 73 00 14 00 00 00 6f 72 67 2e 66 72 65 65',
  '64 65 73 6b 74 6f 70 2e 44 42 75 73 00 00 00 00',
  '03 01 73 00 05 00 00 00 48 65 6c 6c 6f 00 00 00',
].join(' ')

const helloCall = (): Buffer =>
  encodeMethodCall({
    serial: 1,
    path: '/org/freedesktop/DBus',
    iface: 'org.freedesktop.DBus',
    member: 'Hello',
    destination: 'org.freedesktop.DBus',
  })

const nameHasOwnerCall = (): Buffer =>
  encodeMethodCall({
    serial: 2,
    path: '/org/freedesktop/DBus',
    iface: 'org.freedesktop.DBus',
    member: 'NameHasOwner',
    destination: 'org.freedesktop.DBus',
    stringArgument: NOTIFICATION_BUS_NAME,
  })

describe('@@@5641 D-Bus 消息编码', () => {
  it('Hello 调用与真总线接受过的字节逐字节一致', () => {
    const hex = helloCall().toString('hex').replace(/(..)(?=.)/g, '$1 ')
    expect(hex).toBe(REAL_HELLO_HEX)
  })

  it('SIGNATURE 头字段用 1 字节长度前缀,不是字符串的 4 字节前缀', () => {
    // 这正是最初写错、导致总线直接断连的地方:code 8 之后应是 g(0x67) 的变体,
    // 再接 1 字节长度 0x01 + 's'(0x73) + NUL,而不是 4 字节长度。
    const bytes = nameHasOwnerCall()
    const marker = Buffer.from([0x08, 0x01, 0x67, 0x00, 0x01, 0x73, 0x00])
    expect(bytes.includes(marker)).toBe(true)
  })

  it('带参数调用的 body 长度与实际负载吻合', () => {
    const bytes = nameHasOwnerCall()
    const bodyLength = bytes.readUInt32LE(4)
    // STRING = 4 字节长度 + 内容 + NUL
    expect(bodyLength).toBe(4 + Buffer.byteLength(NOTIFICATION_BUS_NAME) + 1)
  })
})

describe('@@@5641 D-Bus 消息解码', () => {
  it('字节不全时返回 null,等下一批而不是瞎解', () => {
    const full = helloCall()
    expect(decodeMessage(full.subarray(0, 8))).toBeNull()
    expect(decodeMessage(full.subarray(0, full.length - 1))).toBeNull()
  })

  it('能把自己编的消息解回来,并报出正确的总长度', () => {
    const bytes = nameHasOwnerCall()
    const decoded = decodeMessage(bytes)
    expect(decoded).not.toBeNull()
    expect(decoded?.type).toBe(1)
    expect(decoded?.serial).toBe(2)
    expect(decoded?.signature).toBe('s')
    expect(decoded?.byteLength).toBe(bytes.length)
  })

  it('一个缓冲区里连着两条消息时,按长度切得开', () => {
    const joined = Buffer.concat([helloCall(), nameHasOwnerCall()])
    const first = decodeMessage(joined)
    expect(first?.serial).toBe(1)
    const second = decodeMessage(joined.subarray(first!.byteLength))
    expect(second?.serial).toBe(2)
  })
})

describe('@@@5641 会话总线地址解析', () => {
  it('取 unix:path=', () => {
    expect(resolveSessionBusPath('unix:path=/run/user/0/bus,guid=abc', 0)).toBe('/run/user/0/bus')
  })

  it('抽象命名空间转成 Node 认的 NUL 前缀路径', () => {
    expect(resolveSessionBusPath('unix:abstract=/tmp/dbus-xyz,guid=abc', 0)).toBe('\0/tmp/dbus-xyz')
  })

  it('多个候选地址时取第一个 unix 的', () => {
    expect(resolveSessionBusPath('tcp:host=127.0.0.1,port=1;unix:path=/run/user/1000/bus', 1000))
      .toBe('/run/user/1000/bus')
  })

  it('环境变量缺失时退到规范规定的默认位置', () => {
    expect(resolveSessionBusPath(undefined, 1000)).toBe('/run/user/1000/bus')
  })

  it('地址完全没给才用默认位置,空串同理', () => {
    expect(resolveSessionBusPath('', 1000)).toBe('/run/user/1000/bus')
    expect(resolveSessionBusPath('   ', 1000)).toBe('/run/user/1000/bus')
  })

  it('❌ 地址给了却没有 unix 传输时不猜默认路径 —— 那是另一条总线', () => {
    expect(resolveSessionBusPath('tcp:host=127.0.0.1,port=55555', 1000)).toBeNull()
  })

  it('EXTERNAL 认证把 uid 的十进制写法再 hex 一次', () => {
    expect(externalAuthLine(0)).toBe('AUTH EXTERNAL 30\r\n')
    expect(externalAuthLine(1000)).toBe('AUTH EXTERNAL 31303030\r\n')
  })
})

describe('@@@5641 通知可用性门控', () => {
  const deps = (over: Partial<Parameters<typeof createNotificationGate>[0]> = {}) => ({
    platform: 'linux' as NodeJS.Platform,
    isSupported: vi.fn(() => true),
    probe: vi.fn(async () => true),
    ...over,
  })

  it('非 Linux 平台不探测,直接问 Electron', async () => {
    const d = deps({ platform: 'darwin' })
    await expect(createNotificationGate(d).usable()).resolves.toBe(true)
    expect(d.probe).not.toHaveBeenCalled()
    expect(d.isSupported).toHaveBeenCalledTimes(1)
  })

  it('Linux 上探测为假时不碰同步 API —— 这正是会冻住主线程的那条路', async () => {
    const onUnavailable = vi.fn()
    const d = deps({ probe: vi.fn(async () => false), onUnavailable })
    await expect(createNotificationGate(d).usable()).resolves.toBe(false)
    expect(d.isSupported).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })

  it('探测抛错按不可用处理,并留下日志,❌ 不静默吞掉', async () => {
    const onUnavailable = vi.fn()
    const d = deps({ probe: vi.fn(async () => { throw new Error('总线没应答') }), onUnavailable })
    await expect(createNotificationGate(d).usable()).resolves.toBe(false)
    expect(d.isSupported).not.toHaveBeenCalled()
    expect(onUnavailable.mock.calls[0]?.[0]).toContain('总线没应答')
  })

  it('热路径上连续调用只探一次(缓存)', async () => {
    const d = deps()
    const gate = createNotificationGate({ ...d, now: () => 1000 })
    await Promise.all([gate.usable(), gate.usable(), gate.usable()])
    await gate.usable()
    expect(d.probe).toHaveBeenCalledTimes(1)
  })

  it('并发进来只飞一次探测(单飞)', async () => {
    let release: (v: boolean) => void = () => {}
    const probe = vi.fn(() => new Promise<boolean>((r) => { release = r }))
    const gate = createNotificationGate(deps({ probe }))
    const all = Promise.all([gate.usable(), gate.usable(), gate.usable()])
    release(true)
    await expect(all).resolves.toEqual([true, true, true])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('缓存过期后重探 —— 守护进程可能中途起来或退出', async () => {
    const d = deps()
    let clock = 0
    const gate = createNotificationGate({ ...d, now: () => clock, cacheTtlMs: 100 })
    await gate.usable()
    clock = 50
    await gate.usable()
    expect(d.probe).toHaveBeenCalledTimes(1)
    clock = 200
    await gate.usable()
    expect(d.probe).toHaveBeenCalledTimes(2)
  })
})
