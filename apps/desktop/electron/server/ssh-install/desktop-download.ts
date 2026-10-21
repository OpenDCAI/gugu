/**
 * #6264「从桌面用 SSH 一步装好」:那台机器上不了网时,由**本机**下载咕咕 server 的包,再经 SSH 传过去
 * (照 VS Code 的 localServerDownload、Zed 的 upload_binary_over_ssh、JetBrains 的「从本机上传安装包」)。
 *
 * 下的是同一个下载站、同一份版本清单、同一个包;校验与那台机器上 install.sh 做的同一件事(sha256),
 * 另外把 install.sh 本身也取回来,经 SSH 带过去 —— 那台机器上什么都不用再下。
 * fetch 与文件目录都注入,单测里换成假的。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type DesktopPackage = {
  version: string
  sha256: string
  /** 本机临时目录里下好、已校验的包。 */
  file: string
  size: number
  /** 同一个下载站上的 install.sh 原文。 */
  installSh: string
}

export class DesktopDownloadError extends Error {}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export async function downloadServerOnDesktop(options: {
  manifestUrl: string
  /** #6264 要指定的那一版(expectVersion):manifestUrl 取不到 / 说的不是这一版时看它(通道清单)。 */
  fallbackManifestUrl?: string
  expectVersion?: string
  installUrl: string
  dir: string
  signal: AbortSignal
  onProgress: (done: number, total: number | null) => void
  fetch?: FetchLike
}): Promise<DesktopPackage> {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const get = async (url: string): Promise<Response> => {
    let response: Response
    try {
      response = await fetchImpl(url, { signal: options.signal })
    } catch (error) {
      if (options.signal.aborted) throw error
      throw new DesktopDownloadError(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new DesktopDownloadError(`${url}: HTTP ${response.status}`)
    return response
  }

  const readManifest = async (url: string) => (await (await get(url)).text()).trim()
  let manifest: string
  if (options.expectVersion) {
    const want = options.expectVersion
    const first = await readManifest(options.manifestUrl).catch(() => '')
    manifest = first.split(/\s+/)[0] === want ? first : options.fallbackManifestUrl ? await readManifest(options.fallbackManifestUrl) : first
    if (manifest.split(/\s+/)[0] !== want) throw new DesktopDownloadError(`下载站上没有 ${want} 这一版:${options.manifestUrl}`)
  } else {
    manifest = await readManifest(options.manifestUrl)
  }
  const [version, sha256, url] = manifest.split(/\s+/)
  if (!version || !/^[0-9a-f]{64}$/.test(sha256 ?? '') || !url) throw new DesktopDownloadError(`版本清单格式不对:${manifest.slice(0, 200)}`)
  const installSh = await (await get(options.installUrl)).text()
  if (!installSh.startsWith('#!')) throw new DesktopDownloadError('安装脚本内容不对')

  const response = await get(url)
  const lengthHeader = Number(response.headers.get('content-length'))
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null
  const file = path.join(options.dir, `gugu-server-${version}.tar.gz`)
  const hash = createHash('sha256')
  const out = fs.createWriteStream(file, { mode: 0o600 })
  let done = 0
  let lastReport = 0
  try {
    if (!response.body) throw new DesktopDownloadError('下载站没有返回内容')
    const reader = response.body.getReader()
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      hash.update(value)
      done += value.byteLength
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      const now = Date.now()
      if (now - lastReport > 250) {
        lastReport = now
        options.onProgress(done, total)
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
  options.onProgress(done, total)
  const actual = hash.digest('hex')
  if (actual !== sha256) {
    fs.rmSync(file, { force: true })
    throw new DesktopDownloadError(`包校验不通过(期望 ${sha256},实际 ${actual})`)
  }
  return { version, sha256, file, size: done, installSh }
}
