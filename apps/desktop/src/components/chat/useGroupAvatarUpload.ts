import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatService } from '../../lib/chat'
import { useToast } from '../toastContext'

/** The group's avatar upload keeps the same validation, write and failure feedback. */
export function useGroupAvatarUpload({ chatId, viewerIsManager, setAvatarUrl, setActionError }: {
  chatId: string
  viewerIsManager: boolean
  setAvatarUrl: (url: string) => void
  setActionError: (error: string | null) => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [avatarUploading, setAvatarUploading] = useState(false)
  // @@@group-avatar (#1164 G1) manager 选/拖图 → 校验(image/* + ≤5MB) → 上传 → 即时换头像。
  const handleAvatarFile = useCallback(async (file: File | null | undefined) => {
    if (!viewerIsManager || avatarUploading || !file) return
    if (!file.type.startsWith('image/')) { setActionError(t('group.settings.imageRequired')); return }
    if (file.size > 5 * 1024 * 1024) { setActionError(t('group.settings.imageTooLarge')); return }
    setAvatarUploading(true)
    setActionError(null)
    try {
      setAvatarUrl(await chatService.uploadGroupAvatar(chatId, file))
      toast(t('group.settings.avatarUpdated'), 'success')
    } catch (err) {
      setActionError(t('group.settings.avatarUploadFailed', { reason: String((err as Error)?.message ?? err) }))
    } finally {
      setAvatarUploading(false)
    }
  }, [avatarUploading, chatId, setActionError, setAvatarUrl, t, toast, viewerIsManager])
  return { avatarUploading, handleAvatarFile }
}
