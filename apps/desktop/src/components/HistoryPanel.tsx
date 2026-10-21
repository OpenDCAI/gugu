/**
 * HistoryPanel — 会话级「历史」侧面板。
 * 群聊中间 tab 是线程；私聊中间 tab 是只读导入历史。消息附件由两种会话共享。
 *
 * 设计稿 #hist 的类名对应：
 *   .hist/#hist → .gg-hist          .hh → .gg-hist-hh         .ic → .gg-hist-close
 *   .htabs → .gg-hist-tabs          .htab(.on) → .gg-htab(.gg-on)
 *   .hbody → .gg-hist-body          .subf → .gg-subf
 *   .hcard → .gg-hcard              .ht/.hd → .gg-ht/.gg-hd
 *   .hcard.hfile → .gg-hcard.gg-hfile   .hdl → .gg-hdl
 *
 * 纯展示组件，props 驱动（数据由 ChatAreaPanel 装配）。滑入动画由外层 motion.div 负责。
 * 附件卡片复用消息附件组件。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { formatCalendarDay } from '../lib/calendarTime'
import { cn } from '@/lib/cn'
import { Plus, XCircle } from '@/lib/icons'
import { Button } from './ui/Button'
import { SearchField } from './ui/SearchField'
import { HeaderSearch } from './ui/HeaderSearch'
import { useChatStore } from '../store/chatContext'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { FileAttachmentCard } from './chat/FileAttachmentCard'
import { defaultHistoryTab, filterTopicsByQuery, pageHistoryTopics, type HistoryTab } from './historyPanelModels'

// @@@5856 这条线上长出来的一条话题(product spec)。它取代了原来的 HistoryThreadItem ——
// 老的「线程」是同一个 chat 里挂 root 的回复串;话题是**另一条线**,所以这里的键是 chatId 不是 rootId。
export interface HistoryTopicItem {
  chatId: string
  title: string
  participantCount: number
  messageCount: number
  lastMessageAt: string | null
  /** 我是不是参与者。可见继承来源 ⇒ 看得见不等于会被通知,列表要让这两件事分得开。 */
  isParticipant: boolean
}

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

type TopicFilter = 'all' | 'mine'
type FileFilter = 'all' | 'image' | 'file'

