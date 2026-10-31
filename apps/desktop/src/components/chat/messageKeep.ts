import type { TFunction } from 'i18next'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { markFileStorage } from '../../lib/fileStorage'
import type { ToastContextValue } from '../toastContext'

/**
 * 消息菜单的「设为临时 / 一直保留」:自己发的、还在的附件,它在云端那份留多久,和发送时 agent 填的是同一个标记。
 * 别人的、没有附件的、已经没了的 → undefined,菜单里就没有这两项。
 */
export function keepAction(message: { id: string; mine: boolean; live: boolean }, close: () => void, toast: ToastContextValue['toast'], t: TFunction) {
  if (!message.mine || !message.live) return undefined
  return (keep: 'temporary' | 'permanent') => {
    close()
    void markFileStorage([{ message_id: message.id }], keep)
      .then(() => toast(t(keep === 'temporary' ? 'message.actions.keptTemporary' : 'message.actions.keptPermanent'), 'success'))
      .catch((error) => toast(t('message.actions.keepFailed'), 'error', safeFailureLine(String((error as Error)?.message ?? error))))
  }
}
