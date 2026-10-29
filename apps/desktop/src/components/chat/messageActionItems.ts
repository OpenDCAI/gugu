import type { TFunction } from 'i18next'
import { Clock, Copy, Download, ExternalLink, Pin, Reply, Share, SquareCheck, TextCursorInput, Trash, type IconComponent } from '@/lib/icons'

export type MessageActionTarget = {
  isRetracted: boolean
  content: string | null
  onReply?: () => void
  onQuoteSelection?: () => void
  onCopy?: (content?: string) => void
  /** 手机才有:长按菜单里换成可选中的原文,挑一段复制(手机长按就是菜单,气泡本身不能选字)。 */
  onSelectText?: () => void
  onCopyLink?: () => void
  onOpenLink?: () => void
  onForward?: () => void
  onDelete?: () => void
  onDownload?: () => void
  /** 自己发的附件在云端的那份:设为临时(到期删)/ 一直保留。提供才有(file_storage_mark_as 只认上传者本人)。 */
  onKeep?: (keep: 'temporary' | 'permanent') => void
  /** 提供则有「多选」;不提供则隐藏。 */
  onSelect?: () => void
  /** 提供则有「开话题」;话题里不提供(单层不嵌套)。 */
  onOpenTopic?: () => void
}

export type MessageActionItem = {
  key: string
  icon: IconComponent
  label: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  /** 点了不收菜单,在原浮层里换一屏。 */
  keepOpen?: boolean
}

/** 一条消息能做的事。右键 / ⋯ / 长按 / 文件预览共用,按提供的 handler 取适合当前场景的动作。 */
export function messageActionItems(target: MessageActionTarget, t: TFunction<'messaging'>): MessageActionItem[] {
  const hasContent = !!target.content && !target.isRetracted
  const items: (MessageActionItem | false)[] = [
    !!target.onReply && { key: 'reply', icon: Reply, label: t('message.actions.reply'), onSelect: target.onReply, disabled: target.isRetracted },
    !!target.onQuoteSelection && { key: 'quoteSelection', icon: Reply, label: t('message.actions.quoteSelection'), onSelect: target.onQuoteSelection, disabled: target.isRetracted },
    !!target.onCopy && { key: 'copy', icon: Copy, label: t('message.actions.copy'), onSelect: target.onCopy, disabled: !hasContent },
    !!target.onSelectText && { key: 'selectText', icon: TextCursorInput, label: t('message.actions.selectText'), onSelect: target.onSelectText, disabled: !hasContent, keepOpen: true },
    !!target.onCopyLink && { key: 'copyLink', icon: Copy, label: t('message.actions.copyLink'), onSelect: target.onCopyLink, disabled: target.isRetracted },
    !!target.onOpenLink && { key: 'openLink', icon: ExternalLink, label: t('message.actions.openLink'), onSelect: target.onOpenLink, disabled: target.isRetracted },
    !!target.onOpenTopic && { key: 'openTopic', icon: Reply, label: t('message.actions.openTopic'), onSelect: target.onOpenTopic, disabled: target.isRetracted },
    !!target.onForward && { key: 'forward', icon: Share, label: t('message.actions.forward'), onSelect: target.onForward, disabled: !hasContent },
    !!target.onDownload && { key: 'download', icon: Download, label: t('chatArea.filePreview.download'), onSelect: target.onDownload, disabled: target.isRetracted },
    !!target.onKeep && { key: 'keep-temporary', icon: Clock, label: t('message.actions.keepTemporary'), onSelect: () => target.onKeep!('temporary'), disabled: target.isRetracted },
    !!target.onKeep && { key: 'keep-permanent', icon: Pin, label: t('message.actions.keepPermanent'), onSelect: () => target.onKeep!('permanent'), disabled: target.isRetracted },
    !!target.onSelect && { key: 'select', icon: SquareCheck, label: t('message.actions.select'), onSelect: target.onSelect },
    !!target.onDelete && { key: 'delete', icon: Trash, label: t('message.actions.delete'), onSelect: target.onDelete, danger: true },
  ]
  return items.filter((item): item is MessageActionItem => item !== false)
}

/** Selection already owns a range: Reply uses that excerpt instead of adding a second quote command.
 * Permissions and every other action, including future extensions, still come from the same list. */
export function messageSelectionActionItems(target: MessageActionTarget, t: TFunction<'messaging'>): MessageActionItem[] {
  return messageActionItems({ ...target, onReply: target.onQuoteSelection ?? target.onReply, onQuoteSelection: undefined }, t)
}
