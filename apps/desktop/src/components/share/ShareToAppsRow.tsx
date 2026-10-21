import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { Share2 } from '@/lib/icons'
import { platform } from '../../platform'
import { rendererLogger } from '../../lib/log'
import { resolveSharePlan, sharePayloadForMessages } from '../../lib/shareToApps'
import { attachmentResolver } from '../../lib/attachmentBytes'
import { useToast } from '../toastContext'
import { ListRow } from '../ui/ListRow'
import './share-to-apps.css'

const log = rendererLogger('mobile/share-with-apps')

/**
 * 转发页最上面一行「分享到其他应用」(product spec)。发给咕咕里的会话、还是发到咕咕外的应用,
 * 是转发这一件事里选的对象不同 —— 所以它住在转发页里,❌ 在消息菜单里和「转发」并列(owner 2026-09-27)。
 * 只有安卓 App 有系统分享;选中的消息里有一条分享不了(语音、卡片),这一行就不出现。
 */
export function ShareToAppsRow({ messages, onClose }: {
  messages: ReadonlyArray<Pick<MessageItem, 'id' | 'content' | 'content_type' | 'file_item_id' | 'file_version' | 'file_blob_id'>>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  if (!platform.capabilities.shareToApps) return null
  const plan = sharePayloadForMessages(messages)
  if (!plan) return null
  const share = () => {
    onClose()
    resolveSharePlan(plan, attachmentResolver.resolve).then((payload) => platform.shareToApps(payload)).catch((error: unknown) => {
      // 原因(下载失败 / 面板打不开)进日志;给人看的只说没分享成。
      log.warn({ detail: error instanceof Error ? error.message : String(error) }, 'share to other apps failed')
      toast(t('forward.shareFailed'), 'error')
    })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    share()
  }
  return (
    <ListRow
      role="button"
      tabIndex={0}
      data-share-to-apps=""
      className="gg-share-apps-row"
      onClick={share}
      onKeyDown={onKeyDown}
      leading={<span className="gg-share-apps-icon"><Share2 size={18} /></span>}
      title={t('forward.shareToApps')}
    />
  )
}
