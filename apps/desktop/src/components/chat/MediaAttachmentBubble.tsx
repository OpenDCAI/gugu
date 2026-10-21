import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { attachmentBytes, sourceKeyOf, useAttachmentObjectUrl } from '../../lib/attachmentBytes'
import { ExtensionBundleCard } from '../extensionBundle/ExtensionBundleCard'; import { isExtensionBundle } from '../extensionBundle/summarizeExtensionBundle'
import { openImageFromThumb, registerFullImage } from '../../lib/imageViewer'
import { Button } from '../ui/Button'
import { FileAttachmentCard } from './FileAttachmentCard'
import { Markdown } from '../markdown/Markdown'
import './mediaAttachmentBubble.css'

/** 与 .chat-inline-image 的上限一致:按宽高先留出画出来的那么大。 */
const INLINE_MAX = 280

// @@@inline-image-decision - 画不画成图只看「浏览器能不能画」(mime ∪ 扩展名,shared/imageMime.mjs),
// 不看写进正文的 [Kind]:历史上 agent 不带 mime_type 发的 PNG 被记成 file,这里让它们自愈。
// 字节一律经 lib/attachmentBytes(签名链接 + Cache Storage);取不到时每个气泡自己说「暂时打不开 · 重试」,
// 条目删了说「文件已删除」。
export function MediaAttachmentBubble({ meta, messageId, isMine, onOpenFile, senderName, chatId }: { meta: ParsedAttachment; messageId: string; isMine: boolean; onOpenFile?: (meta: ParsedAttachment) => void; senderName?: string; chatId?: string }) {
  const { t } = useTranslation('messaging')
  const caption = meta.caption ? <Markdown trust="chat" content={meta.caption} onAccent={isMine} /> : null
  // App 包:按这条消息装(发布者就是发送者,装的时候由宿主读这条消息)。
  if (isExtensionBundle(meta) && meta.source.kind !== 'gone') return <div><ExtensionBundleCard meta={meta} card={{ source: meta.source, messageId }} isMine={isMine} senderName={senderName} chatId={chatId} />{caption}</div>
  if (meta.source.kind === 'gone') {
    return <div><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileGone')} onOpen={() => undefined} />{caption}</div>
  }
  if (isRenderableImage(meta.fileName, meta.mimeType)) return <div><InlineImage meta={meta} isMine={isMine} />{caption}</div>
  return <div><FileAttachmentCard file={meta} isMine={isMine} onOpen={() => onOpenFile?.(meta)} />{caption}</div>
}

function InlineImage({ meta, isMine }: { meta: ParsedAttachment; isMine: boolean }) {
  const { t } = useTranslation('messaging')
  const box = useRef<HTMLDivElement>(null)
  const near = useNearViewport(box)
  const view = useAttachmentObjectUrl(meta.source, 'thumb', near)
  const img = useRef<HTMLImageElement>(null)
  const ready = view.status === 'ready'
  const sourceKey = sourceKeyOf(meta.source)
  // 查看器:先拿缩略图打开,翻到这一张再取原图(同一份缓存);卸载时收回 object URL。
  useEffect(() => {
    if (!ready || !img.current) return
    let full: Promise<string> | null = null
    const unregister = registerFullImage(img.current, () => (full ??= attachmentBytes(meta.source, 'full').then((bytes) => {
      if (bytes.status !== 'ready') throw new Error('attachment is gone')
      return URL.createObjectURL(bytes.blob)
    })))
    return () => {
      unregister()
      void full?.then((url) => URL.revokeObjectURL(url), () => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 meta.source 的身份
  }, [ready, sourceKey])

  if (view.status === 'gone') return <FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileGone')} onOpen={() => undefined} />
  if (view.status === 'failed') {
    return (
      <FileAttachmentCard
        file={meta}
        isMine={isMine}
        details={`${t('attachmentView.imageUnavailable')} · ${t('attachmentView.retry')}`}
        onOpen={view.retry}
      />
    )
  }
  if (view.status === 'ready') {
    return (
      <Button variant="ghost" size="icon" onClick={(e) => openImageFromThumb(e.currentTarget.querySelector('img') as HTMLImageElement)} style={{ display: 'block', width: 'auto', minHeight: 0, padding: 0, border: 'none', background: 'none', cursor: 'zoom-in' }}>
        <img
          ref={img}
          data-testid={AUTOMATION_TEST_IDS.messageAttachmentImage} data-image-viewer-src={view.objectUrl}
          src={view.objectUrl}
          alt={meta.fileName}
          className="chat-inline-image"
          decoding="async"
        />
      </Button>
    )
  }
  const dims = view.link?.width && view.link.height ? fitInline(view.link.width, view.link.height) : null
  return <div ref={box} aria-label={meta.fileName} className="chat-inline-image chat-inline-image--pending" style={dims ?? undefined} />
}

function fitInline(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, INLINE_MAX / width, INLINE_MAX / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** 滚到眼前(含上下 400px)才去取:一屏一批,往回翻历史时不把整段都下了。 */
function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (near || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin: '400px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, near])
  return near
}
