import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ports = vi.hoisted(() => ({
  open: vi.fn(),
  release: vi.fn(async () => ({ success: true })),
}))

vi.mock('@renderer/lib/ipc', () => ({ rpc: { remotePorts: ports, cloudBrowser: {} } }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { sessionHost: true } } }))
vi.mock('../../../../apps/desktop/src/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))

import { CloudBrowserLink } from '../../../../apps/desktop/src/lib/cloudBrowser'

/** 只记下开了哪些连接、谁被关了;open / close 由测试手动触发。 */
class FakeSocket {
  static readonly OPEN = 1
  static all: FakeSocket[] = []
  readonly OPEN = 1
  readyState = 0
  bufferedAmount = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send() {}
  close() {
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

/** #7199 云浏览器的实时连接:重连 / 销毁和还在路上的那次连接撞上时,❌ 两条连接同时开着、❌ 端口转发漏还。 */
describe('#7199 cloud browser link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.all = []
    vi.stubGlobal('WebSocket', FakeSocket)
    ports.open.mockReset()
    ports.release.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function link(states: string[] = []) {
    return new CloudBrowserLink('device-1', async () => ({ port: 4321, token: 't' }), {
      onMessage: () => {},
      onState: (state) => states.push(state),
    })
  }

  it('端口转发还在开的时候销毁:转发回来就当场还掉', async () => {
    let finishOpen: (value: unknown) => void = () => {}
    ports.open.mockImplementation(() => new Promise((resolve) => (finishOpen = resolve)))
    const l = link()
    l.start()
    await flush()
    l.dispose()
    finishOpen({ success: true, data: { localPort: 5555 } })
    await flush()
    expect(ports.release).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1', remotePort: 4321 }))
    expect(FakeSocket.all).toHaveLength(0)
  })

  it('断了正在等退避重连时手动「重新连接」:只连一次,退避那次不再来', async () => {
    ports.open.mockResolvedValue({ success: true, data: { localPort: 5555 } })
    const l = link()
    l.start()
    await flush()
    FakeSocket.all[0]!.open()
    FakeSocket.all[0]!.drop() // 断了 → 排了 1 秒后的重连
    l.reconnect()
    await flush()
    expect(FakeSocket.all).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeSocket.all).toHaveLength(2)
    l.dispose()
  })

  it('上一条还没连上就重连:上一条的超时 ❌ 拆掉新连上的这条', async () => {
    ports.open.mockResolvedValue({ success: true, data: { localPort: 5555 } })
    const states: string[] = []
    const l = link(states)
    l.start()
    await flush()
    l.reconnect() // 第一条一直没 open
    await flush()
    const fresh = FakeSocket.all[1]!
    fresh.open()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(fresh.closed).toBe(false)
    expect(states.at(-1)).toBe('open')
    l.dispose()
  })
})
