import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { chatPickRow, forwardPreview, forwardableChats } from './forwardMessageUtils'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { ChatPickSheet } from './ChatPickSheet'
import { useChatStore } from '../../store/chatContext'
import { ShareToAppsRow } from '../share/ShareToAppsRow'

interface ForwardMessageDialogProps {
  // @@@multi-select (#988) - one or many messages to forward. Single-forward passes [msg];
  // batch (multi-select) passes the selected list. The caller (handleForwardTo) fans out
  // messages × targetChatIds, so this dialog only needs the count for the preview.
  messages?: MessageItem[]
  /** #6646 Forwarding something other than messages (an extension package): its preview and top row. */
  preview?: ReactNode
  topRow?: ReactNode
  chats: ChatItem[]
  /** Source chat — excluded from the target list. */
  sourceChatId: string
  /** Forward the message(s) into every selected chat. Rejects to surface an error. */
  onForward: (targetChatIds: string[]) => Promise<void>
  onClose: () => void
}

export function ForwardMessageDialog({ messages = [], preview: subject, topRow, chats, sourceChatId, onForward, onClose }: ForwardMessageDialogProps) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [forwarding, setForwarding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // @@@5856 转发目标的名字:场所(群 + 话题)用自己的名字,dm/ai 用对端。
  // 写死 kind === 'group' 的后果有两层:话题在列表里是**一行空白**,而且 forwardableChats 用同一个
  // 函数做搜索匹配 ⇒ 按名字**永远搜不到话题**。spec「跨线引用留痕」的出处那一半做了,目的地这一半选不中。
  const forwardTargetName = useCallback(
    (chat: ChatItem) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name),
    [identitiesById],
  )
  const visibleChats = useMemo(
    () => forwardableChats(chats, sourceChatId, query, forwardTargetName),
    [chats, sourceChatId, query, forwardTargetName],
  )

  const handleForward = useCallback(async () => {
    if (selected.size === 0) {
      setError(t('forward.selectAtLeastOne'))
      return
    }
    setForwarding(true)
    setError(null)
    try {
      await onForward(Array.from(selected))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('forward.failed'))
    } finally {
      setForwarding(false)
    }
  }, [selected, onForward, onClose, t])

  // Only mounted by callers when there is ≥1 message; guard the impossible-empty case so the
  // single-message preview branch can deref messages[0] without an optional chain.
  const first = messages[0]
  if (!first && subject === undefined) return null

  const isBatch = messages.length > 1
  const preview = first && forwardPreview(first, {
    attachment: t('forward.preview.attachment'),
    card: t('forward.preview.card'),
    empty: t('forward.preview.empty'),
  })
  const canForward = selected.size > 0 && !forwarding

  return (
    <ChatPickSheet
      title={t('forward.title')}
      onClose={onClose}
      testId="forward-message-dialog"
      rows={visibleChats.map((chat) => chatPickRow(chat, forwardTargetName(chat), identitiesById))}
      selected={selected}
      onToggle={toggle}
      query={query}
      onQuery={setQuery}
      placeholder={t('forward.searchChats')}
      empty={chats.length <= 1 ? t('forward.noTargets') : t('forward.noResults')}
      top={topRow ?? <ShareToAppsRow messages={messages} onClose={onClose} />}
      above={
        // Forwarded message preview
        <div
          style={{
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-document)',
            padding: '8px 10px',
            background: 'var(--bg-secondary)',
            fontSize: 'var(--font-body)',
            color: 'var(--text-secondary)',
            maxHeight: 64,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            whiteSpace: 'pre-wrap',
          }}
        >
          {subject ?? (isBatch ? (
            <span style={{ color: 'var(--text-secondary)' }}>{t('forward.batchPreview', { count: messages.length })}</span>
          ) : (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>{identitiesById[first?.sender_user_id ?? '']?.display_name ?? ''}：</span>
              {preview}
            </>
          ))}
        </div>
      }
      picked={t('forward.selected', { count: selected.size })}
      actionLabel={forwarding ? t('forward.forwarding') : t('forward.title')}
      onAction={() => void handleForward()}
      actionDisabled={!canForward}
      error={error}
    />
  )
}
