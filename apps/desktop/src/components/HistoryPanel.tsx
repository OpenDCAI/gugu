import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { formatCalendarDay } from '@/i18n/format'
import { cn } from '@/lib/cn'
import { XCircle } from '@/lib/icons'
import { useChatStore } from '../store/chatContext'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { FileAttachmentCard } from './chat/FileAttachmentCard'

export interface HistoryFileItem {
  messageId: string
  kind: 'image' | 'file'
  fileName: string
  mimeType: string
  sizeBytes: number
  senderId: string
  createdAt: string
  /** 字节从哪来(老消息的公开 URL / 群文件夹条目的某一版 / 已删)。 */
  source: AttachmentSource
}

type FileFilter = 'all' | 'image' | 'file'

interface HistoryPanelProps {
  attachments: HistoryFileItem[]
  /** 各 tab 数据加载中（合并为一个，简单足够）。 */
  loading?: boolean
  /** 点文件卡 = 打开该文件（图片→查看器 / 文件→预览）。
   *  设计稿原意是「跳到对应消息位置」，但窗口外消息跳转需独立的分页定位能力（gugu 暂无）→ 退而打开文件，等效可达。 */
  onOpenFile: (file: HistoryFileItem) => void
  /** 点下载键 = 下载该文件。 */
  onDownloadFile: (file: HistoryFileItem) => void
  onClose: () => void
  // @@@1787 手机化:全宽页 + 左上返回箭头(❌桌面式右上✗)
  mobile?: boolean
}

const historyPanelClass = 'gg-hist flex h-full flex-col overflow-hidden bg-[var(--bg)]'
const historyHeaderClass = 'gg-hist-hh flex items-center justify-between !px-[18px] !pb-3 !pt-[30px] text-[length:var(--font-title)] font-semibold text-[var(--fg)]'
const historyCloseClass = 'gg-hist-close grid cursor-pointer place-items-center text-[var(--muted-fg)] hover:text-[var(--fg)]'
const historyBodyClass = 'gg-hist-body min-h-0 flex-1 overflow-y-auto !px-[18px] !py-3.5'
const historySubFilterClass = 'gg-subf flex items-center gap-1.5 !mb-3'
const historyEmptyClass = 'gg-hist-empty !py-10 text-center text-xs text-[var(--faint-fg)]'

function historySelectionClass(active: boolean): string {
  return cn(
    'gg-pressable relative inline-flex min-h-[var(--control-h-sm)] shrink-0 items-center justify-center whitespace-nowrap cursor-pointer rounded-[var(--radius-capsule)] border-none !px-[13px] !py-1.5 font-[inherit] text-[length:var(--font-body)] font-medium leading-none',
    // Keep the visible pill compact while extending its mobile hit area to 44px.
    "max-[719px]:after:absolute max-[719px]:after:inset-x-0 max-[719px]:after:top-1/2 max-[719px]:after:h-[var(--control-h-touch)] max-[719px]:after:-translate-y-1/2 max-[719px]:after:content-['']",
    active ? 'gg-on bg-[var(--muted)] text-[var(--fg)]' : 'bg-transparent text-[var(--muted-fg)] hover:bg-[var(--hover)]',
  )
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const {
    attachments,
    loading,
    onOpenFile,
    onDownloadFile,
    onClose,
    mobile = false,
  } = props
  const [fileFilter, setFileFilter] = useState<FileFilter>('all')

  const shownFiles = fileFilter === 'all' ? attachments : attachments.filter((f) => f.kind === (fileFilter === 'image' ? 'image' : 'file'))

  return (
    <aside data-testid="history-panel" className={historyPanelClass}>
      <div className={historyHeaderClass} style={mobile ? { paddingTop: 12, paddingBottom: 10, paddingLeft: 8, justifyContent: 'flex-start', gap: 2, fontSize: 16 } : undefined}>
        {mobile ? (
          <button
            type="button"
            className="gg-pressable"
            aria-label={t('common.back')}
            onClick={onClose}
            style={{ width: 38, height: 38, border: 'none', borderRadius: 'var(--radius-xl)', background: 'transparent', color: 'var(--muted-fg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 5l-7 7l7 7"/></svg>
          </button>
        ) : null}
        {t('history.tabs.attachments')}
        {!mobile ? (
        <span
          className={historyCloseClass}
          role="button"
          tabIndex={0}
          title={t('common.close')}
          aria-label={t('common.close')}
          onClick={onClose}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onClose()
            }
          }}
        >
          <XCircle size={16} />
        </span>
        ) : null}
      </div>
      <div className={historyBodyClass}>
        {loading && <div className={historyEmptyClass}>{t('common.loading')}</div>}

        {/* 附件 tab */}
        {!loading && (
          <>
            <div className={historySubFilterClass}>
              <button className={historySelectionClass(fileFilter === 'all')} onClick={() => setFileFilter('all')}>{t('history.filters.all')}</button>
              <button className={historySelectionClass(fileFilter === 'image')} onClick={() => setFileFilter('image')}>{t('history.filters.images')}</button>
              <button className={historySelectionClass(fileFilter === 'file')} onClick={() => setFileFilter('file')}>{t('history.filters.documents')}</button>
            </div>
            {shownFiles.length === 0 ? (
              <div className={historyEmptyClass}>{t('history.empty.attachments')}</div>
            ) : (
              shownFiles.map((f) => (
                <FileAttachmentCard
                  key={f.messageId}
                  file={f}
                  resource={f.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: f.source.itemId, version: f.source.version } } : undefined}
                  details={t('history.fileMeta', { senderName: resolveOrLoud(identitiesById[f.senderId]?.display_name, `history file sender ${f.senderId} for message ${f.messageId}`), size: formatAttachmentSize(f.sizeBytes), date: formatCalendarDay(f.createdAt) })}
                  onOpen={() => onOpenFile(f)}
                  onDownload={() => onDownloadFile(f)}
                  downloadLabel={t('history.downloadFile', { fileName: f.fileName })}
                />
              ))
            )}
          </>
        )}
      </div>
    </aside>
  )
}
