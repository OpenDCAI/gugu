// 渲染层取附件字节(桌面 + 手机同一份):链接由 core 的 createAttachmentResolver 给(按批调 attachments/urls),
// 字节进 Cache Storage —— 新消息按内容的 sha256 存(同一张图在十个群里也只下一次;签名过期不影响已存的字节),
// 老消息(正文里的公开 URL)按 URL 存。缩略图另存一份。❌ Electron 缓存目录 / 自定义协议、❌ Service Worker:
// 只有这一条路(统筹 161 10-16 定)。CDN 要回 Access-Control-Allow-Origin,fetch 才读得到字节。
import { useCallback, useEffect, useState } from 'react'
import { createAttachmentResolver, type AttachmentLink } from '@gugu/core/shared/attachmentUrls'
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { fetchAttachmentUrls, attachmentRequest } from '@gugu/core/cloud/attachmentsApi'
import { attachmentsEndpoint } from './attachmentsEndpoint'
import { platform } from '../platform'

const CACHE_NAME = 'gugu-attachments-v1'
/** Cache Storage 的键要是 URL:内容寻址的用一个不会真去请求的地址。 */
const CACHE_ORIGIN = 'https://attachments.gugu.invalid'

export const attachmentResolver = createAttachmentResolver(async (refs) => fetchAttachmentUrls(await attachmentsEndpoint(), refs), {
  fetchMetadata: async (ref) => attachmentRequest(await attachmentsEndpoint(), 'file-resolve', { ref }),
})

export type AttachmentVariant = 'full' | 'thumb'

/** 一个附件来源的身份(effect 的依赖):每次渲染重新解析出来的对象不同,身份相同。 */
export function sourceKeyOf(source: AttachmentSource): string {
  return source.kind === 'url' ? `url:${source.url}` : source.kind === 'item' ? `item:${source.itemId}@${source.version}` : source.kind === 'message' ? `msg:${source.messageId}` : 'gone'
}

function cacheKey(link: AttachmentLink, variant: AttachmentVariant): string {
  const thumb = variant === 'thumb' && link.thumbUrl ? '/thumb' : ''
  return link.sha256 ? `${CACHE_ORIGIN}/sha256/${link.sha256}${thumb}` : `${CACHE_ORIGIN}/url/${encodeURIComponent(link.url)}${thumb}`
}

export type AttachmentBytes = { status: 'ready'; blob: Blob; link: AttachmentLink } | { status: 'gone' } | { status: 'expired' }

/** 取一个附件的字节:先看本机缓存,没有就按签名链接下,存进缓存。取不到就抛(调用方显示「暂时打不开 · 重试」)。 */
export async function attachmentBytes(source: AttachmentSource, variant: AttachmentVariant = 'full', onLink?: (link: AttachmentLink) => void): Promise<AttachmentBytes> {
  const resolved = await attachmentResolver.resolve(source)
  if (resolved.status !== 'ready') return resolved
  onLink?.(resolved)
  const key = cacheKey(resolved, variant)
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(key)
  if (hit) return { status: 'ready', blob: await hit.blob(), link: resolved }
  const from = variant === 'thumb' && resolved.thumbUrl ? resolved.thumbUrl : resolved.url
  const response = await fetch(from)
  if (!response.ok) throw new Error(`attachment ${response.status}`)
  await cache.put(key, response.clone())
  return { status: 'ready', blob: await response.blob(), link: resolved }
}

export type AttachmentView =
  /** link:签好了、字节还在路上(气泡按宽高先留位置)。 */
  | { status: 'loading'; link?: AttachmentLink }
  | { status: 'ready'; objectUrl: string; link: AttachmentLink }
  | { status: 'gone' }
  | { status: 'expired' }
  | { status: 'failed' }

/**
 * 气泡 / 预览用:给一个 object URL;failed 时 retry() 丢掉记着的链接重新签、重新下。
 * enabled = false 时什么都不取(气泡还没滚到眼前:lazy 要推迟的是这次请求,blob URL 上的 loading="lazy" 不管用)。
 */
export function useAttachmentObjectUrl(source: AttachmentSource, variant: AttachmentVariant = 'full', enabled = true): AttachmentView & { retry: () => void } {
  const [view, setView] = useState<AttachmentView>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const sourceKey = sourceKeyOf(source)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let objectUrl: string | null = null
    setView({ status: 'loading' })
    attachmentBytes(source, variant, (link) => alive && setView({ status: 'loading', link })).then(
      (bytes) => {
        if (!alive) return
        if (bytes.status !== 'ready') return setView({ status: bytes.status })
        objectUrl = URL.createObjectURL(bytes.blob)
        setView({ status: 'ready', objectUrl, link: bytes.link })
      },
      () => alive && setView({ status: 'failed' }),
    )
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 source 的身份
  }, [sourceKey, variant, attempt, enabled])
  const retry = useCallback(() => {
    attachmentResolver.forget(source)
    setAttempt((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])
  return { ...view, retry }
}

/** 文件预览取原图,进全 app 唯一的看图器;等待期间已离开的预览不再打开。 */
export async function openAttachmentImage(source: AttachmentSource, alt: string, isCurrent: () => boolean, quote?: () => Promise<void> | void): Promise<void> {
  const bytes = await attachmentBytes(source)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  const { openImageViewer } = await import('./imageViewer')
  if (!isCurrent()) return
  openImageViewer([{ url: URL.createObjectURL(bytes.blob), alt, quote }])
}

/** 下载一个附件(同一份缓存);条目删了就抛。 */
export async function downloadAttachment(source: AttachmentSource, fileName: string): Promise<void> {
  const bytes = await attachmentBytes(source)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  const { downloadBlob } = await import('./download')
  await downloadBlob(bytes.blob, fileName)
}

/** 交给系统应用打开:桌面给字节(同一份缓存),安卓给签名链接(原生自己下),网页开新标签页 —— 宿主挑它要的那一样。 */
export async function openAttachmentInSystemApp(source: AttachmentSource, fileName: string): Promise<void> {
  if (!platform.capabilities.externalFileOpen) throw new Error('External file open is unavailable on this platform')
  await platform.openRemoteFile({
    bytes: async () => {
      const bytes = await attachmentBytes(source)
      if (bytes.status !== 'ready') throw new Error(bytes.status)
      return bytes.blob
    },
    url: async () => {
      const link = await attachmentResolver.resolve(source)
      if (link.status !== 'ready') throw new Error(link.status)
      return link.url
    },
  }, fileName)
}

/** Reads only an existing full-size local copy; never signs or downloads. ACL is checked by the caller. */
export async function cachedAttachmentCopy(sha256: string | null): Promise<Blob | null> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const hit = await (await caches.open(CACHE_NAME)).match(`${CACHE_ORIGIN}/sha256/${sha256}`)
  return hit ? hit.blob() : null
}
