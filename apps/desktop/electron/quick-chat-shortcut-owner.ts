import { createHash } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { userInfo } from 'node:os'

const HELLO = 'gugu-quick-chat-owner/1'

// Stable across channels/profiles, scoped to the OS user and accelerator. A
// foreign listener fails closed; a second endpoint could create two owners.
export function quickChatOwnerPort(accelerator: string): number {
  const user = process.getuid?.() ?? userInfo().username
  const hash = createHash('sha256').update(`${user}:${accelerator}`).digest()
  return 49152 + hash.readUInt16BE(0) % 16384
}

export type QuickChatShortcutOwner = {
  setEnabled: (enabled: boolean) => void
  setForeground: (foreground: boolean) => void
  owns: () => boolean
  dispose: () => void
}

/** Only the kernel listener's owner registers the native accelerator. A newly
 * foreground instance can request a handoff: unregister/release first, grant
 * the requester, then reconnect followers AFTER its listener is ready. Existing
 * connections remain open during that gap, so background followers cannot race
 * the foreground requester. No timer chooses a focus target or opens a window.
 */
export function createQuickChatShortcutOwner({ port, onChange, onError }: {
  port: number
  onChange: (owned: boolean) => void
  onError: (error: Error) => void
}): QuickChatShortcutOwner {
  let enabled = false
  let foreground = false
  let disposed = false
  let epoch = 0
  let owned = false
  let server: Server | null = null
  let peer: Socket | null = null
  let yielding: Socket | null = null
  let pendingFocus: Socket | null = null
  const followers = new Set<Socket>()
  const change = (next: boolean) => {
    if (owned === next) return
    owned = next
    onChange(next)
  }
  const current = (request: number) => enabled && !disposed && request === epoch
  const clear = () => {
    yielding = pendingFocus = null
    change(false)
    const previous = server
    server = null
    previous?.close()
    peer?.destroy()
    peer = null
    for (const socket of followers) socket.destroy()
    followers.clear()
  }
  const yieldTo = (socket: Socket) => {
    if (!owned || yielding || socket.destroyed) return
    yielding = socket
    pendingFocus = null
    // Native unregistration is synchronous and precedes releasing the endpoint.
    change(false)
    const previous = server
    server = null
    previous?.close()
    socket.write('GRANT\n')
  }
  const finishYield = (socket: Socket, request: number) => {
    if (yielding !== socket) return
    yielding = null
    for (const follower of followers) follower.destroy()
    followers.clear()
    // The recipient either owns the listener now, or failed/exited and we must
    // recover it. All contenders still pass through the same kernel exclusion.
    if (current(request)) contend(request)
  }

  const contend = (request: number, connectionRaces = 0, grant?: Socket) => {
    if (!current(request)) return
    const listener = createServer((socket) => {
      if (!current(request)) { socket.destroy(); return }
      followers.add(socket)
      socket.on('error', () => socket.destroy())
      socket.once('close', () => {
        followers.delete(socket)
        if (pendingFocus === socket) pendingFocus = null
        finishYield(socket, request)
      })
      let buffer = ''
      socket.on('data', (data: Buffer) => {
        if (!current(request)) return
        buffer += data.toString('utf8')
        if (buffer.length > 128) { socket.destroy(); return }
        for (let end; (end = buffer.indexOf('\n')) !== -1;) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (line === 'FOCUS') {
            pendingFocus = socket
            if (!foreground) yieldTo(socket)
          } else if (line === 'BLUR' && pendingFocus === socket) pendingFocus = null
          else if (line === 'READY') finishYield(socket, request)
          else if (line !== 'BLUR') { socket.destroy(); return }
        }
      })
      socket.write(`${HELLO}\n`)
      socket.unref()
    })
    server = listener
    listener.unref()
    listener.once('error', (error: NodeJS.ErrnoException) => {
      if (server !== listener) return
      server = null
      change(false)
      grant?.destroy()
      if (!current(request)) return
      if (error.code !== 'EADDRINUSE') { onError(error); return }
      const socket = createConnection({ host: '127.0.0.1', port })
      peer = socket
      socket.unref()
      let identified = false
      let granted = false
      let buffer = ''
      let retryableClose = true
      socket.setTimeout(2000, () => {
        if (!current(request)) return
        retryableClose = false
        onError(new Error('Quick Chat shortcut endpoint did not identify itself'))
        socket.destroy()
      })
      socket.on('data', (data: Buffer) => {
        if (!current(request)) { socket.destroy(); return }
        buffer += data.toString('utf8')
        if (buffer.length > 128) { retryableClose = false; socket.destroy(); return }
        for (let end; (end = buffer.indexOf('\n')) !== -1;) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (!identified && line === HELLO) {
            identified = true
            socket.setTimeout(0)
            if (foreground) socket.write('FOCUS\n')
          } else if (identified && line === 'GRANT' && !granted) {
            granted = true
            contend(request, 0, socket)
          } else {
            retryableClose = false
            onError(new Error('Quick Chat shortcut endpoint is occupied by another service'))
            socket.destroy()
            return
          }
        }
      })
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (!current(request)) return
        retryableClose = error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
        if (!retryableClose) onError(error)
      })
      socket.once('close', () => {
        if (peer === socket) peer = null
        if (!current(request) || granted) return
        if (identified || (retryableClose && connectionRaces < 2)) contend(request, connectionRaces + 1)
      })
    })
    listener.once('listening', () => {
      if (!current(request)) { listener.close(); return }
      change(true)
      if (grant && !grant.destroyed) {
        if (peer === grant) peer = null
        grant.end('READY\n')
      }
      if (!foreground && pendingFocus) yieldTo(pendingFocus)
    })
    listener.listen({ host: '127.0.0.1', port, exclusive: true })
  }
  return {
    owns: () => owned,
    setForeground(next) {
      if (disposed || foreground === next) return
      foreground = next
      if (next) pendingFocus = null
      if (peer && !peer.destroyed && !peer.writableEnded) peer.write(next ? 'FOCUS\n' : 'BLUR\n')
      if (!next && pendingFocus) yieldTo(pendingFocus)
    },
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