interface CommonHistoryPanelProps {
  initialTab?: HistoryTab
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

export type HistoryPanelProps = CommonHistoryPanelProps & (
  | {
      mode: 'group'
      topics: HistoryTopicItem[]
      onOpenTopic: (chatId: string, title: string) => void
      /**
       * @@@5856 spec 的**第二个**创建口:「某条线顶栏的话题面板里」。
       * 它照样「必须有来源」——挂到这条线**最新的那条消息**上,名字仍由服务端从那条消息截。
       * 所以它是一步完成的,❌ 没有挑消息、没有勾成员、没有确认按钮(那就成了 spec 反对的那张表)。
       * 这条线上一条消息都没有时给 undefined:没有来源就开不出话题,那时这颗按钮不该在。
       */
      onCreateTopic?: () => void
      importedHistory?: never
    }
  | {
      // 私聊同样是一条线,同样能从它的消息上长出话题 ⇒ 顶栏面板里也要列得出、开得出。
      // spec 说的是「某条线顶栏的话题面板」,不是「某个群」。
      mode: 'private'
      importedHistory: ReactNode
      topics: HistoryTopicItem[]
      onOpenTopic: (chatId: string, title: string) => void
      onCreateTopic?: () => void
    }
  // @@@5856 话题既不是群也不是私聊:它下面不再长话题(单层不嵌套),也没有导入历史(那是私聊的东西)。
  // ⇒ 第三支,只有「附件」一个 tab。❌ 不要把它塞进 'private':那会渲染出一个永远转圈的
  // 「导入历史」tab(话题压根不加载导入历史)。
  | {
      mode: 'topic'
      topics?: never
      onOpenTopic?: never
      importedHistory?: never
    }
)

const historyPanelClass = 'gg-hist flex h-full flex-col overflow-hidden bg-[var(--bg)]'
const historyHeaderClass = 'gg-hist-hh flex items-center justify-between !px-[18px] !pb-3 !pt-[30px] text-[length:var(--font-title)] font-semibold text-[var(--fg)]'
const historyCloseClass = 'gg-hist-close grid cursor-pointer place-items-center text-[var(--muted-fg)] hover:text-[var(--fg)]'
const historyTabsClass = 'gg-hist-tabs flex gap-1.5 border-b border-[var(--border)] !px-[18px] !pb-3'
const historyBodyClass = 'gg-hist-body min-h-0 flex-1 overflow-y-auto !px-[18px] !py-3.5'
const historySubFilterClass = 'gg-subf flex items-center gap-1.5 !mb-3'
const historyCardClass = 'gg-hcard flex items-center gap-[11px] rounded-xl border border-[var(--border)] !p-[11px] !mb-2'
const historyClickableCardClass = `${historyCardClass} gg-hfile cursor-pointer transition-[background] duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-[var(--hover)]`
const historyTextClass = 'gg-ht text-[length:var(--font-body)] font-medium text-[var(--fg)]'
const historyDimTextClass = 'gg-hd !mt-px text-[length:var(--font-caption)] text-[var(--faint-fg)]'
const historyColumnClass = 'gg-hcol min-w-0 flex-1'
const historyTitleClipClass = `${historyTextClass} overflow-hidden text-ellipsis whitespace-nowrap`
const historyEmptyClass = 'gg-hist-empty !py-10 text-center text-xs text-[var(--faint-fg)]'

function historyTabClass(active: boolean): string {
  return cn('gg-htab', historySelectionClass(active))
}

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
  // 「默认落在哪个 tab」的理由写在 defaultHistoryTab 上,它在 historyPanelModels 里可单测。
  const [tab, setTab] = useState<HistoryTab>(() => props.mode === 'topic' ? 'attachments' : (props.initialTab ?? defaultHistoryTab(props.mode)))
  const [topicFilter, setTopicFilter] = useState<TopicFilter>('all')
  const [topicQuery, setTopicQuery] = useState('')
  const [topicPages, setTopicPages] = useState(1)
  const bodyRef = useRef<HTMLDivElement>(null)
  const nextTopicsRef = useRef<HTMLDivElement>(null)
  const [fileFilter, setFileFilter] = useState<FileFilter>('all')

  // 「我的」= 我参与的那些。可见但没参与的仍然列在「全部」里 —— 那正是可见/参与分开的用户可感形态。
  const matchingTopics = filterTopicsByQuery(props.mode === 'topic'
    ? []
    : (topicFilter === 'mine' ? props.topics.filter((t) => t.isParticipant) : props.topics), topicQuery)
  const { shown: shownTopics, remaining: remainingTopics } = pageHistoryTopics(matchingTopics, topicPages)
  const shownFiles = fileFilter === 'all' ? attachments : attachments.filter((f) => f.kind === (fileFilter === 'image' ? 'image' : 'file'))

