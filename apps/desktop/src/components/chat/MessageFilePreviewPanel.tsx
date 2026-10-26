import { ChevronLeft, ExternalLink, FileText, Maximize2, Minimize2, X } from '@/lib/icons'
import { formatAttachmentSize, type AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { PaneHeader } from '../ui/Pane'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../markdown/Markdown'
import { DocumentPreviewContent } from './DocumentPreviewContent'
import { attachmentTypeKey } from './attachmentType'
import type { DocumentPreviewKind } from './documentPreview'
import type { MessageActionItem } from './messageActionItems'
import type { RefObject } from 'react'

export interface MessageFilePreviewPanelProps {
  contentRef?: RefObject<HTMLDivElement | null>
  file: Pick<AttachmentMeta, 'fileName' | 'sizeBytes' | 'mimeType'>
  /** 视频:<video> 按需分段取的那个链接(❌ 整段读进内存)。 */
  videoUrl?: string
  onVideoError?: (video: HTMLVideoElement) => void
  kind: DocumentPreviewKind
  content: string | ArrayBuffer | null
  loading: boolean
  error?: string
  /** 读的时候那一行字(手机附件卡:「正在从那台电脑取 2.0 MB / 6.0 MB」)。不给 = 通用的「加载中」。 */
  loadingLabel?: string
  /** 读到几成(0–1),给了就在那行字下面画一条进度。 */
  loadingFraction?: number
  actions?: MessageActionItem[]
  /** 交给系统打开。不给 = 这份文件没有可交出去的地址(手机从那台电脑现读的附件卡,#7193),不摆这一枚。 */
  onOpenExternal?: () => void
  /** 回到打开文件的 App/列表;关闭整栏仍由 onClose 处理。 */
  onBack?: () => void
  full?: boolean
  onToggleFull?: () => void
  onClose: () => void
  mobile?: boolean
  /** Fills the box it is put in (beside an App, AppPeek) instead of taking a side panel's width. */
  fill?: boolean
  /** The host tab already carries this file name and its close button. */
  tabbed?: boolean
  /** Reuse the task conversation's header and Back affordance. */
  chatNavigation?: boolean
}

export function MessageFilePreviewPanel({ contentRef, file, videoUrl, onVideoError, kind, content, loading, error, loadingLabel, loadingFraction, actions = [], onOpenExternal, onBack, full, onToggleFull, onClose, mobile = false, fill = false, tabbed = false, chatNavigation = false }: MessageFilePreviewPanelProps) {
  const { t } = useTranslation('messaging')
  // 手机页头第二行:扩展名 + 大小(「HTML · 791 B」);大小还不知道就只写扩展名。❌ MIME 原文。
  const type = attachmentTypeKey(file)
  const typeLabel = type ? t(`attachmentView.types.${type}`) : null
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(file.fileName)?.[1]?.toUpperCase() ?? null
  const meta = [extension, file.sizeBytes > 0 ? formatAttachmentSize(file.sizeBytes) : null].filter(Boolean).join(' · ')
  const fullButton = onToggleFull ? <IconButton size={tabbed ? 'sm' : 'md'} className={tabbed ? 'ml-auto' : undefined} aria-pressed={full === true} aria-label={t(full ? 'chatArea.openWith.restore' : 'chatArea.openWith.maximize')} title={t(full ? 'chatArea.openWith.restore' : 'chatArea.openWith.maximize')} onClick={onToggleFull}>{full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</IconButton> : null
  return (
    <aside data-testid="message-file-preview-panel" data-preview-kind={kind} style={{ width: mobile || fill ? '100%' : 'clamp(380px, 38vw, 520px)', height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: mobile ? undefined : '1px solid var(--border-subtle)', background: 'var(--bg-primary)' }}>
      {/* 手机左上返回、右上消息动作;桌面从 App/列表打开时左上返回;页签内的 × 关闭当前文件。 */}
      {chatNavigation && !mobile ? (
        <PaneHeader title={file.fileName} divider
          leading={<IconButton aria-label={t('common.back')} onClick={onBack ?? onClose}><ChevronLeft /></IconButton>} />
      ) : tabbed && !mobile ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2" data-testid="message-file-preview-tab-bar">
          {onBack ? <IconButton size="sm" aria-label={t('common.back')} onClick={onBack}><ChevronLeft /></IconButton> : null}
          {fullButton}
          <IconButton size="sm" className={fullButton ? undefined : 'ml-auto'} aria-label={t('common.close')} onClick={onClose}><X /></IconButton>
        </div>
      ) : mobile ? (
        <PaneHeader
          mobile
          divider
          title={
            <span className="gg-pane-title-stack">
              <h2 className="gg-pane-title">{file.fileName}</h2>
              {meta ? <span data-testid="message-file-preview-meta" className="gg-pane-meta">{meta}</span> : null}
            </span>
          }
          leading={<IconButton size="lg" aria-label={t(onBack ? 'common.back' : 'common.close')} onClick={onBack ?? onClose}>{onBack ? <ChevronLeft /> : <X />}</IconButton>}
          actions={actions.map((item) => <IconButton key={item.key} size="lg" aria-label={item.label} title={item.label} disabled={item.disabled} onClick={item.onSelect}><item.icon /></IconButton>)}
        />
      ) : (
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            {onBack ? <IconButton size="md" aria-label={t('common.back')} onClick={onBack}><ChevronLeft size={18} /></IconButton> : <FileText size={18} color="var(--text-link)" />}
            <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontSize: 'var(--font-title)' }}>{file.fileName}</strong>
          </div>
          {fullButton}
          <IconButton size="md" aria-label={onBack ? t('common.close') : t('chatArea.filePreview.close')} title={onBack ? t('common.close') : t('chatArea.filePreview.close')} onClick={onClose}><X size={18} /></IconButton>
        </header>
      )}
      {mobile ? null : <div style={{ display: 'flex', gap: 8, padding: '10px 18px', flexShrink: 0 }}>
        {actions.map((item) => <Button key={item.key} variant="secondary" size="sm" aria-label={item.label} title={item.label} disabled={item.disabled} onClick={item.onSelect}><item.icon size={15} />{item.label}</Button>)}
        {onOpenExternal ? <Button variant="secondary" size="sm" aria-label={t('chatArea.filePreview.openExternal')} title={t('chatArea.filePreview.openExternal')} onClick={onOpenExternal}><ExternalLink size={15} />{t('chatArea.filePreview.openExternal')}</Button> : null}
      </div>}
      {/* 大小还不知道(手机附件卡正从那台电脑读,或没读到)就不写,❌ 写一个「0 B」。手机上这一行进了页头。 */}
      {mobile || ((loading || error) && file.sizeBytes === 0) ? null : <div style={{ padding: '0 18px 10px', color: 'var(--text-tertiary)', fontSize: 'var(--font-caption)', flexShrink: 0 }}>{[formatAttachmentSize(file.sizeBytes), typeLabel].filter(Boolean).join(' · ')}</div>}
      <div ref={contentRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', color: 'var(--text-primary)' }}>
        {loading ? <div style={statusStyle} data-testid="message-file-preview-loading">{loadingLabel ?? t('chatArea.filePreview.loading')}{loadingFraction !== undefined ? <progress className="gg-progress" value={loadingFraction} max={1} /> : null}</div> : error ? <div style={{ ...statusStyle, color: 'var(--danger)' }}>{error}</div> : kind === 'video' ? <video data-testid="message-file-preview-video" src={videoUrl} onError={event => onVideoError?.(event.currentTarget)} controls autoPlay playsInline className="block max-h-full w-full" /> : kind === 'unsupported' ? <div style={statusStyle}>{t('chatArea.filePreview.unsupported')}</div> : typeof content === 'string' && (kind === 'text' || kind === 'markdown') ? <div style={{ padding: '16px 18px' }}>{kind === 'markdown' ? <Markdown trust="chat" density="comfortable" content={content} hardBreaks /> : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: 'var(--font-body)', lineHeight: 1.65 }}>{content}</pre>}</div> : <DocumentPreviewContent kind={kind} content={content} title={file.fileName} onOpenExternally={onOpenExternal} />}
      </div>
    </aside>
  )
}

const statusStyle: React.CSSProperties = { padding: '20px 18px', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 1.6 }
