import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepSseStreamAlive, SSE_KEEPALIVE_MS } from '../../../../apps/desktop/electron/gugu-mcp-host'

// claude 的 HTTP MCP 客户端对 360 s 没有一个字节的 standalone SSE 流判空闲超时(10-08 ThinkPad 实测每 6 分钟断一次);
// 宿主在流开着的时候隔一阵写一行注释,不让它空闲满。
function fakeStream(state: { headersSent: boolean; writableEnded: boolean; statusCode: number }) {
  const emitter = new EventEmitter()
  const writes: string[] = []
  const response = Object.assign(emitter, state, { write: (chunk: string) => { writes.push(chunk); return true } })
  return { response: response as unknown as ServerResponse & typeof state, writes, emitter }
}

afterEach(() => { vi.useRealTimers() })

describe('standalone SSE keepalive', () => {
  it('writes an SSE comment well inside the 360 s idle window while the stream is open, and stops when it closes', () => {
    vi.useFakeTimers()
    expect(SSE_KEEPALIVE_MS).toBeLessThan(360_000)
    const { response, writes, emitter } = fakeStream({ headersSent: true, writableEnded: false, statusCode: 200 })
    keepSseStreamAlive(response)
    vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 3)
    expect(writes).toEqual([': keepalive\n\n', ': keepalive\n\n', ': keepalive\n\n'])
    emitter.emit('close')
    vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 3)
    expect(writes).toHaveLength(3)
  })

  it('writes nothing before the stream is open, after it ended, or on a non-200 answer', () => {
    vi.useFakeTimers()
    for (const state of [
      { headersSent: false, writableEnded: false, statusCode: 200 },
      { headersSent: true, writableEnded: true, statusCode: 200 },
      { headersSent: true, writableEnded: false, statusCode: 404 },
    ]) {
      const { response, writes } = fakeStream(state)
      const stop = keepSseStreamAlive(response)
      vi.advanceTimersByTime(SSE_KEEPALIVE_MS * 2)
      expect(writes).toEqual([])
      stop()
    }
  })
})
