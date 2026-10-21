import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'
import { describe, expect, it } from 'vitest'
import { createNativeFetch, type NativeHttp } from '../../../apps/desktop/src/mobile/assistant/phoneNativeFetch'

// #7199 手机网页(https://localhost)请求授权服务是跨域,它们不发 CORS 头:OAuth 的发现 / 注册 / 换令牌要走原生 HTTP。
// 这个适配把 CapacitorHttp 的 { data, status, headers } 还原成 fetch 的 Response(SDK 读 response.json() / headers)。
type Options = Parameters<NativeHttp['request']>[0]
type Reply = Awaited<ReturnType<NativeHttp['request']>>

function fake(reply: Partial<Reply> | ((options: Options) => Promise<Reply>)) {
  const calls: Options[] = []
  const http = {
    request: async (options: Options): Promise<Reply> => {
      calls.push(options)
      if (typeof reply === 'function') return reply(options)
      return { data: '', status: 200, headers: {}, url: options.url, ...reply }
    },
  }
  return { calls, fetch: createNativeFetch(http) }
}

describe('createNativeFetch', () => {
  it('JSON 请求:字符串体与头原样交给原生;JSON 响应(原生已解析成对象)还原成可 .json() 的 Response', async () => {
    const h = fake({ data: { access_token: 'a' }, headers: { 'content-type': 'application/json' } })
    const response = await h.fetch('https://as.example/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' })
    expect(h.calls[0]).toMatchObject({ url: 'https://as.example/token', method: 'POST', headers: { 'Content-Type': 'application/json' }, data: '{"x":1}' })
    expect(await response.json()).toEqual({ access_token: 'a' })
  })

  it('表单(URLSearchParams)体:发成字符串并补上表单的 Content-Type', async () => {
    const h = fake({})
    await h.fetch('https://as.example/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c 1' }) })
    expect(h.calls[0]?.data).toBe('grant_type=authorization_code&code=c+1')
    expect(h.calls[0]?.headers?.['Content-Type']).toContain('application/x-www-form-urlencoded')
  })

  it('401 的 WWW-Authenticate 读得到(MCP 的授权发现靠它)', async () => {
    const h = fake({ status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' } })
    const response = await h.fetch('https://mcp.example/mcp', { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
    expect(extractWWWAuthenticateParams(response).resourceMetadataUrl?.toString()).toBe('https://mcp.example/.well-known/oauth-protected-resource')
  })

  it('204 这类不带 body 的状态不抛', async () => {
    const h = fake({ status: 204 })
    const response = await h.fetch('https://as.example/x')
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('原生失败:抛 TypeError(与 fetch 的网络层失败同形)', async () => {
    const h = fake(async () => {
      throw { message: 'Unable to resolve host' }
    })
    await expect(h.fetch('https://nowhere.example/')).rejects.toThrow(TypeError)
    await expect(h.fetch('https://nowhere.example/')).rejects.toThrow('Unable to resolve host')
  })

  it('取消:signal 一中止就以中止错抛出,原生那一问的晚到结果被丢掉', async () => {
    const h = fake(() => new Promise<Reply>(() => {}))
    const controller = new AbortController()
    const pending = h.fetch('https://as.example/slow', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const already = new AbortController()
    already.abort()
    await expect(h.fetch('https://as.example/slow', { signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('认不得的 body 抛错,❌ 悄悄发一个空的', async () => {
    const h = fake({})
    await expect(h.fetch('https://as.example/x', { method: 'POST', body: new Blob(['x']) })).rejects.toThrow('string bodies')
    expect(h.calls).toEqual([])
  })
})
