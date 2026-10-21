import { i18n } from '@/i18n'

const MESSAGING_PREFIX = 'gugu:i18n:messaging:'

export function encodeMessagingValue(key: string): string {
  return `${MESSAGING_PREFIX}${key}`
}

export function resolveMessagingValue(value: string): string {
  switch (value) {
    case `${MESSAGING_PREFIX}chatService.groupAction.joined`:
      return i18n.t('chatService.groupAction.joined', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.groupAction.roleUpdated`:
      return i18n.t('chatService.groupAction.roleUpdated', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.scheduler.paused`:
      return i18n.t('chatService.scheduler.paused', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.scheduler.resumed`:
      return i18n.t('chatService.scheduler.resumed', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.cancelled`:
      return i18n.t('chatService.taskAction.cancelled', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.paused`:
      return i18n.t('chatService.taskAction.paused', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.retried`:
      return i18n.t('chatService.taskAction.retried', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.transferred`:
      return i18n.t('chatService.taskAction.transferred', { ns: 'messaging' })
    default:
      return value
  }
}
