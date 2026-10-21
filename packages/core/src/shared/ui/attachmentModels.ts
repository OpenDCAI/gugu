import { isImageMimeType, resolveAttachmentMimeType } from '../imageMime.mjs'

export type AttachmentKind = 'image' | 'file'

/** 写进正文的那份(老式发送:字节在 chat-media,正文里带公开 URL)。 */
export interface AttachmentMeta {
  kind: AttachmentKind
  fileName: string
  mimeType: string
  url: string
  sizeBytes: number
  caption?: string
}

/**
 * 字节从哪来(附件进群文件夹 ③):
 * - url:老消息,正文里的 `[URL]`(chat-media 公开链接);
 * - item:新消息,指向群文件夹里一个条目的某一版(消息行的 file_item_id / file_version),链接经 attachments/urls 现签;
 * - message:悄悄话的附件,不进群文件夹(owner 10-17 定),消息直接指字节(file_blob_id);能读这条消息的人才签得到链接;
 * - gone:新消息,但条目已经删了(file_item_id 随删除置空)—— 名字还在,字节没了。
 */
export type AttachmentSource =
  | { kind: 'url'; url: string }
  | { kind: 'item'; itemId: string; version: number }
  | { kind: 'message'; messageId: string }
  | { kind: 'gone' }

/** 读出来的附件:正文里的名字、类型、大小,加上字节从哪来。 */
export interface ParsedAttachment {
  kind: AttachmentKind
  fileName: string
  mimeType: string
  sizeBytes: number
  caption?: string
  source: AttachmentSource
}

/** 消息行上指向字节的列(messages_view 的 file_item_id / file_version / file_blob_id)和消息自己的 id。 */
export interface MessageFileRef {
  id?: string | null
  file_item_id?: string | null
  file_version?: number | null
  file_blob_id?: string | null
}

/** 没定型的行(事件载荷、REST 原样回的 JSON)上读那两列。 */
export function messageFileRefOf(raw: { id?: unknown; file_item_id?: unknown; file_version?: unknown; file_blob_id?: unknown }): MessageFileRef {
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    file_blob_id: typeof raw.file_blob_id === 'string' ? raw.file_blob_id : null,
    file_item_id: typeof raw.file_item_id === 'string' ? raw.file_item_id : null,
    file_version: typeof raw.file_version === 'number' ? raw.file_version : null,
  }
}

const HEADER_PREFIX = '[附件] '
const URL_PREFIX = '[URL] '
const SIZE_PREFIX = '[Size] '
const KIND_PREFIX = '[Kind] '
const CAPTION_MARKER = '[Caption]'

export function formatLegacyAttachmentContent(fileName: string, mimeType: string, textContent: string): string {
  const header = `${HEADER_PREFIX}${fileName}${mimeType ? ` (${mimeType})` : ''}`
  return textContent ? `${header}\n${textContent}` : header
}

// @@@attachment-line-count - Voice attachment content is exactly 3 lines; media attachment content stays 4 lines so parsers can disambiguate the shared `[附件]` header.
export function formatAttachmentMetadata(meta: AttachmentMeta): string {
  const fileName = meta.fileName.trim()
  if (!fileName) throw new Error('fileName is required')
  const url = meta.url.trim()
  if (!url) throw new Error('url is required')
  const mimeType = meta.mimeType.trim()
  const sizeBytes = Math.max(0, Math.round(meta.sizeBytes))
  const kind: AttachmentKind = meta.kind === 'image' ? 'image' : 'file'
  const lines = [
    `${HEADER_PREFIX}${fileName}${mimeType ? ` (${mimeType})` : ''}`,
    `${URL_PREFIX}${url}`,
    `${SIZE_PREFIX}${sizeBytes}`,
    `${KIND_PREFIX}${kind}`,
  ]
  const caption = meta.caption?.trim()
  if (caption) lines.push(CAPTION_MARKER, caption)
  return lines.join('\n')
}

/**
 * 两种正文:老的 `[附件] / [URL] / [Size] / [Kind]`;新的(经 attachments/commit 发的)没有 `[URL]` 那一行,字节由消息行上的
 * file_item_id / file_version(群文件夹里的条目)或 file_blob_id(悄悄话,直接指字节)指着。新正文配不上指针 ⇒ 条目删了(gone)。
 */
export function parseAttachmentContent(content: string | null, ref?: MessageFileRef | null): ParsedAttachment | null {
  if (!content) return null
  const lines = content.split('\n')
  if (!lines[0]?.startsWith(HEADER_PREFIX)) return null
  const legacy = lines[1]?.startsWith(URL_PREFIX) ?? false
  const body = legacy ? lines : [lines[0], '', ...lines.slice(1)]
  if (body.length < 4) return null
  const [headerLine, urlLine, sizeLine, kindLine] = body
  if (!sizeLine.startsWith(SIZE_PREFIX) || !kindLine.startsWith(KIND_PREFIX)) return null

  const header = parseHeader(headerLine)
  if (!header) return null
  const { fileName, mimeType } = header

  let source: AttachmentSource
  if (legacy) {
    const url = urlLine.slice(URL_PREFIX.length).trim()
    if (!url) return null
    source = { kind: 'url', url }
  } else if (ref?.file_item_id && Number.isInteger(ref.file_version) && (ref.file_version as number) >= 1) {
    source = { kind: 'item', itemId: ref.file_item_id, version: ref.file_version as number }
  } else if (ref?.file_blob_id && ref.id) {
    source = { kind: 'message', messageId: ref.id }
  } else {
    source = { kind: 'gone' }
  }

  const sizeBytes = Number(sizeLine.slice(SIZE_PREFIX.length).trim())
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return null

  const kindRaw = kindLine.slice(KIND_PREFIX.length).trim()
  if (kindRaw !== 'image' && kindRaw !== 'file') return null

  let caption: string | undefined
  if (body.length > 4) {
    if (body[4] !== CAPTION_MARKER) return null
    caption = body.slice(5).join('\n').trim()
    if (!caption) return null
  }

  return {
    kind: kindRaw,
    fileName,
    mimeType,
    sizeBytes: Math.round(sizeBytes),
    ...(caption ? { caption } : {}),
    source,
  }
}

function parseHeader(headerLine: string): { fileName: string; mimeType: string } | null {
  const rawHeader = headerLine.slice(HEADER_PREFIX.length).trim()
  if (!rawHeader) return null
  const headerMatch = rawHeader.match(/^(.*?)(?: \(([^()]+)\))?$/)
  const fileName = headerMatch?.[1]?.trim() ?? ''
  return fileName ? { fileName, mimeType: headerMatch?.[2]?.trim() ?? '' } : null
}

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 附件的 mime:浏览器给的 file.type 为空(无扩展名、某些应用拖进来的文件)时按文件名补。 */
export function resolveFileMimeType(file: { name?: string; type?: string }): string {
  return resolveAttachmentMimeType(file.name ?? '', file.type ?? '')
}

export function inferAttachmentKind(file: { name?: string; type?: string }): AttachmentKind {
  return isImageMimeType(resolveFileMimeType(file)) ? 'image' : 'file'
}
