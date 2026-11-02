import { createWriteStream } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { pipeline } from 'node:stream/promises'

export class DownloadSiteUnreachableError extends Error {}

/** Stream packages outside undici's parser: a failed download must not crash the host. */
export async function downloadServerPackage(url: string, destination: string, timeoutMs = 10 * 60_000): Promise<void> {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(new Error('Server package download timed out')), timeoutMs)
  timeout.unref()
  const download = (address: string, redirectsLeft: number): Promise<void> => new Promise((resolve, reject) => {
    const unreachable = (error: Error): void => reject(new DownloadSiteUnreachableError(error.message))
    const parsed = new URL(address)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Unsupported package URL: ${parsed.protocol}`)
    const request = (parsed.protocol === 'http:' ? httpGet : httpsGet)(parsed, { signal: abort.signal, agent: false }, response => {
      response.on('error', unreachable)
      try {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
          response.resume()
          resolve(download(new URL(response.headers.location, parsed).href, redirectsLeft - 1))
          return
        }
        if (status !== 200) {
          response.resume()
          unreachable(new Error(`Package download failed (HTTP ${status}): ${address}`))
          return
        }
        const output = createWriteStream(destination)
        output.on('error', reject)
        void pipeline(response, output).then(resolve, reject)
      } catch (error) {
        response.resume()
        reject(error)
      }
    })
    request.on('error', unreachable)
    request.on('socket', socket => socket.on('error', unreachable))
    request.setTimeout(30_000, () => request.destroy(new Error('Server package download stopped receiving data')))
  })
  try {
    await download(url, 3)
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
}
