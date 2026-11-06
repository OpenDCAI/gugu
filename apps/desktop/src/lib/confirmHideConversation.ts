import { showModal } from '@renderer/lib/modal/modal-provider'
import { i18n } from '../i18n'
import { currentAuthSessionSignal } from './authSessionLoss'
import { runConversationHidingAction } from './conversationHidingAction'
import { notify, dismissNotice } from './notices'
import { messageForUser } from './userFacingError'

/** Shared by desktop right-click and phone long-press menus. The Agent option starts unchecked. */
export async function confirmHideConversation({ hide, ownedAgent }: {
  hide: () => Promise<void>
  ownedAgent?: { id: string; remove: () => Promise<void> }
}): Promise<void> {
  const boundary = currentAuthSessionSignal()
  const t = (key: string) => i18n.t(`chatList.${key}`, { ns: 'messaging' })
  const choice = ownedAgent ? await new Promise<boolean | null>((resolve) => showModal('confirmActionModal', {
    title: t('removeFromList'),
    description: t('hideAgentDescription'),
    confirmLabel: t('removeFromList'),
    variant: 'default',
    option: { label: t('alsoRemoveAgent'), defaultChecked: false },
    onSuccess: ({ optionChecked }) => resolve(optionChecked),
    onClose: () => resolve(null),
  })) : false
  if (choice === null || boundary.aborted) return
  const key = `conversation-agent-removal:${ownedAgent?.id}`
  const dismiss = () => dismissNotice(key)
  let watching = false
  await runConversationHidingAction({
    hide,
    isCurrent: () => !boundary.aborted,
    removeAgent: choice && ownedAgent ? async () => {
      await ownedAgent.remove()
      if (!boundary.aborted) dismissNotice(key)
      boundary.removeEventListener('abort', dismiss)
      watching = false
    } : undefined,
    removalFailed: (error, retry) => {
      if (!watching) { boundary.addEventListener('abort', dismiss, { once: true }); watching = true }
      notify({
        key, tier: 'error', ongoing: true, title: t('hiddenAgentDeleteFailed'), description: messageForUser(error),
        action: { label: t('retryAgentDelete'), onClick: () => { void retry() } },
      })
    },
  })
}
