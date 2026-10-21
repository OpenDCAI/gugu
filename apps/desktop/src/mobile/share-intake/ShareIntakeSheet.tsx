import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { formatAttachmentSize, inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { chatDisplayName, isRoomChat } from '@gugu/core/shared/ui/chatModels'
import type { IncomingShare } from '../../platform/types'
import { Avatar } from '../../components/Avatar'
import { IconButton } from '../../components/ui/IconButton'
import { ListRow } from '../../components/ui/ListRow'
import { SearchField } from '../../components/ui/SearchField'
import { UI_EVENTS } from '../../lib/uiEvents'
import { useChatStore } from '../../store/chatContext'
import { mergeShareIntoDraft, shareTargetChats } from './shareTargets'
import './share-intake.css'

/** 缩略图的 blob 地址在同一个 effect 里建、在它的清理里撤 —— StrictMode 重挂一次也拿到新的,❌ 在 render 里建。 */
function Thumbnail({ file }: { file: File }) {
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const url = URL.createObjectURL(file)
    if (ref.current) ref.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])
  return <img ref={ref} alt={file.name} className="gg-si-thumb" />
}

/** 要发的内容:文字、图片缩略图、文件名与大小。 */
function SharePreview({ share }: { share: IncomingShare }) {
  const images = share.files.filter((file) => inferAttachmentKind(file) === 'image')
  const others = share.files.filter((file) => inferAttachmentKind(file) !== 'image')
  return (
    <div className="gg-si-preview">
      {share.text && <div className="gg-si-text">{share.text}</div>}
      {images.length > 0 && (
        <div className="gg-si-thumbs">
          {images.map((file, index) => <Thumbnail key={`${file.name}-${index}`} file={file} />)}
        </div>
      )}
      {others.map((file, index) => (
        <div key={`${file.name}-${index}`} className="gg-si-file">
          <span className="gg-si-file-name">{file.name}</span>
          <span className="gg-si-file-size">{formatAttachmentSize(file.size)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 「发送到」页(product spec):选一条会话,内容放进它的输入框,由用户按发送。
 * ❌ 选完直接发 —— 发送、上传、大小限制都走输入框那一条链路。
 */
export function ShareIntakeContent({ share, onDone }: { share: IncomingShare; onDone: (afterClose?: () => void) => void }) {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById, activeChatId, drafts, draftAttachments, setDraft, setDraftAttachments } = useChatStore(
    'chats', 'identitiesById', 'activeChatId', 'drafts', 'draftAttachments', 'setDraft', 'setDraftAttachments',
  )
  const [query, setQuery] = useState('')
  const displayName = useCallback(
    (chat: ChatItem) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name),
    [identitiesById],
  )
  const targets = useMemo(
    () => shareTargetChats(chats, { query, displayName, activeChatId, drafts }),
    [chats, query, displayName, activeChatId, drafts],
  )
  const hasContent = Boolean(share.text) || share.files.length > 0
  const reasonText = {
    refused: t('shareIntake.reason.refused'),
    tooLarge: t('shareIntake.reason.tooLarge'),
    unreadable: t('shareIntake.reason.unreadable'),
  }

  const sendTo = (chat: ChatItem) => {
    const next = mergeShareIntoDraft(
      { text: drafts[chat.id] ?? '', attachments: draftAttachments[chat.id] ?? [] },
      share,
      () => crypto.randomUUID(),
    )
    setDraft(chat.id, next.text)
    setDraftAttachments(chat.id, next.attachments)
    // 与点通知进会话同一条路:选中、切到对话、手机壳下钻到会话页、聚焦输入框。
    onDone(() => window.dispatchEvent(new CustomEvent(UI_EVENTS.notificationClicked, { detail: { chatId: chat.id } })))
  }

  return (
      <div className="gg-si">
        <div className="gg-si-head">
          <IconButton aria-label={t('shareIntake.back')} size="lg" onClick={() => onDone()}>
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 5l-7 7l7 7" /></svg>
          </IconButton>
          <span className="gg-si-title">{t('shareIntake.title')}</span>
        </div>

        <div className="gg-si-top">
          {hasContent ? <SharePreview share={share} /> : <span className="gg-si-note">{t('shareIntake.nothingToSend')}</span>}
          {share.failures.length > 0 && (
            <span data-testid="share-intake-failures" className="gg-si-failures">
              {t('shareIntake.failures', {
                names: share.failures
                  .map((failure) => failure.name ? `${failure.name}(${reasonText[failure.reason]})` : reasonText[failure.reason])
                  .join(t('shareIntake.listSeparator')),
              })}
            </span>
          )}
          {hasContent && (
            <SearchField value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('shareIntake.searchChats')} />
          )}
        </div>

        {hasContent && (
          <div className="gg-si-list">
            {targets.length === 0 && (
              <div className="gg-si-empty">{query.trim() ? t('shareIntake.noResults') : t('shareIntake.noChats')}</div>
            )}
            {targets.map((chat) => {
              const identity = identitiesById[chat.peer_user_id ?? '']
              return (
                <ListRow
                  key={chat.id}
                  role="button"
                  tabIndex={0}
                  data-share-target={chat.id}
                  mobile
                  onClick={() => sendTo(chat)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sendTo(chat) } }}
                  // @@@2470 群没有 peer_user_id:要标 variant='group',口径同 ChatListPanel / ForwardMessageDialog。
                  leading={
                    <Avatar
                      name={displayName(chat)}
                      avatarUrl={isRoomChat(chat.kind) ? chat.avatar : identity?.avatar}
                      seed={chat.peer_user_id ?? undefined}
                      size="sm"
                      isAgent={identity?.type === 'agent'}
                      variant={isRoomChat(chat.kind) ? 'group' : 'default'}
                      memberAvatars={chat.member_user_ids?.flatMap((id) => identitiesById[id] ? [{ id, name: identitiesById[id].display_name, avatar: identitiesById[id].avatar }] : [])}
                    />
                  }
                  title={displayName(chat)}
                />
              )
            })}
          </div>
        )}
      </div>
  )
}
