import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { chatDb } from '../../lib/supabase'
import { attachmentQuery, attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { rendererLogger } from '../../lib/log'
import { notify, dismissNotice } from '../../lib/notices'
import { openApp } from '../appSlot/useOpenApp'

type Usage = { used_and_reserved_bytes: number; limit_bytes: number; warning: boolean; full: boolean }
const log = rendererLogger('files/storage-usage')
// Dismissal lasts until a verified healthy read, including when the composer remounts.
const incidents = new Map<string, { dismissed: boolean }>()
const viewers = new Map<string, number>()

/** One cache entry per account/group: an attachment refresh must retain the last verified usage. */
const fileStorageUsageQuery = attachmentQuery('file-storage-usage', async (userId: string, chatId: string) => {
  try {
    const { data, error } = await chatDb.rpc('file_transfer_group_usage', { p_chat: chatId, p_as: userId })
    if (error) throw new Error(error.message, { cause: error })
    const row = data as Usage | null
    if (!row || !Number.isSafeInteger(row.used_and_reserved_bytes) || row.used_and_reserved_bytes < 0 ||
      !Number.isSafeInteger(row.limit_bytes) || row.limit_bytes < 0 || typeof row.warning !== 'boolean' || typeof row.full !== 'boolean') {
      throw new Error('Invalid group file usage response')
    }
    return row
  } catch (error) {
    log.error({ userId, chatId, error: String(error), cause: error instanceof Error ? error.cause : undefined }, 'could not read group file storage usage')
    throw error
  }
})

/** Only the current group's managers query usage. This is metadata, never a file download. */
export function FileStorageNotice({ chatId }: { chatId: string }) {
  const { user } = useAuth()
  const { chats, messages } = useChatStore('chats', 'messages')
  const chat = chats.find(row => row.id === chatId)
  const allowed = !!user && chat?.kind === 'group' && (chat.my_role === 'owner' || chat.my_role === 'admin')
  const latest = messages.findLast(row => row.chat_id === chatId && row.content_type === 'attachment')?.id
  return allowed ? <ManagerStorageNotice key={`${user.id}:${chatId}`} userId={user.id} chatId={chatId} latest={latest} /> : null
}

function ManagerStorageNotice({ userId, chatId, latest }: { userId: string; chatId: string; latest?: string }) {
  const { t } = useTranslation('messaging')
  const key = `file-storage:${userId}:${chatId}`
  const usage = useQuery({ ...fileStorageUsageQuery(userId, chatId),
    retry: true,
    retryDelay: attempt => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000),
    // A placed file need not emit a chat message. Refresh only the visible manager's current group.
    refetchInterval: 60_000,
  }, attachmentQueryClient)
  const refreshPoint = useRef({ key, latest })
  useEffect(() => {
    const previous = refreshPoint.current
    refreshPoint.current = { key, latest }
    if (previous.key === key && previous.latest !== latest) {
      // Share an existing request/retry rather than canceling it and starting another one.
      void attachmentQueryClient.invalidateQueries({ queryKey: fileStorageUsageQuery(userId, chatId).queryKey, exact: true }, { cancelRefetch: false })
    }
  }, [key, latest, userId, chatId])

  useEffect(() => {
    viewers.set(key, (viewers.get(key) ?? 0) + 1)
    return () => {
      const remaining = (viewers.get(key) ?? 1) - 1
      if (remaining > 0) viewers.set(key, remaining)
      else {
        viewers.delete(key)
        dismissNotice(key)
      }
    }
  }, [key])

  const data = usage.data
  useEffect(() => {
    // Missing data is unknown, and a failed refresh leaves the verified facts intact.
    if (!data) return
    if (!data.warning && !data.full) {
      incidents.delete(key)
      dismissNotice(key)
      return
    }
    const incident = incidents.get(key) ?? { dismissed: false }
    incidents.set(key, incident)
    if (incident.dismissed) return
    notify({
      key,
      title: t(data.full ? 'attachmentView.storageFull' : 'attachmentView.storageWarning', {
        used: formatAttachmentSize(data.used_and_reserved_bytes), limit: formatAttachmentSize(data.limit_bytes),
      }),
      tier: 'warning',
      ongoing: true,
      // The existing chat-folder route is also used by the header's Folder command.
      action: { label: t('attachmentView.manageFiles'), onClick: () => openApp('workspace', chatId) },
      onDismiss: () => { if (incidents.get(key) === incident) incident.dismissed = true },
    })
  }, [data, key, chatId, t])
  return null
}
