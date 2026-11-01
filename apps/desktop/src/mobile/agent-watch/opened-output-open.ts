import { openedFilePath, openedOutputLook, type OpenedOutput } from '@gugu/session-chat-ui/opened-outputs'
import {
  OPENED_FILE_MAX_BYTES,
  REMOTE_WORKSPACE_CHUNK_BYTES,
  type SessionpageOpenedFileChunk,
  type SessionpageOpenedFileReadRequest,
} from '@gugu/session-core/session-record/contract'
import { SessionpageRpcError } from './sessionpage-rpc'
import { base64ToBytes } from '@renderer/lib/base64'
import { classifyDocumentPreview, type DocumentPreviewKind } from '@/components/chat/documentPreview'
import { isRenderableImage, mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs'

/**
 * 手机上点开一张附件卡(#7193)怎么开 —— 纯逻辑,单测钉。
 *
 *   网页      → 交给手机浏览器;
 *   那台电脑自己的网页(localhost、内网) → 手机够不着,卡上如实说,❌ 点开一个必然打不开的地址;
 *   文件(path 或 file:// 打开的)→ 从那台电脑现读(与时间线同一条线,不经云),图走看图器,文档走 App 现成的预览。
 */
export type PhoneOpenPlan =
  | { kind: 'browser'; url: string }
  | { kind: 'machine-only' }
  | { kind: 'file'; path: string; name: string; mimeType: string; view: 'image' | DocumentPreviewKind }

export function phoneOpenPlan(output: OpenedOutput): PhoneOpenPlan {
  const path = openedFilePath(output)
  const look = openedOutputLook(output)
  if (!path) {
    if (output.kind !== 'page') throw new Error('an opened file without a path')
    return look.machineOnly ? { kind: 'machine-only' } : { kind: 'browser', url: output.url }
  }
  // 文件名说它是什么只查 imageMime 那一张表;能不能当图画也用它的判据(heic/tiff 是图但手机画不了,走预览)。
  const mimeType = mimeTypeFromName(look.name) ?? ''
  if (isRenderableImage(look.name, mimeType)) return { kind: 'file', path, name: look.name, mimeType, view: 'image' }
  return { kind: 'file', path, name: look.name, mimeType, view: classifyDocumentPreview({ fileName: look.name, mimeType }) }
}

/** 读的过程中文件被改了(几段的 etag 对不上):拼出来的是两个版本的混合,❌ 当成一份交出去。 */
export class OpenedFileChangedError extends Error {
  readonly code = 'file_changed'
  constructor() {
    super('the file changed while it was being read')
    this.name = 'OpenedFileChangedError'
  }
}

/** 整份读下来:按块问那台机器,直到读满它报的大小。 */
export async function readWholeOpenedFile({
  read,
  conversationId,
  path,
  signal,
  onProgress,
}: {
  read: (request: SessionpageOpenedFileReadRequest) => Promise<SessionpageOpenedFileChunk>
  conversationId: string
  path: string
  signal?: AbortSignal
  /** 每读到一块报一次:已读字节、总大小(大文件经转发通道每秒只走零点几 MB,等的时候要看得到在动)。 */
  onProgress?: (read: number, size: number) => void
}): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = []
  let offset = 0
  let size = 0
  let etag: string | null = null
  do {
    signal?.throwIfAborted()
    const chunk = await read({ conversationId, path, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES })
    if (chunk.size > OPENED_FILE_MAX_BYTES) throw new SessionpageRpcError('too_large', 'File exceeds the phone preview limit')
    if (etag !== null && chunk.etag !== etag) throw new OpenedFileChangedError()
    etag = chunk.etag
    size = chunk.size
    const bytes = base64ToBytes(chunk.data)
    // 没读满却读不出东西:文件在两段之间变短了 —— 同样是读的时候被改了。
    if (bytes.length === 0 && offset < size) throw new OpenedFileChangedError()
    parts.push(bytes)
    offset += bytes.length
    onProgress?.(offset, size)
  } while (offset < size)
  const whole = new Uint8Array(offset)
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.length
  }
  return whole
}
