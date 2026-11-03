import { createWriteStream } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { pipeline } from 'node:stream/promises'

export class DownloadSiteUnreachableError extends Error {}

/** Stream packages outside undici's parser: a failed download must not crash the host. */
export async function downloadServerPackage(url: string, destination: string, idleTimeoutMs = 30_000): Promise<void> {
  const download = (address: string, redirectsLeft: number): Promise<void> => new Promise((resolve, reject) => {
    const unreachable = (error: Error): void => reject(new DownloadSiteUnreachableError(error.message))
    const parsed = new URL(address)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Unsupported package URL: ${parsed.protocol}`)
    const request = (parsed.protocol === 'http:' ? httpGet : httpsGet)(parsed, { agent: false }, response => {
      response.on('error', unreachable)
      try {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
          resolve(download(new URL(response.headers.location, parsed).href, redirectsLeft - 1))
          response.destroy()
          return
        }
        if (status !== 200) {
          unreachable(new Error(`Package download failed (HTTP ${status}): ${address}`))
          response.destroy()
          return
        }
        const output = createWriteStream(destination)
        output.on('error', reject)
        void pipeline(response, output).then(resolve, reject)
      } catch (error) {
        reject(error)
        response.destroy()
      }
    })
    request.on('error', unreachable)
    request.on('socket', socket => socket.on('error', unreachable))
    request.setTimeout(idleTimeoutMs, () => request.destroy(new Error('Server package download stopped receiving data')))
  })
  await download(url, 3)
}
