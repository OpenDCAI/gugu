import { useMemo } from 'react'
import { readMobileShell } from './useMobileShell'
import { createAttachmentFileSelection } from '@/lib/attachmentFileSelection'
import { notify } from '@/lib/notices'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

export function useAttachmentFileSelection(attachments: readonly { id: string; file?: File }[], scope: unknown) {
  const { selection } = useMemo(() => ({ scope, selection: createAttachmentFileSelection(() => notify({
    key: 'mobile-attachment-limit', title: translateSessionMessage('composer.attachmentLimit'),
    tier: 'info', presentation: 'compact', duration: 1500,
  })) }), [scope])
  selection.observe(attachments)
  return useMemo(() => ({
    select: (files: readonly File[]) => selection.select(files, readMobileShell()),
    release: selection.release,
  }), [selection])
}
