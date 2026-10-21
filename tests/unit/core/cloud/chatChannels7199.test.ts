// #7199 聊天渠道的客户端:管家 /channels 的路径与方法、出错码(没开放 = not_open)。
import { describe, expect, it, vi } from 'vitest'
import { createChatChannelsClient, isChatChannelsNotOpen } from '@gugu/core/cloud/chatChannels'

function client(respond: (method: string, url: string, body: unknown) => Response) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: String(init?.method), url: String(url), body, headers: init?.headers as Record<string, string> })
    return respond(String(init?.method), String(url), body)
  }) as unknown as typeof fetch
  return { calls, c: createChatChannelsClient({ baseUrl: 'https://db.test/functions/v1/cloud-computer', accessToken: async () => 'jwt', anonKey: 'anon', fetch: fetchImpl }) }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('chatChannels client', () => {
  it('路径、方法、请求体与管家约定的一致;带用户令牌与 anon key', async () => {
    const list = { channels: [], suggestedAgentId: 'a1', kinds: ['wechat'] }
    const { calls, c } = client((method, url) => {
      if (url.endsWith('/login') && method !== 'DELETE') return json({ login: { phase: 'qr', qrcodeUrl: 'u' } })
      if (url.endsWith('/verify')) return json({ login: { phase: 'scanned' } })
      if (url.endsWith('/import')) return json({ result: 'imported' })
      return json(method === 'DELETE' && url.endsWith('/login') ? {} : list)
    })
    await expect(c.list()).resolves.toEqual(list)
    await expect(c.startLogin('wechat')).resolves.toEqual({ phase: 'qr', qrcodeUrl: 'u' })
    await expect(c.loginView('wechat')).resolves.toEqual({ phase: 'qr', qrcodeUrl: 'u' })
    await expect(c.submitVerifyCode('wechat', '42')).resolves.toEqual({ phase: 'scanned' })
    await c.cancelLogin('wechat')
    await c.setAgent('wechat', 'a2')
    await c.setDefault(null)
    await c.disconnect('wechat')
    await expect(c.importLegacy('wechat', { legacy: { credentials: {} }, agentId: 'a1', connectedAt: 1 })).resolves.toBe('imported')
    expect(calls.map((x) => `${x.method} ${x.url.replace('https://db.test/functions/v1/cloud-computer', '')} ${x.body === undefined ? '' : JSON.stringify(x.body)}`.trim())).toEqual([
      'GET /channels',
      'POST /channels/wechat/login {}',
      'GET /channels/wechat/login',
      'POST /channels/wechat/login/verify {"code":"42"}',
      'DELETE /channels/wechat/login',
      'POST /channels/wechat/settings {"agentId":"a2"}',
      'POST /channels/default {"kind":null}',
      'DELETE /channels/wechat',
      'POST /channels/wechat/import {"legacy":{"credentials":{}},"agentId":"a1","connectedAt":1}',
    ])
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer jwt', apikey: 'anon' })
  })

  it('这扇门说没开放:not_open;别的错照码带回', async () => {
    const notOpen = client(() => json({ error: 'not_open', message: '聊天工具暂未开放' }, 503)).c
    const err = await notOpen.list().catch((e: unknown) => e)
    expect(isChatChannelsNotOpen(err)).toBe(true)
    const forbidden = client(() => json({ error: 'forbidden', message: '只能对接你自己的 agent' }, 403)).c
    const err2 = await forbidden.setAgent('wechat', 'x').catch((e: unknown) => e)
    expect(isChatChannelsNotOpen(err2)).toBe(false)
    expect(err2).toMatchObject({ status: 403, code: 'forbidden' })
  })
})
