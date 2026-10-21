// @@@share-with-apps — 安卓壳的系统分享两个方向(product spec)。原生 GuguSharePlugin 只搬运;
// 分享进来的文件在这里读成 File 就让原生删副本,界面不认识路径。
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { IncomingShare, IncomingShareFailure, ShareToAppsPayload } from './types'
import { rendererLogger } from '../lib/log'

const log = rendererLogger('mobile/share-with-apps')
const FAILURE_CODES: readonly IncomingShareFailure[] = ['tooLarge', 'refused', 'unreadable']

interface NativeIncomingFile {
  path: string
  name: string
  mimeType: string
  size: number
}

interface NativeIncomingShare {
  id: string
  text: string | null
  subject: string | null
  files: NativeIncomingFile[]
  failures: Array<{ name: string | null; code: string; detail: string }>
}

interface GuguSharePlugin {
  share(options: ShareToAppsPayload): Promise<void>
  open(options: { url: string; name: string }): Promise<void>
  save(options: { name: string; mimeType: string; data: string }): Promise<{ saved: boolean }>
  release(options: { id: string }): Promise<void>
  addListener(event: 'shareReceived', listener: (share: NativeIncomingShare) => void): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<GuguSharePlugin>('GuguShare')

export async function shareToApps(payload: ShareToAppsPayload): Promise<void> {
  await plugin.share(payload)
}

export const openInApps = (url: string, name: string): Promise<void> => plugin.open({ url, name })

/** WebView 不接 `<a download>`:字节以 base64 交给原生,由系统的「保存到…」落盘。 */
export async function saveToDevice(blob: Blob, name: string): Promise<{ saved: boolean }> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file to save'))
    reader.readAsDataURL(blob)
  })
  return plugin.save({ name, mimeType: blob.type, data })
}

/** 浏览器分享网页常给「标题 + 链接」两段(EXTRA_SUBJECT / EXTRA_TEXT);标题已在正文里就不重复。 */
export function incomingShareText(subject: string | null, text: string | null): string | null {
  const body = text?.trim() ?? ''
  const title = subject?.trim() ?? ''
  if (!title) return body || null
  if (!body) return title
  return body.includes(title) ? body : `${title}\n${body}`
}

async function readIncomingFile(file: NativeIncomingFile): Promise<File> {
  const response = await fetch(Capacitor.convertFileSrc(file.path))
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${file.name}`)
  const blob = await response.blob()
  return new File([blob], file.name, { type: file.mimeType || blob.type })
}

async function toIncomingShare(native: NativeIncomingShare): Promise<IncomingShare> {
  const files: File[] = []
  const failures: IncomingShare['failures'] = []
  for (const failure of native.failures) {
    log.warn({ name: failure.name, code: failure.code, detail: failure.detail }, 'incoming share file not accepted')
    const code = FAILURE_CODES.find((known) => known === failure.code) ?? 'unreadable'
    failures.push({ name: failure.name, reason: code })
  }
  for (const file of native.files) {
    try {
      files.push(await readIncomingFile(file))
    } catch (error) {
      log.warn({ name: file.name, detail: error instanceof Error ? error.message : String(error) }, 'incoming share copy unreadable')
      failures.push({ name: file.name, reason: 'unreadable' })
    }
  }
  // 字节已经在 File 里了,缓存里的副本立刻删;删不掉也不影响这次分享,原生下次启动按一天清。
  await plugin.release({ id: native.id }).catch((error: unknown) => {
    log.warn({ detail: error instanceof Error ? error.message : String(error) }, 'could not release incoming share copies')
  })
  return { text: incomingShareText(native.subject, native.text), files, failures }
}

export function subscribeIncomingShares(listener: (share: IncomingShare) => void): () => void {
  let active = true
  let handle: PluginListenerHandle | null = null
  // 读文件是异步的:一份大视频还在读、又来一份文字时,先读完的不一定是后来的那份。以最后到的那份为准。
  let latest = 0
  void plugin.addListener('shareReceived', (native) => {
    const seq = ++latest
    void toIncomingShare(native).then((share) => { if (active && seq === latest) listener(share) })
  }).then((registered) => {
    handle = registered
    if (!active) void registered.remove()
  })
  return () => {
    if (!active) return
    active = false
    if (handle) void handle.remove()
  }
}
