import { useCallback, useEffect, useState } from 'react'
import { fileBlob, MissingFileObjectError, type FileHandle, type FileMetadata, type FileRevision } from '@gugu/core/shared/fileResolver'
import { fileSha256 } from '@gugu/core/shared/fileCipher'
import { attachmentFileRef, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { resolveFile, fileReader, fileReadSignal, attachmentCache, attachmentCacheOrigin } from './fileAccess'
import { attachmentQueryClient } from './attachmentQueryClient'
import { platform } from '../platform'
import type { ImageViewerItem } from './imageViewer'

export async function resolveAttachment(source: AttachmentSource) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader(), { signal: fileReadSignal() }) : { status: 'gone' as const, sha256: null }
}
export async function attachmentMetadata(source: AttachmentSource): Promise<FileMetadata> {
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') return file
  await file.dispose(); return { status: 'ready', revision: file.revision }
}
export async function attachmentPreview(source: AttachmentSource) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader(), { purpose: 'preview', signal: fileReadSignal() }) : { status: 'gone' as const, sha256: null }
}
const fullKey = (accountId: string, sha: string) => `${attachmentCacheOrigin}/account/${encodeURIComponent(accountId)}/sha256/${sha}`

export type AttachmentVariant = 'full' | 'thumb'

/** 一个附件来源的身份(effect 的依赖):每次渲染重新解析出来的对象不同,身份相同。 */
export function sourceKeyOf(source: AttachmentSource): string {
  return source.kind === 'url' ? `url:${source.url}` : source.kind === 'item' ? `item:${source.itemId}@${source.version}` : source.kind === 'message' ? `msg:${source.messageId}` : source.kind === 'attachment' ? `attachment:${source.attachmentId}` : 'gone'
}

export type AttachmentBytes = { status: 'ready'; blob: Blob; link: FileRevision } | { status: 'gone' | 'expired' | 'missing' }

/** Thumbnails only display; original blobs are created exclusively from a fully verified file handle. */
export async function attachmentBytes(source: AttachmentSource, variant: AttachmentVariant = 'full', onLink?: (link: FileRevision) => void): Promise<AttachmentBytes> {
  try { return await readAttachmentBytes(source, variant, onLink) }
  catch (error) { if (error instanceof MissingFileObjectError) return { status: 'missing' }; throw error }
}

async function readAttachmentBytes(source: AttachmentSource, variant: AttachmentVariant, onLink?: (link: FileRevision) => void): Promise<AttachmentBytes> {
  if (variant === 'thumb') {
    const preview = await attachmentPreview(source)
    if (preview.status !== 'ready') return preview
    try {
      onLink?.(preview.revision)
      const blob = await preview.content()
      if (!(blob instanceof Blob)) throw new Error('Expected an image preview')
      return { status: 'ready', blob, link: preview.revision }
    } finally { await preview.dispose() }
  }
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') return file
  onLink?.(file.revision)
  const blob = await fileBlob(file)
  if (file.revision.sha256 !== null) await (await attachmentCache()).put(fullKey(file.reader.accountId, file.revision.sha256), new Response(blob))
  return { status: 'ready', blob, link: file.revision }
}

export type AttachmentView =
  /** link:签好了、字节还在路上(气泡按宽高先留位置)。 */
  | { status: 'loading'; link?: FileRevision }
  | { status: 'ready'; objectUrl: string; link: FileRevision }
  | { status: 'gone' }
  | { status: 'expired' }
  | { status: 'missing' }
  | { status: 'failed' }

/** 缩略图在内存里只是一个 blob:记在本次运行里,超过这么久没人再取就丢。 */
const THUMB_GC_MS = 30 * 60_000
/** 内容不会变的来源:一条消息 / 一个附件 / 群文件的某一版。 */
const immutableSource = (source: AttachmentSource) => source.kind === 'message' || source.kind === 'attachment' || source.kind === 'item'

/**
 * 缩略图按来源记在 attachmentQueryClient 里。本地缓存(Cache Storage)按内容哈希存,而哈希要先问一次 file-resolve 才有:
 * 不记的话,每次重新挂载(切会话回来、120 行窗口换回来)都先等一个网络来回(实测 0.9–1.4 s 空占位)才画得出本地已有的图。
 * 不可变来源在本次运行里不再重问:被删 / 过期的文件这次运行内仍显示旧缩略图,打开原图照旧完整校验(attachmentBytes 'full')。
 */
async function sessionThumb(source: AttachmentSource, onLink: (link: FileRevision) => void): Promise<AttachmentBytes> {
  return attachmentQueryClient.fetchQuery({
    queryKey: ['attachment-thumb', fileReader().accountId, sourceKeyOf(source)],
    queryFn: () => attachmentBytes(source, 'thumb', onLink),
    staleTime: immutableSource(source) ? Infinity : 0,
    gcTime: THUMB_GC_MS,
  })
}

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
    const onLink = (link: FileRevision) => alive && setView({ status: 'loading', link })
    ;(variant === 'thumb' ? sessionThumb(source, onLink) : attachmentBytes(source, variant, onLink)).then(
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
    setAttempt((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])
  return { ...view, retry }
}

/** 文件预览取原图,进全 app 唯一的看图器;等待期间已离开的预览不再打开。 */
export async function openAttachmentImage(source: AttachmentSource, alt: string, isCurrent: () => boolean, quote?: () => Promise<void> | void, origin?: ImageViewerItem['source']): Promise<void> {
  const bytes = await attachmentBytes(source)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  const { openImageViewer } = await import('./imageViewer')
  if (!isCurrent()) return
  openImageViewer([{ url: URL.createObjectURL(bytes.blob), alt, quote, source: origin, resource: source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: source.itemId, version: source.version } } : undefined }])
}

/** 下载一个附件(同一份缓存);条目删了就抛。 */
export async function downloadAttachment(source: AttachmentSource, fileName: string): Promise<void> {
  const bytes = await attachmentBytes(source)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  const { downloadBlob } = await import('./download')
  await downloadBlob(bytes.blob, fileName)
}

/** Only the original capability can cross the system-open boundary. */
export async function openAttachmentInSystemApp(source: AttachmentSource, fileName: string): Promise<void> {
  if (!platform.capabilities.externalFileOpen) throw new Error('External file open is unavailable on this platform')
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') throw new Error(file.status)
  await openFileHandle(file, fileName)
}
export const openFileHandle = (file: FileHandle, fileName: string) => platform.openRemoteFile(file, fileName)

/** Reads only an existing full-size local copy; never signs or downloads. ACL is checked by the caller. */
export async function cachedAttachmentCopy(sha256: string | null): Promise<Blob | null> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const hit = await (await attachmentCache()).match(fullKey(fileReader().accountId, sha256))
  if (!hit) return null
  const blob = await hit.blob(), hash = fileSha256.create(), reader = blob.stream().getReader()
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; hash.update(chunk.value) }
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') === sha256 ? blob : null
}