  // Only the panel's own scroll viewport can request another page.
  useEffect(() => {
    if (loading || tab !== 'topics' || remainingTopics === 0 || !nextTopicsRef.current) return
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (!active || !entries.some((entry) => entry.isIntersecting)) return
      active = false
      observer.disconnect()
      setTopicPages((pages) => pages + 1)
    }, { root: bodyRef.current, rootMargin: '0px 0px 120px 0px' })
    observer.observe(nextTopicsRef.current)
    return () => { active = false; observer.disconnect() }
  }, [loading, tab, remainingTopics, topicQuery, topicFilter])

  const resetTopicPage = () => {
    setTopicPages(1)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }
  const searchTopics = (value: string) => {
    setTopicQuery(value)
    resetTopicPage()
  }

  return (
    <aside data-testid="history-panel" className={historyPanelClass}>
      <HeaderSearch mobile={mobile && props.mode !== 'topic' && tab === 'topics'} value={topicQuery} onChange={searchTopics} placeholder={t('history.searchTopics')}>{(searchButton) => (
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
        {t('history.title')}
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
        {searchButton ? <span className="!ml-auto">{searchButton}</span> : null}
      </div>
      )}</HeaderSearch>
      <div className={historyTabsClass}>
        {props.mode !== 'topic' ? (
          <button className={historyTabClass(tab === 'topics')} onClick={() => setTab('topics')}>{t('history.tabs.topics')}</button>
        ) : null}
        {props.mode === 'private' ? (
          <button className={historyTabClass(tab === 'imported')} onClick={() => setTab('imported')}>{t('history.tabs.imported')}</button>
        ) : null}
        <button className={historyTabClass(tab === 'attachments')} onClick={() => setTab('attachments')}>{t('history.tabs.attachments')}</button>
      </div>
      <div ref={bodyRef} className={historyBodyClass}>
        {loading && <div className={historyEmptyClass}>{t('common.loading')}</div>}

        {/* 话题 tab */}
        {!loading && props.mode !== 'topic' && tab === 'topics' && (
          <>
            {!mobile && (
              <SearchField
                className="mb-3"
                placeholder={t('history.searchTopics')}
                value={topicQuery}
                onValueChange={searchTopics}
                clearLabel={t('chatList.clearSearch')}
                onClear={() => searchTopics('')}
              />
            )}
            <div className={historySubFilterClass}>
              <button className={historySelectionClass(topicFilter === 'all')} onClick={() => { setTopicFilter('all'); resetTopicPage() }}>{t('history.filters.all')}</button>
              <button className={historySelectionClass(topicFilter === 'mine')} onClick={() => { setTopicFilter('mine'); resetTopicPage() }}>{t('history.filters.mine')}</button>
              {props.onCreateTopic ? (
                // ❌ 不许长得像它左边那两个筛选胶囊:那是筛选,这是**会建出一条新线**的动作,
                // 而话题在产品里没有删除。挤在一起误点的代价是凭空多一条线。
                // ⇒ 推到行尾、换成带 ＋ 的 secondary 按钮,形状上就和筛选分开。
                // ⚠️ 这里走 ui/Button:rawButtons 闸只降不升,且注释里不许出现那个手写标签的字面量
                //    —— 闸是纯文本正则,注释也计数。
                <Button
                  data-testid="history-create-topic"
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  onClick={props.onCreateTopic}
                >
                  <Plus size={12} />
                  {t('history.createTopic')}
                </Button>
              ) : null}
            </div>
            {shownTopics.length === 0 ? (
              <div className={historyEmptyClass}>{t(topicQuery.trim() ? 'history.empty.searchTopics' : 'history.empty.topics')}</div>
            ) : (
              shownTopics.map((topic) => (
                <div
                  key={topic.chatId}
                  data-testid="history-topic-card"
                  className={historyClickableCardClass}
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onOpenTopic(topic.chatId, topic.title)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onOpenTopic(topic.chatId, topic.title) } }}
                >
                  <div className={historyColumnClass}>
                    <div className={historyTitleClipClass}>{topic.title}</div>
                    <div className={historyDimTextClass}>{t('history.topicMeta', { participantCount: topic.participantCount, messageCount: topic.messageCount, date: formatCalendarDay(topic.lastMessageAt) })}</div>
                  </div>
                </div>
              ))
            )}
            {remainingTopics > 0 && <div ref={nextTopicsRef} data-testid="history-topics-next-page" className="h-px" aria-hidden="true" />}
          </>
        )}

        {!loading && props.mode === 'private' && tab === 'imported' ? props.importedHistory : null}

        {/* 附件 tab */}
        {!loading && tab === 'attachments' && (
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
