import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { notify, dismissNotice } from '../../lib/notices'
import { openApp } from '../appSlot/useOpenApp'
import { fileStorageUsageClient, fileStorageUsageQuery } from './fileStorageUsage'

// Dismissal lasts until a verified healthy read, including when the composer remounts.
const incidents = new Map<string, { dismissed: boolean }>()
const viewers = new Map<string, number>()

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
  useEffect(() => {
    fileStorageUsageClient.mount()
    return () => fileStorageUsageClient.unmount()
  }, [])
  const usage = useQuery({ ...fileStorageUsageQuery(userId, chatId),
    retry: true,
    retryDelay: attempt => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000),
    // A placed file need not emit a chat message. Refresh only the visible manager's current group.
    refetchInterval: 60_000,
  }, fileStorageUsageClient)
  const refreshPoint = useRef({ key, latest })
  useEffect(() => {
    const previous = refreshPoint.current
    refreshPoint.current = { key, latest }
    if (previous.key === key && previous.latest !== latest) {
      // Share an existing request/retry rather than canceling it and starting another one.
      void fileStorageUsageClient.invalidateQueries({ queryKey: fileStorageUsageQuery(userId, chatId).queryKey, exact: true }, { cancelRefetch: false })
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
