import { ChevronLeft, Download, ExternalLink, FileText, X } from '@/lib/icons'
import { formatAttachmentSize, type AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { PaneHeader } from '../ui/Pane'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../markdown/Markdown'
import { DocumentPreviewContent } from './DocumentPreviewContent'
import type { DocumentPreviewKind } from './documentPreview'

export interface MessageFilePreviewPanelProps {
  file: Pick<AttachmentMeta, 'fileName' | 'sizeBytes' | 'mimeType'>
  /** 视频:<video> 按需分段取的那个链接(❌ 整段读进内存)。 */
  videoUrl?: string
  kind: DocumentPreviewKind
  content: string | ArrayBuffer | null
  loading: boolean
  error?: string
  /** 读的时候那一行字(手机附件卡:「正在从那台电脑取 2.0 MB / 6.0 MB」)。不给 = 通用的「加载中」。 */
  loadingLabel?: string
  /** 读到几成(0–1),给了就在那行字下面画一条进度。 */
  loadingFraction?: number
  /** 下载。不给 = 还没有可下载的字节(手机附件卡读到之前),不摆这一枚。 */
  onDownload?: () => void
  /** 交给系统打开。不给 = 这份文件没有可交出去的地址(手机从那台电脑现读的附件卡,#7193),不摆这一枚。 */
  onOpenExternal?: () => void
  onClose: () => void
  mobile?: boolean
  /** Fills the box it is put in (beside an App, AppPeek) instead of taking a side panel's width. */
  fill?: boolean
}

export function MessageFilePreviewPanel({ file, videoUrl, kind, content, loading, error, loadingLabel, loadingFraction, onDownload, onOpenExternal, onClose, mobile = false, fill = false }: MessageFilePreviewPanelProps) {
  const { t } = useTranslation('messaging')
  // 手机页头第二行:扩展名 + 大小(「HTML · 791 B」);大小还不知道就只写扩展名。❌ MIME 原文。
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(file.fileName)?.[1]?.toUpperCase() ?? null
  const meta = [extension, file.sizeBytes > 0 ? formatAttachmentSize(file.sizeBytes) : null].filter(Boolean).join(' · ')
  return (
    <aside data-testid="message-file-preview-panel" data-preview-kind={kind} style={{ width: mobile || fill ? '100%' : 'clamp(380px, 38vw, 520px)', height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: mobile ? undefined : '1px solid var(--border-subtle)', background: 'var(--bg-primary)' }}>
      {/* 手机上是一整页:出口是左上返回,与话题页 / 会话页同一副页头(移动端规范);桌面是右栏,右上 ✕。 */}
      {/* 手机照系统文件预览(iOS 快速查看 / 微信):文件名下一行小字「HTML · 791 B」,下载与外部打开是右上角的图标,
          正文从页头下面直接开始。owner 10-15:「手机端过于简陋,尤其是下载按钮」—— 原来是一排单独的大按钮 + 一行 MIME 原文。 */}
      {mobile ? (
        <PaneHeader
          mobile
          divider
          title={
            <span className="gg-pane-title-stack">
              <h2 className="gg-pane-title">{file.fileName}</h2>
              {meta ? <span data-testid="message-file-preview-meta" className="gg-pane-meta">{meta}</span> : null}
            </span>
          }
          leading={<IconButton size="lg" aria-label={t('common.back')} onClick={onClose}><ChevronLeft /></IconButton>}
          actions={onDownload || onOpenExternal ? (
            <>
              {onOpenExternal ? <IconButton size="lg" aria-label={t('chatArea.filePreview.openExternal')} title={t('chatArea.filePreview.openExternal')} onClick={onOpenExternal}><ExternalLink /></IconButton> : null}
              {onDownload ? <IconButton size="lg" aria-label={t('chatArea.filePreview.download')} title={t('chatArea.filePreview.download')} onClick={onDownload}><Download /></IconButton> : null}
            </>
          ) : undefined}
        />
      ) : (
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <FileText size={18} color="var(--text-link)" />
            <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontSize: 'var(--font-title)' }}>{file.fileName}</strong>
          </div>
          <IconButton size="md" aria-label={t('chatArea.filePreview.close')} title={t('chatArea.filePreview.close')} onClick={onClose}><X size={18} /></IconButton>
        </header>
      )}
      {/* 2026-09-22 按 design.md:顶部原来三条横线叠着(header/动作条/元信息),现只留 header 下那条,其余靠 padding 分组。规格 §6.6 */}
      {mobile ? null : <div style={{ display: 'flex', gap: 8, padding: '10px 18px', flexShrink: 0 }}>
        {onDownload ? <Button variant="secondary" size="sm" aria-label={t('chatArea.filePreview.download')} title={t('chatArea.filePreview.download')} onClick={onDownload} style={actionButtonStyle}><Download size={15} />{t('chatArea.filePreview.download')}</Button> : null}
        {onOpenExternal ? <Button variant="secondary" size="sm" aria-label={t('chatArea.filePreview.openExternal')} title={t('chatArea.filePreview.openExternal')} onClick={onOpenExternal} style={actionButtonStyle}><ExternalLink size={15} />{t('chatArea.filePreview.openExternal')}</Button> : null}
      </div>}
      {/* 大小还不知道(手机附件卡正从那台电脑读,或没读到)就不写,❌ 写一个「0 B」。手机上这一行进了页头。 */}
      {mobile || ((loading || error) && file.sizeBytes === 0) ? null : <div style={{ padding: '0 18px 10px', color: 'var(--text-tertiary)', fontSize: 'var(--font-caption)', flexShrink: 0 }}>{formatAttachmentSize(file.sizeBytes)}{file.mimeType ? ` · ${file.mimeType}` : ''}</div>}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', color: 'var(--text-primary)' }}>
        {loading ? <div style={statusStyle} data-testid="message-file-preview-loading">{loadingLabel ?? t('chatArea.filePreview.loading')}{loadingFraction !== undefined ? <progress className="gg-progress" value={loadingFraction} max={1} /> : null}</div> : error ? <div style={{ ...statusStyle, color: 'var(--danger)' }}>{error}</div> : kind === 'video' ? <video data-testid="message-file-preview-video" src={videoUrl} controls autoPlay playsInline className="block max-h-full w-full" /> : kind === 'unsupported' ? <div style={statusStyle}>{t('chatArea.filePreview.unsupported')}</div> : kind === 'html' ? <DocumentPreviewContent kind={kind} content={content} title={file.fileName} onOpenExternally={onOpenExternal} /> : typeof content === 'string' ? <div style={{ padding: '16px 18px' }}>{kind === 'markdown' ? <Markdown trust="chat" density="comfortable" content={content} hardBreaks /> : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: 'var(--font-body)', lineHeight: 1.65 }}>{content}</pre>}</div> : <DocumentPreviewContent kind={kind} content={content} title={file.fileName} onOpenExternally={onOpenExternal} />}
      </div>
    </aside>
  )
}

const actionButtonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', cursor: 'pointer' }
const statusStyle: React.CSSProperties = { padding: '20px 18px', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 1.6 }
