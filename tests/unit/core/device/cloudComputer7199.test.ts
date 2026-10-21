// #7199 云电脑管家的客户端:地址怎么取、应答怎么读、错误码怎么带回,以及设备行上「休眠中 / 正在唤醒 / 运行中」怎么判。
import { describe, expect, it, vi } from 'vitest'
import {
  CloudComputerError,
  CloudComputerWakeError,
  cloudComputerBaseUrl,
  cloudComputerFailureKind,
  cloudComputerFailureKindOf,
  deviceAcceptsWork,
  wakeCloudComputerUntilOnline,
  cloudComputerNeedsWake,
  cloudComputerPresence,
  cloudComputerErrorFromResponse,
  createCloudComputerClient,
  isCloudComputerNotOpen,
  parseCloudComputerSnapshot,
  type CloudComputerSnapshot,
} from '@gugu/core/cloud/cloudComputer'

const snap = (over: Partial<CloudComputerSnapshot>): CloudComputerSnapshot => ({
  state: 'asleep',
  deviceId: 'dev-cloud',
  error: null,
  since: null,
  ...over,
})

describe('cloudComputerBaseUrl', () => {
  it('an explicitly disabled provider has no endpoint, including when a library or override URL exists', () => {
    expect(cloudComputerBaseUrl({ enabled: false, supabaseUrl: 'https://community.example' })).toBeNull()
    expect(cloudComputerBaseUrl({ enabled: false, override: 'https://cloud.example', supabaseUrl: 'https://community.example' })).toBeNull()
  })
  it('开发实例的覆盖地址优先,去掉结尾斜杠', () => {
    expect(cloudComputerBaseUrl({ override: 'http://127.0.0.1:18790/', supabaseUrl: 'https://db.example' })).toBe('http://127.0.0.1:18790')
  })
  it('没覆盖时是这套库的云端函数', () => {
    expect(cloudComputerBaseUrl({ supabaseUrl: 'https://db.example/' })).toBe('https://db.example/functions/v1/cloud-computer')
  })
  it('两个都没有 = null(功能不显示),❌ 兜底地址', () => {
    expect(cloudComputerBaseUrl({ override: '  ', supabaseUrl: null })).toBeNull()
  })
})

describe('parseCloudComputerSnapshot', () => {
  it('读出四个字段,缺的记 null', () => {
    expect(parseCloudComputerSnapshot({ state: 'awake', deviceId: 'd1', since: '2026-10-15T04:00:00Z' }))
      .toEqual({ state: 'awake', deviceId: 'd1', error: null, since: '2026-10-15T04:00:00Z', adopting: false, adoptingFrom: null })
  })
  it('搬家中:adopting / adopting_from 读成驼峰字段;不带 = 不是搬家', () => {
    expect(parseCloudComputerSnapshot({ state: 'provisioning', deviceId: 'd1', adopting: true, adopting_from: 'dev-home' }))
      .toMatchObject({ adopting: true, adoptingFrom: 'dev-home' })
    expect(parseCloudComputerSnapshot({ state: 'provisioning', adopting: 'yes' })).toMatchObject({ adopting: false })
  })
  it('不认得的状态当场抛,❌ 当成没有云电脑', () => {
    expect(() => parseCloudComputerSnapshot({ state: 'paused' })).toThrow(CloudComputerError)
    expect(() => parseCloudComputerSnapshot(null)).toThrow(CloudComputerError)
  })
})

