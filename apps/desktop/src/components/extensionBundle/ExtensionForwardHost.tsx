import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useState, type KeyboardEvent } from 'react'
import { messageFileRefOf, parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { Download } from '@/lib/icons'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { readMessageCreatedRevision } from '../../lib/accountRevisionCoordinator'
import { sendFileToChat } from '../../lib/attachmentsEndpoint'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { rpc } from '../../session/renderer/lib/ipc'
import { appsHere } from '../appSlot/appsHere'
import { onUpdatedUnasked, updateUnasked } from '../appSlot/updateUnasked'
import { ForwardMessageDialog } from '../chat/ForwardMessageDialog'
import { useToast } from '../toastContext'
import { ListRow } from '../ui/ListRow'
import { installPackageOf, packageArrived } from './sharedPackages'
import { isExtensionBundle } from './summarizeExtensionBundle'
import { useExtensionWorkspaceRevisions } from './useExtensionWorkspaceRevisions'

const log = rendererLogger('chat/extension-forward')

export interface ExtensionForwardRequest {
  extensionId: string
  name: string
  version: string
}

/**
 * #6646 「转发」 an installed extension: the chat's own forward page. Picking chats packs it and sends it to each like
 * any attachment — one upload per message, as the composer does; exporting to a file is a row on the same page.
 */
export function ExtensionForwardHost() {
  // The shell's other always-mounted duty for App pages: group workspace changes (hook's own note).
  useExtensionWorkspaceRevisions()
  const { chats, subscribeAccountRevision } = useChatStore('chats', 'subscribeAccountRevision')
  const { user } = useAuth()
  const { toast } = useToast()
  // 摩擦单 F66: an App package sent in any chat here (the account revision bus, whatever is on screen) — that chat's list
  // of packages is behind, and an App on this device may update itself from it; when one does, a line says so.
  useEffect(() => {
    if (!appsHere) return undefined
    const sent = subscribeAccountRevision('message_created', (operations) => {
      for (const operation of operations) {
        const { chatId, message } = readMessageCreatedRevision(operation.payload)
        const meta = message?.content_type === 'attachment' && typeof message.content === 'string' ? parseAttachmentContent(message.content, messageFileRefOf(message)) : null
        if (!meta || !isExtensionBundle(meta)) continue
        packageArrived(chatId)
        if (meta.source.kind === 'gone' || !message?.id) continue
        void updateUnasked(installPackageOf({ source: meta.source, messageId: String(message.id) }))
      }
    })
    const updated = onUpdatedUnasked(({ name, version }) =>
      toast(translateSessionMessage('extensions.updatedUnasked', { name, version }), 'info'),
    )
    return () => {
      sent()
      updated()
    }
  }, [subscribeAccountRevision, toast])
  const [request, setRequest] = useState<ExtensionForwardRequest | null>(null)
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<ExtensionForwardRequest>).detail)
    window.addEventListener(UI_EVENTS.forwardExtension, open)
    return () => window.removeEventListener(UI_EVENTS.forwardExtension, open)
  }, [])
  if (!request || !user) return null
  const t = translateSessionMessage
  const close = () => setRequest(null)

  const forward = async (targetChatIds: string[]) => {
    const packed = await rpc.extensions.packInstalled({ extensionId: request.extensionId })
    if (!packed.success || !packed.data) {
      log.error({ extensionId: request.extensionId, error: packed.error }, 'packing an extension to forward failed')
      throw new Error(messageForUser(packed.error), { cause: packed.error })
    }
    const file = new File([packed.data.bytes], packed.data.fileName, { type: packed.data.mimeType })
    for (const chatId of targetChatIds) await sendFileToChat(file, { chatId, senderId: user.id })
  }

  const exportToFile = async () => {
    close()
    const result = await rpc.extensions.packInstalled({ extensionId: request.extensionId, save: true })
    if (!result.success) {
      log.error({ extensionId: request.extensionId, error: result.error }, 'exporting an extension failed')
      toast(t('extensions.exportFailed'), 'error', messageForUser(result.error))
    } else if (result.data?.saved) {
      toast(t('extensions.exported', { path: result.data.saved }), 'success')
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void exportToFile()
  }

  return (
    <ForwardMessageDialog
      chats={chats}
      sourceChatId=""
      preview={`${request.name} ${request.version} · .guguext`}
      topRow={
        <ListRow
          role="button"
          tabIndex={0}
          data-testid="extension-forward-export"
          className="gg-share-apps-row"
          onClick={() => void exportToFile()}
          onKeyDown={onKeyDown}
          leading={<span className="gg-share-apps-icon"><Download size={18} /></span>}
          title={t('extensions.exportArchive')}
        />
      }
      onForward={forward}
      onClose={close}
    />
  )
}
