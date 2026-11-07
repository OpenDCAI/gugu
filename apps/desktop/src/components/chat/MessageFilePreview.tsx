import { SquareArrowRight } from '@/lib/icons'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageActionItems } from './messageActionItems'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { bindFileViewerMenu } from '../preview/file-viewer-menu'
import { quoteChatFile, selectedTextQuote } from '../preview/quote-preview-file'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { downloadBlob } from '../../lib/download'
import { attachmentBytes, attachmentPreview, openAttachmentInSystemApp, sourceKeyOf } from '../../lib/attachmentBytes'
import { rendererLogger } from '../../lib/log'
import { offlineHolder } from '../../lib/fileHost'
import { useDevicesStore } from '../../store/devicesContext'
import { isDeviceOnline } from '@gugu/core/shared/enums/deviceModels'
import { messageForUser } from '../../lib/userFacingError'
import { useToast } from '../toastContext'
import { MessageFilePreviewPanel } from './MessageFilePreviewPanel'
import { classifyDocumentPreview, documentPreviewNeedsFetch, type DocumentPreviewKind } from './documentPreview'
import { savedFileName } from '../../session/shared/extensions/app-runtime-protocol'
import { chatFolderPreview } from '../preview/chat-folder-preview-registration'
import type { HtmlPreviewRegistration } from '../preview/HtmlPreviewFrame'
import type { FileViewerSelection } from '@/session/shared/preview/file-viewer-menu'

const fileOpenLog = rendererLogger('chat/file-open')

/** 预览、下载、交给系统应用打开的那个文件:名字、类型、大小,和字节从哪来(消息附件或历史「文件」页)。 */
export type PreviewFile = Pick<ParsedAttachment, 'kind' | 'fileName' | 'mimeType' | 'sizeBytes' | 'source'> & { document?: boolean }

/**
 * A file the chat's file service does not hold (a session's working copy, on this computer or another): the same preview,
 * with its bytes and what it can do said by whoever opened it.
 */
export interface HostedPreviewSource {
  kind: 'hosted'
  /** The bytes' identity: changing it reads them again. */
  key: string
  read: () => Promise<Blob>
  registerHtml: (documentHtml: string) => Promise<HtmlPreviewRegistration>
  quote: (selection: FileViewerSelection | null) => Promise<void>
  /** The folders it is in, top first: one with `open` goes there. */
  folders?: readonly { name: string; open?: () => void }[]
  /** This file's source can be edited: the preview's Edit opens it there. */
  edit?: () => void
  /** The next step under a file it cannot draw, or could not read: never a dead end. */
  unreadableAction: ReactNode
  /** Absent: this file has no address the system's programs can reach. */
  openExternal?: () => void
  /** The programs of this computer it opens in. */
  openIn?: readonly { key: string; label: string; open: () => void }[]
  download: () => void
}
export type HostedPreviewFile = Omit<PreviewFile, 'source' | 'document'> & { source: HostedPreviewSource; document?: undefined }

/** 预览要读的那份字节:经 lib/attachmentBytes(签名链接 + Cache Storage);条目删了就说出来。 */
async function previewBytes(file: PreviewFile | HostedPreviewFile): Promise<Blob> {
  if (file.source.kind === 'hosted') return file.source.read()
  if (file.document && file.source.kind === 'item') {
    const { readChatFolderText } = await import('../../lib/chatFolder')
    const document = await readChatFolderText({ id: file.source.itemId })
    if (!document) throw new Error('gone')
    return new Blob([document.text], { type: file.mimeType })
  }
  const bytes = await attachmentBytes(file.source)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  return bytes.blob
}

/**
 * What a preview of this kind shows (`kind` from `classifyDocumentPreview`): a video, its signed link (<video> reads it in
 * ranges); anything else, its bytes — as text for what is read as text. A file gone throws `gone`. The chat's preview and
 * a peek beside an App (AppPeek) read it this one way.
 */
