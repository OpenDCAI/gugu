import { useMemo } from 'react'
import { useMobileShell } from './useMobileShell'
import { createAttachmentFileSelection } from '@/lib/attachmentFileSelection'
import { notify } from '@/lib/notices'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

export function useAttachmentFileSelection(attachments: readonly { id: string; file?: File }[], scope: unknown) {
  const mobile = useMobileShell()
  const { selection } = useMemo(() => ({ scope, selection: createAttachmentFileSelection(() => notify({
    key: 'mobile-attachment-limit', title: translateSessionMessage('composer.attachmentLimit'),
    tier: 'info', presentation: 'compact', duration: 1500,
  })) }), [scope])
  selection.observe(attachments)
  return useMemo(() => ({
    choose: (files: readonly File[]) => selection.choose(files, mobile),
    release: selection.release,
  }), [selection, mobile])
}
