import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { CodexRpcClient } from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'

// B11: the codex app-server control client is `ws` now (it was a hand-written RFC6455 client). These pin what the
// hand-written one did: the Unix-socket endpoint at /rpc, a reply matched to its request, a text message the server
// sends in fragments read as one message, and a refused upgrade failing loud.
let dir: string | null = null
let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

async function appServer(onRpc: (socket: import('ws').WebSocket, message: { id: number; method: string }) => void) {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-rpc-ws-'))
  const socketPath = path.join(dir, 'app-server.sock')
  server = createServer()
  const wss = new WebSocketServer({ server, path: '/rpc' })
  wss.on('connection', (socket) => socket.on('message', (data) => onRpc(socket, JSON.parse(String(data)))))
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
  return socketPath
}

describe('CodexRpcClient over ws (B11)', () => {
  it('connects to the Unix socket endpoint at /rpc and matches a reply to its request', async () => {
    const socketPath = await appServer((socket, message) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }))
    })
    const client = new CodexRpcClient()
    await client.connect({ kind: 'unix', address: `unix://${socketPath}`, socketPath }, 5_000)
    await expect(client.rpc('thread/read', {})).resolves.toEqual({ echoed: 'thread/read' })
    client.close()
  })

  it('reads a notification the server sends in fragments as one message', async () => {
    const socketPath = await appServer((socket) => {
      const text = JSON.stringify({ method: 'turn/completed', params: { threadId: 't-1' } })
      socket.send(text.slice(0, 10), { fin: false })
      socket.send(text.slice(10, 30), { fin: false })
      socket.send(text.slice(30), { fin: true })
    })
    const client = new CodexRpcClient()
    await client.connect({ kind: 'unix', address: `unix://${socketPath}`, socketPath }, 5_000)
    const seen = new Promise((resolve) => client.onEvent(resolve))
    client.notify('initialized', {})
    await expect(seen).resolves.toEqual({ method: 'turn/completed', params: { threadId: 't-1' } })
    client.close()
  })

  it('fails loud when the endpoint refuses the upgrade', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-rpc-ws-'))
    const socketPath = path.join(dir, 'app-server.sock')
    server = createServer()
    server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'))
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    await expect(new CodexRpcClient().connect({ kind: 'unix', address: `unix://${socketPath}`, socketPath }, 5_000)).rejects.toThrow(/HTTP 404/)
  })
})