type PreviewRead = { content: string | ArrayBuffer | null; videoUrl?: string; expiresAt?: number; renew?: () => Promise<{ videoUrl: string; expiresAt: number }>; release?: () => Promise<void>; error?: string; errorStatus?: 'gone' | 'expired' | 'missing' | 'failed' }
function previewFailure(error: unknown, t: TFunction<'messaging'>): PreviewRead {
  const errorStatus = error instanceof Error && (error.message === 'gone' || error.message === 'expired' || error.message === 'missing') ? error.message : 'failed'
  return { content: null, errorStatus, error: t(errorStatus === 'gone' ? 'attachmentView.fileGone' : errorStatus === 'expired' ? 'attachmentView.fileExpired' : errorStatus === 'missing' ? 'attachmentView.fileMissing' : 'attachmentView.fileUnavailable') }
}
async function readPreview(file: PreviewFile | HostedPreviewFile, kind: DocumentPreviewKind): Promise<PreviewRead> {
  if (file.source.kind === 'hosted' && !documentPreviewNeedsFetch(kind)) {
    const videoUrl = URL.createObjectURL(await file.source.read())
    return { content: null, videoUrl, expiresAt: Infinity, release: async () => URL.revokeObjectURL(videoUrl) }
  }
  if (file.source.kind !== 'hosted' && !documentPreviewNeedsFetch(kind)) {
    const preview = await attachmentPreview(file.source)
    if (preview.status !== 'ready') throw new Error(preview.status)
    let objectUrl: string | undefined
    const renew = async () => {
      const content = await preview.content()
      if (!(content instanceof Blob)) return { videoUrl: content.url, expiresAt: content.expiresAt }
      objectUrl ??= URL.createObjectURL(content)
      return { videoUrl: objectUrl, expiresAt: Infinity }
    }
    const release = async () => { if (objectUrl) URL.revokeObjectURL(objectUrl); await preview.dispose() }
    try { return { content: null, ...await renew(), renew, release } } catch (error) { await release(); throw error }
  }
  const blob = await previewBytes(file)
  if (kind === 'image') {
    const content = URL.createObjectURL(blob)
    return { content, release: async () => URL.revokeObjectURL(content) }
  }
  return { content: kind === 'text' || kind === 'markdown' || kind === 'html' ? await blob.text() : await blob.arrayBuffer() }
}

