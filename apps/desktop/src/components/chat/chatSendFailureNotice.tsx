import type { TFunction } from 'i18next'
import { resolveFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import type { Notice } from '@/lib/notices'

/** Diagnostics stay in the send log. Only recognized failures select user copy. */
export function chatSendFailureReason(error: unknown, t: TFunction<'messaging'>): string {
  if (error instanceof AttachmentsError) {
    if (error.code === 'too_large' || error.status === 413) return t('composer.failureReason.tooLarge')
    if (error.status === 401) return t('composer.failureReason.signIn')
    if (error.status === 403) return t('composer.failureReason.denied')
    if (error.status === 429) return t('composer.failureReason.busy')
  }
  const message = error instanceof Error ? error.message : ''
  if (message === t('composer.attachmentContextMissing')) return t('composer.failureReason.chatUnavailable')
  if (message === t('composer.attachmentSendTimedOut')) return t('composer.failureReason.timeout')
  return t('composer.failureReason.unavailable')
}

function fileLabel(file: File, t: TFunction<'messaging'>): string {
  const mime = resolveFileMimeType(file)
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file'
  return t('composer.failedFileLabel', { kind: t(`composer.failedFileKind.${kind}`), name: file.name })
}

/** The caller passes only uncommitted batch entries; repeated filenames remain separate files. */
export function chatSendFailureNotice(files: File[], error: unknown, t: TFunction<'messaging'>): Notice {
  const guidance = chatSendFailureReason(error, t)
  if (files.length === 0) return { tier: 'error', title: t('composer.sendFailed', { guidance }) }
  if (files.length === 1) return { tier: 'error', title: t('composer.fileSendFailed', { file: fileLabel(files[0], t), guidance }) }
  return {
    tier: 'error',
    title: t('composer.filesSendFailed', { count: files.length, guidance }),
    description: (
      <details>
        <summary className="cursor-pointer">{t('composer.showFailedFiles', { count: files.length })}</summary>
        <ul className="mt-1 max-h-40 overflow-y-auto break-all">
          {files.map((file, index) => <li key={index}>{fileLabel(file, t)}</li>)}
        </ul>
      </details>
    ),
  }
}
