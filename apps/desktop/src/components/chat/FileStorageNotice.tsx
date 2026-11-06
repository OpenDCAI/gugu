import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { chatDb } from '../../lib/supabase'
import { attachmentQuery, attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { Button } from '../ui/Button'

type Usage = { used_and_reserved_bytes: number; limit_bytes: number; warning: boolean; full: boolean }

/** A group's file storage usage, read as one of its managers. Key: manager, group, latest attachment (refresh point). */
const fileStorageUsageQuery = attachmentQuery('file-storage-usage', async (userId: string, chatId: string, _latest: string | undefined) => {
  const { data, error } = await chatDb.rpc('file_transfer_group_usage', { p_chat: chatId, p_as: userId })
  if (error) throw new Error(error.message)
  const row = data as Usage | null
  if (!row || !Number.isSafeInteger(row.used_and_reserved_bytes) || row.used_and_reserved_bytes < 0 ||
    !Number.isSafeInteger(row.limit_bytes) || row.limit_bytes < 0 || typeof row.warning !== 'boolean' || typeof row.full !== 'boolean') {
    throw new Error('Invalid group file usage response')
  }
  return row
})

/** Only the current group's managers query usage. This is metadata, never a file download. */
export function FileStorageNotice({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { chats, messages } = useChatStore('chats', 'messages')
  const chat = chats.find(row => row.id === chatId)
  const allowed = !!user && chat?.kind === 'group' && (chat.my_role === 'owner' || chat.my_role === 'admin')
  const latest = messages.findLast(row => row.chat_id === chatId && row.content_type === 'attachment')?.id
  const usage = useQuery({ ...fileStorageUsageQuery(user?.id ?? '', chatId, latest), enabled: allowed,
    // A placed file need not emit a chat message. Refresh only the visible manager's current group.
    refetchInterval: 60_000,
  }, attachmentQueryClient)
  if (!allowed || !usage.isError && !usage.data?.warning && !usage.data?.full) return null
  return <div role="status" className="mb-2 flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
    <span className="min-w-0 flex-1">{usage.isError ? t('attachmentView.usageUnavailable') : t(usage.data!.full ? 'attachmentView.storageFull' : 'attachmentView.storageWarning', {
      used: formatAttachmentSize(usage.data!.used_and_reserved_bytes), limit: formatAttachmentSize(usage.data!.limit_bytes),
    })}</span>
    {usage.isError && <Button variant="ghost" size="sm" onClick={() => void usage.refetch()}>{t('attachmentView.retry')}</Button>}
  </div>
}
