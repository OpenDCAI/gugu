import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { agentEndpointServer } from '../../../../apps/desktop/electron/session/main/lib/stable-endpoint'

/**
 * 摩擦单 F45(L6 S7/S9):Codex 调咕咕 MCP 偶发「Transport send error … error sending request」,两次都在上一次调用之后
 * 5–6 s。Node 的 HTTP 服务在一次回答之后给连接挂一个 5 s(+1 s 余量)的闲置计时器,到点由宿主关;Codex 的连接池闲到
 * 90 s 才弃,下一次调用正好写进宿主刚关的连接。agent 反复来调的端点由客户端关闲连接:回答之后,宿主这头的连接上
 * 没有闲置计时器。真竞态(Rust reqwest 客户端 × 0.5 ms 扫过关闭那一刻)的读数在 gugu-base evidence/2026-09-30-l4-f45-keepalive。
 */
function answering() {
  let finished: Promise<void> = Promise.resolve()
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    // Node 自己的「回答完就挂闲置计时器」是在调用这个 listener 之前挂上的 finish 监听,这里的 finish 一定在它之后。
    finished = new Promise((resolve) => response.on('finish', () => resolve()))
    request.resume()
    request.on('end', () => response.end('{}'))
  }
  return { listener, finished: () => finished }
}

/** 一条 keep-alive 连接问一次、拿到回答以后,宿主这头给这条连接挂的闲置计时器(毫秒;没挂是 undefined)。 */
async function idleTimerAfterAnAnswer(server: Server, finished: () => Promise<void>): Promise<number | undefined> {
  const hostSide = new Promise<Socket>((resolve) => server.once('connection', resolve))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const agent = new http.Agent({ keepAlive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      http
        .request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent }, (response) => {
          response.resume()
          response.on('end', resolve)
        })
        .on('error', reject)
        .end('{}')
    })
    await finished()
    return (await hostSide).timeout
  } finally {
    agent.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('an endpoint agents keep calling leaves idle connections to the client (F45)', () => {
  it('after an answer the host arms no idle timer on the connection — the client that reuses it closes it', async () => {
    const { listener, finished } = answering()
    expect(await idleTimerAfterAnAnswer(agentEndpointServer(listener), finished)).toBeUndefined()
  })

  it('control: a plain Node server arms one (5 s + its buffer) — the close a pooled client can write into', async () => {
    const { listener, finished } = answering()
    expect(await idleTimerAfterAnAnswer(http.createServer(listener), finished)).toBeGreaterThanOrEqual(5_000)
  })
})