/** The host's preview wherever a file opens: messages, the chat's folder and an App's peek. */
export function MessageFilePreview({ file, mobile = false, fill = false, tabbed = false, readOnly = false, message, onForward, onBack, onClose }: { file: PreviewFile | HostedPreviewFile; mobile?: boolean; fill?: boolean; tabbed?: boolean; readOnly?: boolean; message?: MessageItem; onForward?: (message: MessageItem) => void; onBack?: () => void; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const kind = classifyDocumentPreview(file)
  const key = file.source.kind === 'hosted' ? file.source.key : sourceKeyOf(file.source)
  const activeKey = useRef(key)
  const viewerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (readOnly || !viewerRef.current || (file.source.kind !== 'item' && file.source.kind !== 'hosted' && !message)) return
    return bindFileViewerMenu(viewerRef.current, () => ({
      resource: file.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: file.source.itemId, version: file.source.version } } : undefined,
      quote: async (selection) => {
        if (file.source.kind === 'hosted') return file.source.quote(selection)
        if (file.source.kind === 'item') return quoteChatFile(file.source.itemId, file.source.version, selection)
        const { UI_EVENTS } = await import('@/lib/uiEvents')
        window.dispatchEvent(new CustomEvent(UI_EVENTS.quoteMessage, { detail: { messageId: message!.id, source: message, senderName: file.fileName, content: selection ? selectedTextQuote(selection) : file.fileName } }))
      },
      canSelectAll: !(mobile && kind === 'html') && kind !== 'image' && kind !== 'video' && kind !== 'unsupported',
    }), (error) => toast(error instanceof Error ? error.message : String(error), 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source identity retains the menu snapshot across unrelated renders
  }, [key, file.fileName, message?.id, kind, mobile, toast, readOnly])
  const [read, setRead] = useState<PreviewRead | null>(null)
  // A chat folder's HTML document is given its folder: the files its page names beside it are shown (preview-protocol).
  const [besideOffline, setBesideOffline] = useState<{ machine: string; deviceId: string } | null>(null)
  // The machine a failed read waits for: when the device list sees it go from off to on, the file is read again by itself.
  const [waitingFor, setWaitingFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { devices } = useDevicesStore()
  const seenOff = useRef(false)
  useEffect(() => {
    if (!waitingFor) { seenOff.current = false; return }
    const online = devices.some((device) => device.device_id === waitingFor && isDeviceOnline(device.status))
    if (!online) { seenOff.current = true; return }
    if (seenOff.current) { seenOff.current = false; setWaitingFor(null); setBesideOffline(null); setAttempt((n) => n + 1) }
  }, [devices, waitingFor])
  const itemId = file.source.kind === 'item' ? file.source.itemId : null
  const hostedHtml = file.source.kind === 'hosted' ? file.source.registerHtml : undefined
  const registerHtml = useMemo(() => {
    if (hostedHtml) return hostedHtml
    if (itemId === null) return undefined
    const style = getComputedStyle(document.documentElement)
    return chatFolderPreview(itemId, {
      unavailable: t('attachmentView.besideUnavailable'),
      outside: t('attachmentView.besideOutside'),
      offline: t('attachmentView.besideOffline'),
      palette: { surface: style.getPropertyValue('--bg-secondary').trim(), border: style.getPropertyValue('--border-strong').trim(), text: style.getPropertyValue('--text-secondary').trim() },
    }, (holder) => { setBesideOffline(holder); setWaitingFor(holder.deviceId) })
  }, [hostedHtml, itemId, t])
  useEffect(() => {
    activeKey.current = key
    let live = true, release: PreviewRead['release']
    setRead(null)
    const source = file.source
    if (kind !== 'unsupported') void readPreview(file, kind).then(
      (done) => { release = done.release; if (!live) { void release?.(); return } setRead(done) },
      async (error) => {
        // A project file kept on a machine that is off now says so, from a fresh read of where it is kept.
        const offline = source.kind === 'item' ? await offlineHolder(source.itemId, source.version) : null
        if (!live) return
        setWaitingFor(offline?.deviceId ?? null)
        setRead(offline !== null ? { content: null, errorStatus: 'failed', error: t('attachmentView.holderOffline', { machine: offline.machine || t('attachmentView.holderMachine') }) } : previewFailure(error, t))
      },
    )
    return () => { live = false; void release?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source kind/id/version and the preview kind identify the bytes; attempt reads them again
  }, [key, kind, file.document, message?.id, message?.chat_id, t, attempt])
  const renewVideo = async (video: HTMLVideoElement) => {
    const current = read
    if (video.dataset.renewing) return
    const fail = (error?: unknown) => setRead(row => row === current ? { ...row, ...previewFailure(error, t) } : row)
    if (!current?.renew || Date.now() < (current.expiresAt ?? Infinity)) { fail(); return }
    video.dataset.renewing = 'true'
    const time = video.currentTime, playing = !video.paused
    try {
      const next = await current.renew()
      video.addEventListener('loadedmetadata', () => { video.currentTime = time; if (playing) void video.play().catch(fail) }, { once: true })
      setRead(row => row === current ? { ...row, ...next } : row)
    } catch (error) { fail(error) } finally { delete video.dataset.renewing }
  }
  const missing = read?.errorStatus === 'missing'
  const rememberMissing = (error: unknown) => {
    const failure = previewFailure(error, t)
    if (failure.errorStatus !== 'missing') return false
    if (activeKey.current === key) setRead(failure)
    return true
  }
  const savedName = savedFileName({ name: file.fileName, contentType: file.mimeType })
  const openExternal = () => {
    if (missing) return
    if (file.source.kind === 'hosted') { file.source.openExternal?.(); return }
    void openAttachmentInSystemApp(file.source, savedName).catch((error) => {
      if (rememberMissing(error)) return
      fileOpenLog.error({ error }, 'system app handoff failed')
      toast(t('chatArea.downloadFailed'), 'error', messageForUser(error))
    })
  }
  const download = () => {
    if (missing) return
    if (file.source.kind === 'hosted') { file.source.download(); return }
    void previewBytes(file).then((blob) => downloadBlob(blob, savedName)).catch((error) => {
      if (rememberMissing(error)) return
      fileOpenLog.error({ error }, 'preview file download failed'); toast(t('chatArea.downloadFailed'), 'error', messageForUser(error))
    })
  }
  const actions = messageActionItems({ isRetracted: !!message?.retracted_at, content: message?.content ?? null, onForward: !readOnly && message && onForward ? () => onForward(message) : undefined, onDownload: missing ? undefined : download }, t)
  if (file.source.kind === 'hosted' && !missing) for (const app of file.source.openIn ?? []) actions.push({ key: `open-in-${app.key}`, icon: SquareArrowRight, label: app.label, onSelect: app.open })
  const notice = besideOffline ? t('attachmentView.besideOfflineNotice', { machine: besideOffline.machine || t('attachmentView.holderMachine') }) : undefined
  // `key`: a read again (the machine back) gives the HTML preview a new registration, so its files are asked for again.
  return <MessageFilePreviewPanel key={attempt} {...(file.source.kind === 'hosted' ? { folders: file.source.folders, unreadableAction: file.source.unreadableAction, ...(file.source.edit ? { onEdit: file.source.edit } : {}) } : {})} notice={notice} registerHtml={registerHtml} viewerRef={viewerRef} fill={fill} tabbed={tabbed} mobile={mobile} file={file} kind={kind} content={read?.content ?? null} videoUrl={read?.videoUrl} onVideoError={renewVideo} loading={kind !== 'unsupported' && read === null} error={read?.error} onBack={onBack} onClose={onClose} actions={actions} onOpenExternal={missing || file.document || (file.source.kind === 'hosted' ? !file.source.openExternal : kind === 'unsupported') ? undefined : openExternal} />
}
