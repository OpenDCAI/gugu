import { createHash } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { userInfo } from 'node:os'

const HELLO = 'gugu-quick-chat-owner/1\n'

// Stable across channels/profiles, scoped to the OS user and accelerator. A
// foreign listener fails closed; choosing a second port could create two owners.
export function quickChatOwnerPort(accelerator: string): number {
  const user = userInfo()
  const hash = createHash('sha256').update(`${user.uid}:${user.username}:${accelerator}`).digest()
  return 49152 + hash.readUInt16BE(0) % 16384
}

export type QuickChatShortcutOwner = {
  setEnabled: (enabled: boolean) => void
  owns: () => boolean
  dispose: () => void
}

/** Kernel-exclusive listener, not a PID file or a focus-delay heuristic.
 * Followers never register the native accelerator. A recognised owner's socket
 * closes on disable/exit/crash, waking contenders to acquire the same listener.
 * The listener carries only a version marker, never keys, commands or user data.
 */
export function createQuickChatShortcutOwner({ port, onChange, onError }: {
  port: number
  onChange: (owned: boolean) => void
  onError: (error: Error) => void
}): QuickChatShortcutOwner {
  let enabled = false
  let disposed = false
  let epoch = 0
  let owned = false
  let server: Server | null = null
  let peer: Socket | null = null
  const followers = new Set<Socket>()
  const change = (next: boolean) => {
    if (owned === next) return
    owned = next
    onChange(next)
  }
  const clear = () => {
    // Unregister before another process can acquire the released endpoint.
    change(false)
    const previous = server
    server = null
    previous?.close()
    peer?.destroy()
    peer = null
    for (const socket of followers) socket.destroy()
    followers.clear()
  }
  const current = (request: number) => enabled && !disposed && request === epoch

  const contend = (request: number, connectionRaces = 0) => {
    if (!current(request)) return
    const listener = createServer((socket) => {
      if (!current(request)) { socket.destroy(); return }
      followers.add(socket)
      socket.on('error', () => socket.destroy())
      socket.once('close', () => followers.delete(socket))
      // Keep the connection open as a lifetime notification.
      socket.write(HELLO)
      socket.unref()
    })
    server = listener
    listener.unref()
    listener.once('error', (error: NodeJS.ErrnoException) => {
      if (server === listener) { server = null; change(false) }
      if (!current(request)) return
      if (error.code !== 'EADDRINUSE') { onError(error); return }
      const socket = createConnection({ host: '127.0.0.1', port })
      peer = socket
      socket.unref()
      let identified = false
      let greeting = ''
      let retryableClose = true
      socket.setTimeout(2000, () => {
        if (!current(request)) return
        retryableClose = false
        onError(new Error('Quick Chat shortcut endpoint did not identify itself'))
        socket.destroy()
      })
      socket.on('data', (data: Buffer) => {
        if (!current(request)) { socket.destroy(); return }
        greeting += data.toString('utf8')
        if (HELLO.startsWith(greeting) && greeting !== HELLO) return
        if (greeting === HELLO) {
          identified = true
          socket.setTimeout(0)
        } else {
          retryableClose = false
          onError(new Error('Quick Chat shortcut endpoint is occupied by another service'))
          socket.destroy()
        }
      })
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (!current(request)) return
        retryableClose = error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
        if (!retryableClose) onError(error)
      })
      socket.once('close', () => {
        if (peer === socket) peer = null
        if (!current(request)) return
        // An owner may exit between EADDRINUSE and connect. Retry that race
        // finitely; never busy-loop against an unknown service on this port.
        if (identified || (retryableClose && connectionRaces < 2)) contend(request, connectionRaces + 1)
      })
    })
    listener.once('listening', () => {
      if (!current(request)) { listener.close(); return }
      change(true)
    })
    listener.listen({ host: '127.0.0.1', port, exclusive: true })
  }
  return {
    owns: () => owned,
    setEnabled(next) {
      if (disposed || enabled === next) return
      enabled = next
      const request = ++epoch
      clear()
      if (enabled) contend(request)
    },
    dispose() {
      if (disposed) return
      disposed = true
      enabled = false
      ++epoch
      clear()
    },
  }
}
