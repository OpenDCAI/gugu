import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { attachmentBytes, attachmentMetadata, sourceKeyOf, useAttachmentObjectUrl } from '../../lib/attachmentBytes'
import { useAuth } from '../../store/auth'
import { attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { ExtensionBundleCard } from '../extensionBundle/ExtensionBundleCard'; import { isExtensionBundle } from '../extensionBundle/summarizeExtensionBundle'
import { openImageFromThumb, registerFullImage } from '../../lib/imageViewer'
import { Button } from '../ui/Button'
import { FileAttachmentCard } from './FileAttachmentCard'
import { ExpiredAttachmentCard } from './ExpiredAttachmentCard'
import { Markdown } from '../markdown/Markdown'
import './mediaAttachmentBubble.css'

// @@@fit-bubble 气泡正文是 align-items:flex-start 的 flex 列,子项按内容宽取 fit-content;文件名不换行,卡片的最小内容宽顶到 260px,
// 而气泡被封顶在列宽 → 窄栏下卡片从气泡右侧冒出。max-width:100% 在布局阶段按气泡内容区截回来(卡片里的文件名随之省略)。
const FIT_BUBBLE = 'max-w-full'

/** 与 .chat-inline-image 的上限一致:按宽高先留出画出来的那么大。 */
const INLINE_MAX = 280

// @@@inline-image-decision - 画不画成图只看「浏览器能不能画」(mime ∪ 扩展名,shared/imageMime.mjs),
// 不看写进正文的 [Kind]:历史上 agent 不带 mime_type 发的 PNG 被记成 file,这里让它们自愈。
// 字节一律经 lib/attachmentBytes(签名链接 + Cache Storage);取不到时每个气泡自己说「暂时打不开 · 重试」,
// 条目删了说「文件已删除」。
export function MediaAttachmentBubble({ meta, messageId, isMine, onOpenFile, senderName, chatId, onDownload }: { meta: ParsedAttachment; messageId: string; isMine: boolean; onOpenFile?: (meta: ParsedAttachment) => void; senderName?: string; chatId?: string; onDownload?: () => void }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const box = useRef<HTMLDivElement>(null)
  const managedFile = (meta.source.kind === 'item' || meta.source.kind === 'message' || meta.source.kind === 'attachment') && !isRenderableImage(meta.fileName, meta.mimeType)
  const near = useNearViewport(box, managedFile)
  const metadata = useQuery({ queryKey: ['attachment-state', user?.id, sourceKeyOf(meta.source)],
    queryFn: () => attachmentMetadata(meta.source),
    enabled: near && !!user && managedFile,
  }, attachmentQueryClient)
  const caption = meta.caption ? <Markdown trust="chat" content={meta.caption} onAccent={isMine} /> : null
  if (metadata.data?.status === 'missing') return <div ref={box} className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileMissing')} />{caption}</div>
  if (metadata.data?.status === 'expired') return <div ref={box} className={FIT_BUBBLE}><ExpiredAttachmentCard meta={meta} messageId={messageId} isMine={isMine} />{caption}</div>
  if (metadata.data?.status === 'gone' || metadata.isError) return <div ref={box} className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine}
    details={t(metadata.isError ? 'attachmentView.fileUnavailable' : 'attachmentView.fileGone')} onOpen={() => { if (metadata.isError) void metadata.refetch() }} />{caption}</div>
  // A sending row owns an ephemeral blob preview, not a committed download capability.
  if (meta.source.kind === 'url' && meta.source.url.startsWith('blob:')) return <div ref={box} className={FIT_BUBBLE}>
    {isRenderableImage(meta.fileName, meta.mimeType)
      ? <img src={meta.source.url} alt={meta.fileName} className="chat-inline-image" />
      : <FileAttachmentCard file={meta} isMine={isMine} onOpen={() => undefined} />}{caption}
  </div>
  // App 包:按这条消息装(发布者就是发送者,装的时候由宿主读这条消息)。
  if (isExtensionBundle(meta) && meta.source.kind !== 'gone' && meta.source.kind !== 'attachment') return <div ref={box} className={FIT_BUBBLE}><ExtensionBundleCard meta={meta} card={{ source: meta.source, messageId }} isMine={isMine} senderName={senderName} chatId={chatId} />{caption}</div>
  if (meta.source.kind === 'gone') {
    return <div className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileGone')} onOpen={() => undefined} />{caption}</div>
  }
  if (isRenderableImage(meta.fileName, meta.mimeType)) return <div ref={box} className={FIT_BUBBLE}><InlineImage meta={meta} messageId={messageId} chatId={chatId} isMine={isMine} />{caption}</div>
  // Pin the group file version; the first version does not need a label.
  const versionLabel = meta.source.kind === 'item' && meta.source.version > 1 ? t('attachmentView.fileVersion', { n: meta.source.version }) : undefined
  return <div ref={box} className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine} versionLabel={versionLabel} onOpen={() => onOpenFile?.(meta)} onDownload={onDownload} downloadLabel={t('chatArea.filePreview.download')} />{caption}</div>
}

function InlineImage({ meta, messageId, chatId, isMine }: { meta: ParsedAttachment; messageId: string; chatId?: string; isMine: boolean }) {
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
    })), meta.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: meta.source.itemId, version: meta.source.version } } : undefined, chatId ? { chatId, messageId } : undefined)
    return () => {
      unregister()
      void full?.then((url) => URL.revokeObjectURL(url), () => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 meta.source 的身份
  }, [ready, sourceKey, chatId, messageId])

  if (view.status === 'gone') return <FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileGone')} onOpen={() => undefined} />
  if (view.status === 'missing') return <FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileMissing')} />
  if (view.status === 'expired') return <ExpiredAttachmentCard meta={meta} messageId={messageId} isMine={isMine} />
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
function useNearViewport(ref: RefObject<Element | null>, enabled = true): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!enabled || near || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin: '400px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, near, enabled])
  return near
}