describe('createCloudComputerClient', () => {
  const respond = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

  it('带用户 JWT 与 anon key 请求 /state', async () => {
    const fetchMock = vi.fn(async () => respond(200, { state: 'none' }))
    const client = createCloudComputerClient({ baseUrl: 'http://cc', accessToken: async () => 'jwt-1', anonKey: 'anon', fetch: fetchMock })
    await expect(client.state()).resolves.toMatchObject({ state: 'none', deviceId: null })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://cc/state')
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-1', apikey: 'anon' })
  })

  it('provision / wake / destroy 走约定的方法与路径', async () => {
    const fetchMock = vi.fn(async () => respond(202, { state: 'provisioning' }))
    const client = createCloudComputerClient({ baseUrl: 'http://cc', accessToken: async () => 'jwt', fetch: fetchMock })
    await client.provision()
    await client.wake()
    await client.destroy()
    const calls = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => [init.method, url, init.body ?? null])
    expect(calls).toEqual([
      ['POST', 'http://cc/provision', '{}'],
      ['POST', 'http://cc/wake', '{}'],
      ['DELETE', 'http://cc/', null],
    ])
  })

  it('搬家:接过一位已有的助理只带 existing_agent_user_id 这一个键;搬回本机的叫醒带 purpose', async () => {
    const fetchMock = vi.fn(async () => respond(202, { state: 'provisioning' }))
    const client = createCloudComputerClient({ baseUrl: 'http://cc', accessToken: async () => 'jwt', fetch: fetchMock })
    await client.provision({ assistant: { existingAgentUserId: 'agent-1' } })
    await client.wake({ purpose: 'move_out' })
    const bodies = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(([, init]) => init.body)
    expect(bodies).toEqual(['{"assistant":{"existing_agent_user_id":"agent-1"}}', '{"purpose":"move_out"}'])
  })

  it('会员到期的 403 归成 membership_expired 这一类', () => {
    const error = new CloudComputerError(403, 'membership_expired', 'expired')
    expect(cloudComputerFailureKind(error)).toBe('membership_expired')
  })

  it('403 带回管家的码与那句话(免费档 = plan_required)', async () => {
    const client = createCloudComputerClient({
      baseUrl: 'http://cc',
      accessToken: async () => 'jwt',
      fetch: async () => respond(403, { error: 'plan_required', message: '云电脑是 Plus 及以上的权益' }),
    })
    const error = await client.provision().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudComputerError)
    expect(error).toMatchObject({ status: 403, code: 'plan_required', message: '云电脑是 Plus 及以上的权益' })
  })

  it('体不是约定形状时码记 http_<状态>,原文进 message', async () => {
    const client = createCloudComputerClient({ baseUrl: 'http://cc', accessToken: async () => 'jwt', fetch: async () => respond(502, 'Bad Gateway') })
    await expect(client.wake()).rejects.toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' })
  })

  it('请求没发出去 = network,status 0', async () => {
    const client = createCloudComputerClient({
      baseUrl: 'http://cc',
      accessToken: async () => 'jwt',
      fetch: async () => { throw new TypeError('Failed to fetch') },
    })
    await expect(client.state()).rejects.toMatchObject({ status: 0, code: 'network', message: 'Failed to fetch' })
  })
})

describe('cloudComputerPresence', () => {
  const device = (over: Partial<{ device_id: string; is_online: boolean }> = {}) => ({ device_id: 'dev-cloud', is_online: false, ...over })

  it('只认管家给的 deviceId:别的机器 = null', () => {
    expect(cloudComputerPresence(device({ device_id: 'other' }), snap({}))).toBeNull()
    expect(cloudComputerPresence(device(), null)).toBeNull()
    expect(cloudComputerPresence(device(), snap({ deviceId: null }))).toBeNull()
  })

  it('睡着:管家说了算,哪怕库里租约还没过期', () => {
    expect(cloudComputerPresence(device({ is_online: true }), snap({ state: 'asleep' }))).toBe('asleep')
    expect(cloudComputerPresence(device(), snap({ state: 'asleep' }))).toBe('asleep')
  })

  it('管家说醒了、设备还没上线 = 正在唤醒;上线了才是运行中', () => {
    expect(cloudComputerPresence(device(), snap({ state: 'awake' }))).toBe('waking')
    expect(cloudComputerPresence(device({ is_online: true }), snap({ state: 'awake' }))).toBe('awake')
    expect(cloudComputerPresence(device(), snap({ state: 'waking' }))).toBe('waking')
  })

  it('开通中 / 出错没有「会自己醒」这回事 = null(照在线与否说)', () => {
    expect(cloudComputerPresence(device(), snap({ state: 'provisioning' }))).toBeNull()
    expect(cloudComputerPresence(device(), snap({ state: 'error', error: '起不来' }))).toBeNull()
  })

  it('睡着、正在醒都要先叫醒;运行中 / 不是云电脑不用', () => {
    expect(cloudComputerNeedsWake('asleep')).toBe(true)
    expect(cloudComputerNeedsWake('waking')).toBe(true)
    expect(cloudComputerNeedsWake('awake')).toBe(false)
    expect(cloudComputerNeedsWake(null)).toBe(false)
  })
})

