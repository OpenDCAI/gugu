import { afterEach, expect, it, vi } from 'vitest'
import { createCloudComputerClient } from '../../../../packages/core/src/cloud/cloudComputer'

afterEach(() => vi.useRealTimers())

it('管家正在存档时等待，身份和设备始终不变；管家接下后才轮询完成', async () => {
  vi.useFakeTimers()
  const requests: string[] = []
  const client = createCloudComputerClient({ baseUrl: 'http://cloud', accessToken: async () => 'jwt', fetch: async (_url, init) => {
    requests.push(String(init?.method))
    return requests.length === 1
      ? new Response(JSON.stringify({ error: 'busy' }), { status: 409 })
      : new Response(JSON.stringify({ status: requests.length === 2 ? 'cleaning' : 'closed' }))
  } })
  const pending = client.closeAssistant({ deviceId: 'device', assistantId: 'assistant' })
  await vi.advanceTimersByTimeAsync(4_000)
  await pending
  expect(requests).toEqual(['POST', 'POST', 'GET'])
})

it('只清助理，等存档完成才成功；轮询一直带同一位助理和宿主，绝不 DELETE 宿主', async () => {
  vi.useFakeTimers()
  const requests: { path: string; method: string; body?: unknown }[] = []
  const client = createCloudComputerClient({ baseUrl: 'http://cloud', accessToken: async () => 'jwt', fetch: async (url, init) => {
    requests.push({ path: String(url), method: String(init?.method), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    return new Response(JSON.stringify({ status: requests.length === 3 ? 'closed' : 'cleaning' }), { status: requests.length === 3 ? 200 : 202 })
  } })
  let finished = false
  const pending = client.closeAssistant({ deviceId: 'device', assistantId: 'assistant' }).then(() => { finished = true })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(2_000)
  await pending
  expect(requests).toEqual([
    { path: 'http://cloud/assistant/close', method: 'POST', body: { deviceId: 'device', assistantId: 'assistant' } },
    { path: 'http://cloud/assistant/close?deviceId=device&assistantId=assistant', method: 'GET' },
    { path: 'http://cloud/assistant/close?deviceId=device&assistantId=assistant', method: 'GET' },
  ])
})

it('拒绝把失败或未知的清理状态当成功；关闭唤醒照实带 purpose', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'unknown' })))
  const client = createCloudComputerClient({ baseUrl: 'http://cloud', accessToken: async () => 'jwt', fetch })
  await expect(client.closeAssistant({ deviceId: 'device', assistantId: 'assistant' })).rejects.toMatchObject({ code: 'bad_response' })
  fetch.mockResolvedValue(new Response('{}', { status: 202 }))
  await client.wake({ purpose: 'close' })
  expect(fetch).toHaveBeenLastCalledWith('http://cloud/wake', expect.objectContaining({ method: 'POST', body: JSON.stringify({ purpose: 'close' }) }))
})

it('删除前先核对接口与身份，旧服务或已经换人时拒绝继续', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'ready' })))
  const client = createCloudComputerClient({ baseUrl: 'http://cloud', accessToken: async () => 'jwt', fetch })
  await client.prepareAssistantClose({ deviceId: 'device', assistantId: 'assistant' })
  expect(fetch).toHaveBeenLastCalledWith('http://cloud/assistant/close?deviceId=device&assistantId=assistant', expect.objectContaining({ method: 'GET' }))
  fetch.mockResolvedValue(new Response(JSON.stringify({ status: 'closed' })))
  await expect(client.prepareAssistantClose({ deviceId: 'device', assistantId: 'assistant' })).rejects.toMatchObject({ code: 'stale_assistant' })
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
  await expect(client.prepareAssistantClose({ deviceId: 'device', assistantId: 'assistant' })).rejects.toMatchObject({ code: 'not_found' })
})
