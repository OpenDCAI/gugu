import type { TFunction } from 'i18next'
import { Copy, PenLine, Reply, Share, SquareCheck, Trash, type IconComponent } from '@/lib/icons'

export type MessageActionTarget = {
  isMine: boolean
  isRetracted: boolean
  content: string | null
  onCopy: () => void
  onForward: () => void
  onDelete: () => void
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
  title?: string
}

/** 一条消息能做的事(设计稿 #msgmenu 的顺序)。桌面右键 / ⋯ 菜单与手机长按面板共用这一份。 */
export function messageActionItems(target: MessageActionTarget, t: TFunction<'messaging'>): MessageActionItem[] {
  const hasContent = !!target.content && !target.isRetracted
  const items: (MessageActionItem | false)[] = [
    { key: 'copy', icon: Copy, label: t('message.actions.copy'), onSelect: target.onCopy, disabled: !hasContent },
    !!target.onOpenTopic && { key: 'openTopic', icon: Reply, label: t('message.actions.openTopic'), onSelect: target.onOpenTopic, disabled: target.isRetracted },
    { key: 'forward', icon: Share, label: t('message.actions.forward'), onSelect: target.onForward, disabled: !hasContent },
    !!target.onSelect && { key: 'select', icon: SquareCheck, label: t('message.actions.select'), onSelect: target.onSelect },
    // 编辑后端未建(#1527)⇒ 诚实禁用「即将开放」,❌ 点了没反应的死项。
    target.isMine && { key: 'edit', icon: PenLine, label: t('message.actions.edit'), disabled: true, title: t('message.actions.comingSoon') },
    { key: 'delete', icon: Trash, label: t('message.actions.delete'), onSelect: target.onDelete, danger: true },
  ]
  return items.filter((item): item is MessageActionItem => item !== false)
}