describe('wakeCloudComputerUntilOnline', () => {
  const states = (...list: CloudComputerSnapshot[]) => {
    let i = 0
    return vi.fn(async () => list[Math.min(i++, list.length - 1)]!)
  }
  const fast = { sleep: async () => {}, now: () => 0 }

  it('不是这个账号的云电脑 = not-cloud,❌ 叫醒', async () => {
    const wake = vi.fn(async () => {})
    const outcome = await wakeCloudComputerUntilOnline({
      client: { state: states(snap({ deviceId: 'other' })), wake },
      deviceId: 'dev-cloud',
      isOnline: async () => false,
      ...fast,
    })
    expect(outcome).toBe('not-cloud')
    expect(wake).not.toHaveBeenCalled()
  })

  it('睡着:先叫醒,等到管家说醒了且设备行在线才返回', async () => {
    const wake = vi.fn(async () => {})
    const online = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const seen: string[] = []
    const outcome = await wakeCloudComputerUntilOnline({
      client: { state: states(snap({ state: 'asleep' }), snap({ state: 'waking' }), snap({ state: 'awake' }), snap({ state: 'awake' })), wake },
      deviceId: 'dev-cloud',
      isOnline: online,
      onSnapshot: (s) => seen.push(s.state),
      ...fast,
    })
    expect(outcome).toBe('online')
    expect(wake).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['asleep', 'waking', 'awake', 'awake'])
  })

  it('积分用完:管家 403 → refused + 码,❌ 一直等', async () => {
    const error = await wakeCloudComputerUntilOnline({
      client: {
        state: states(snap({ state: 'asleep' })),
        wake: async () => { throw new CloudComputerError(403, 'credits_exhausted', '积分已用完') },
      },
      deviceId: 'dev-cloud',
      isOnline: async () => false,
      ...fast,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudComputerWakeError)
    expect(error).toMatchObject({ reason: 'refused', code: 'credits_exhausted', message: '积分已用完' })
  })

  it('管家报错 → failed 带那句原因', async () => {
    await expect(wakeCloudComputerUntilOnline({
      client: { state: states(snap({ state: 'asleep' }), snap({ state: 'error', error: '放回数据失败' })), wake: async () => {} },
      deviceId: 'dev-cloud',
      isOnline: async () => false,
      ...fast,
    })).rejects.toMatchObject({ reason: 'failed', message: '放回数据失败' })
  })

  it('等满了还没上线 → timeout', async () => {
    let t = 0
    await expect(wakeCloudComputerUntilOnline({
      client: { state: states(snap({ state: 'asleep' }), snap({ state: 'waking' })), wake: async () => {} },
      deviceId: 'dev-cloud',
      isOnline: async () => false,
      timeoutMs: 10_000,
      sleep: async () => { t += 2_000 },
      now: () => t,
    })).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('已经醒着在线:不叫醒,直接返回', async () => {
    const wake = vi.fn(async () => {})
    const outcome = await wakeCloudComputerUntilOnline({
      client: { state: states(snap({ state: 'awake' })), wake },
      deviceId: 'dev-cloud',
      isOnline: async () => true,
      ...fast,
    })
    expect(outcome).toBe('online')
    expect(wake).not.toHaveBeenCalled()
  })
})

describe('deviceAcceptsWork', () => {
  it('在线、睡着 / 正在醒的云电脑接活;离线的普通机器 ❌', () => {
    expect(deviceAcceptsWork({ is_online: true })).toBe(true)
    expect(deviceAcceptsWork({ is_online: false, cloud_computer: 'asleep' })).toBe(true)
    expect(deviceAcceptsWork({ is_online: false, cloud_computer: 'waking' })).toBe(true)
    expect(deviceAcceptsWork({ is_online: false })).toBe(false)
  })
})

describe('cloudComputerFailureKind', () => {
  it('给人看的只有那几类:管家的码 → 一类,❌ 带原文', () => {
    expect(cloudComputerFailureKind(new CloudComputerError(403, 'plan_required', '云电脑是 Plus 及以上的权益'))).toBe('plan_required')
    expect(cloudComputerFailureKind(new CloudComputerError(403, 'credits_exhausted', '积分已用完'))).toBe('credits_exhausted')
    expect(cloudComputerFailureKind(new CloudComputerError(0, 'network', 'Failed to fetch'))).toBe('network')
    expect(cloudComputerFailureKind(new CloudComputerError(401, 'unauthorized', 'jwt expired'))).toBe('signed_out')
    expect(cloudComputerFailureKind(new CloudComputerError(404, 'not_found', '还没有云电脑'))).toBe('gone')
    expect(cloudComputerFailureKind(new CloudComputerError(502, 'http_502', 'Bad Gateway'))).toBe('failed')
  })

  it('叫醒没成:等满了 = timeout;拒绝 / 报错照码分;不认得的异常 = failed', () => {
    expect(cloudComputerFailureKind(new CloudComputerWakeError('timeout', 'x'))).toBe('timeout')
    expect(cloudComputerFailureKind(new CloudComputerWakeError('refused', '积分已用完', 'credits_exhausted'))).toBe('credits_exhausted')
    expect(cloudComputerFailureKind(new CloudComputerWakeError('failed', '放回数据失败'))).toBe('failed')
    expect(cloudComputerFailureKind(new Error('boom'))).toBe('failed')
    // 跨 bundle 只剩字段时同一套判法。
    expect(cloudComputerFailureKindOf({ reason: 'failed', code: 'not_found' })).toBe('gone')
  })

  it('醒的途中它没了 = gone(❌ 当成管家报错)', async () => {
    const error = await wakeCloudComputerUntilOnline({
      client: { state: async () => snap({ state: 'none', deviceId: 'dev-cloud' }), wake: async () => {} },
      deviceId: 'dev-cloud',
      isOnline: async () => false,
      sleep: async () => {},
      now: () => 0,
    }).catch((e: unknown) => e)
    expect(cloudComputerFailureKind(error)).toBe('gone')
  })
})

describe('挂住的请求有时限', () => {
  it('管家不回:到点当作连不上(network),❌ 一直等', async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')))
    })
    const client = createCloudComputerClient({ baseUrl: 'http://cc', accessToken: async () => 'jwt', fetch: hang, requestTimeoutMs: 20 })
    await expect(client.wake()).rejects.toMatchObject({ status: 0, code: 'network' })
    expect(cloudComputerFailureKind(await client.state().catch((e: unknown) => e))).toBe('network')
  })

  it('醒了却过了叫醒时限还没上线 = 不再说「正在唤醒」', () => {
    const now = Date.parse('2026-10-15T06:00:00Z')
    const awakeSince = (ms: number) => snap({ state: 'awake', since: new Date(now - ms).toISOString() })
    expect(cloudComputerPresence({ device_id: 'dev-cloud', is_online: false }, awakeSince(30_000), now)).toBe('waking')
    expect(cloudComputerPresence({ device_id: 'dev-cloud', is_online: false }, awakeSince(180_000), now)).toBeNull()
    expect(cloudComputerPresence({ device_id: 'dev-cloud', is_online: true }, awakeSince(180_000), now)).toBe('awake')
  })
})

describe('isCloudComputerNotOpen', () => {
  // 统筹 10-15:云端函数部署了、还没配管家 = 503 not_open,客户端整块不显示;连不上管家、云端函数没部署照旧报错。
  it('只认那扇门的 503 not_open', () => {
    expect(isCloudComputerNotOpen(cloudComputerErrorFromResponse(503, '{"error":"not_open","message":"云电脑暂未开放"}'))).toBe(true)
    expect(isCloudComputerNotOpen(cloudComputerErrorFromResponse(502, '{"error":"unavailable","message":"云电脑管家暂时连不上"}'))).toBe(false)
    expect(isCloudComputerNotOpen(cloudComputerErrorFromResponse(404, 'Function not found'))).toBe(false)
    expect(isCloudComputerNotOpen(new Error('not_open'))).toBe(false)
  })
})
