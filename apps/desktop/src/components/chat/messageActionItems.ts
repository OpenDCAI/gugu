import type { TFunction } from 'i18next'
import { Clock, Copy, Download, ExternalLink, MessageSquare, Pin, Reply, Share, SquareCheck, TextCursorInput, Trash, type IconComponent } from '@/lib/icons'
import { SELECTED_MESSAGE_QUOTES_ENABLED } from '../../lib/messageQuoteRollout'

export type MessageActionTarget = {
  isRetracted: boolean
  content: string | null
  /** Limit the menu to handlers for the captured text selection. */
  hasSelection?: boolean
  onReply?: () => void
  onQuoteSelection?: () => void
  onCopy?: (content?: string) => void
  /** 手机才有:收起菜单,在气泡上原地选字(手机长按就是菜单,平时气泡不能选字)。 */
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
  /** 桌面菜单里收进「更多」;手机长按的列表平铺,不看这一项。 */
  fold?: true
}

/** 一条消息能做的事。右键 / ⋯ / 长按 / 文件预览共用,按提供的 handler 取适合当前场景的动作。 */
export function messageActionItems(input: MessageActionTarget, t: TFunction<'messaging'>): MessageActionItem[] {
  const target: MessageActionTarget = input.hasSelection ? {
    isRetracted: input.isRetracted, content: input.content,
    onReply: selectionReply(input), onCopy: input.onCopy,
    onCopyLink: input.onCopyLink, onOpenLink: input.onOpenLink,
  } : input
  const hasContent = !!target.content && !target.isRetracted
  const items: (MessageActionItem | false)[] = [
    !!target.onReply && { key: 'reply', icon: Reply, label: t('message.actions.reply'), onSelect: target.onReply, disabled: target.isRetracted },
    SELECTED_MESSAGE_QUOTES_ENABLED && !!target.onQuoteSelection && { key: 'quoteSelection', icon: Reply, label: t('message.actions.quoteSelection'), onSelect: target.onQuoteSelection, disabled: target.isRetracted },
    !!target.onCopy && { key: 'copy', icon: Copy, label: t('message.actions.copy'), onSelect: target.onCopy, disabled: !hasContent },
    !!target.onSelectText && { key: 'selectText', icon: TextCursorInput, label: t('message.actions.selectText'), onSelect: target.onSelectText, disabled: !hasContent },
    !!target.onCopyLink && { key: 'copyLink', icon: Copy, label: t('message.actions.copyLink'), onSelect: target.onCopyLink, disabled: target.isRetracted },
    !!target.onOpenLink && { key: 'openLink', icon: ExternalLink, label: t('message.actions.openLink'), onSelect: target.onOpenLink, disabled: target.isRetracted },
    !!target.onOpenTopic && { key: 'openTopic', icon: MessageSquare, label: t('message.actions.openTopic'), onSelect: target.onOpenTopic, disabled: target.isRetracted },
    !!target.onForward && { key: 'forward', icon: Share, label: t('message.actions.forward'), onSelect: target.onForward, disabled: !hasContent },
    !!target.onDownload && { key: 'download', icon: Download, label: t('chatArea.filePreview.download'), onSelect: target.onDownload, disabled: target.isRetracted },
    !!target.onKeep && { key: 'keep-temporary', icon: Clock, label: t('message.actions.keepTemporary'), onSelect: () => target.onKeep!('temporary'), disabled: target.isRetracted, fold: true },
    !!target.onKeep && { key: 'keep-permanent', icon: Pin, label: t('message.actions.keepPermanent'), onSelect: () => target.onKeep!('permanent'), disabled: target.isRetracted, fold: true },
    !!target.onSelect && { key: 'select', icon: SquareCheck, label: t('message.actions.select'), onSelect: target.onSelect, fold: true },
    !!target.onDelete && { key: 'delete', icon: Trash, label: t('message.actions.delete'), onSelect: target.onDelete, danger: true, fold: true },
  ]
  return items.filter((item): item is MessageActionItem => item !== false)
}

/** Until excerpt-aware receivers ship, Reply on a selection keeps its whole-message meaning. */
function selectionReply(target: MessageActionTarget) {
  return SELECTED_MESSAGE_QUOTES_ENABLED ? target.onQuoteSelection ?? target.onReply : target.onReply
}
