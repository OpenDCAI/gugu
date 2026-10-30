// The remote tunnel's embedded SSH server (tunnel-endpoint.ts) carries the device link's binary frames on an exec
// channel's stdout and the command's stderr on the same channel. ssh2 1.17.0 kept a resumed stdout chunk after a window
// stall and replayed it when stderr later waited for the window, so the desktop's frame decoder read payload bytes as a
// header ("frame too large"). patches/ssh2@1.17.0.patch fixes the resume; this pins it.
import { describe, expect, it } from 'vitest'
import { Client, Server } from 'ssh2'
import { generateHostKey } from '../../../../apps/desktop/electron/server/tunnel-endpoint'

const MB = 1024 * 1024
const pattern = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff))

describe('ssh2 exec channel window resume', () => {
  it('sends stdout once and delivers stderr when both wait for the window', async () => {
    // More than the peer's 2 MB window, so each stream really waits for an adjust.
    const first = pattern(3 * MB, 1)
    const second = pattern(MB, 7)
    const stderr = Buffer.alloc(3 * MB, 0x45)
    const server = new Server({ hostKeys: [generateHostKey().privateKey] }, (conn) => {
      conn.on('authentication', (ctx) => ctx.accept())
      conn.on('ready', () => {
        conn.on('session', (acceptSession) => {
          acceptSession().on('exec', (accept) => {
            const stream = accept()
            stream.write(first, () => {
              // stdout has resumed from its stall; now stderr stalls with nothing waiting on stdout.
              setTimeout(() => {
                stream.stderr.write(stderr, () => {
                  stream.write(second, () => {
                    stream.exit(0)
                    stream.end()
                  })
                })
              }, 100)
            })
          })
        })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = new Client()
    try {
      const received = await new Promise<{ out: Buffer; err: number }>((resolve, reject) => {
        client.on('error', reject)
        client.on('ready', () => {
          client.exec('frames', (error, stream) => {
            if (error) return reject(error)
            const out: Buffer[] = []
            let err = 0
            stream.on('data', (chunk: Buffer) => out.push(chunk))
            stream.stderr.on('data', (chunk: Buffer) => (err += chunk.length))
            // Read nothing for a moment so the server runs out of window.
            stream.pause()
            setTimeout(() => stream.resume(), 300)
            stream.on('close', () => resolve({ out: Buffer.concat(out), err }))
          })
        })
        client.connect({ host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'u', password: 'p', hostVerifier: () => true })
      })
      expect(received.out.equals(Buffer.concat([first, second]))).toBe(true)
      expect(received.err).toBe(stderr.length)
    } finally {
      client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)
})
