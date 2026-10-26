import { useRef, useState } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { BellOff, MailUnread, MessageCircle, Pencil, Pin, Trash } from '@/lib/icons'
import { i18n } from '../../i18n'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Menu, MenuItem } from '../ui/Menu'
import { AliasSheet } from './AliasSheet'
import { useContactsStore } from '../../store/contactsContext'

// #3253 通讯录行的动作面：右键菜单（#886 起）+ hover 浮出的删除钮。
// 从 ContactsPanel 抽出，一是那个 god 文件行数被 CI 冻结，二是这两条路径本就是同一件事的两个入口。

const ct = i18n.getFixedT(null, 'contacts')

// #886 联系人行右键菜单动作集。#1694 起群行复用同组件：
//   onStartChat / onMarkUnread 可选 —— 群行不传，故不显示「发消息」「标记未读」
//   （设计稿群行 3 项：置顶/通知/删除）。
export interface ContactRowMenuActions {
  removeLabel: string
  // #5645 传了人类联系人就多一项「设置备注」（agent / 群不传）。弹窗由菜单自己托管，
  // 宿主 ContactsPanel 行数被 CI 冻结，不往那边加状态。
  contact?: ContactUser
  onStartChat?: () => void
  isPinned: boolean
  notifMuted: boolean
  onPin: () => void
  onMarkUnread?: () => void
  onToggleNotif: () => void
  onRemove: () => void
}

// #886 通讯录右键菜单：迁移到共享 <Menu>/<MenuItem> 原语，与 ChatRowContextMenu 视觉对齐。
// 同一份菜单/动作集挂在移动端 ContactRow 与桌面 Agent/PersonContactRow（行为同步统一）。
export function ContactRowContextMenu({
  x,
  y,
  onClose,
  removeLabel,
  contact,
  onStartChat,
  isPinned,
  notifMuted,
  onPin,
  onMarkUnread,
  onToggleNotif,
  onRemove,
}: ContactRowMenuActions & { x: number; y: number; onClose: () => void }) {
  const { updateContactAlias } = useContactsStore()
  const [aliasOpen, setAliasOpen] = useState(false)
  // Base UI 选中菜单项后会回调 onOpenChange(false) → 宿主清 menuPos → 本组件整个卸载，弹窗还没挂就没了。
  // 所以「设置备注」这一下要吞掉 Menu 的关闭请求，改由弹窗的 onClose 收尾。
  const aliasOpening = useRef(false)
  const aliasContact = contact && contact.type !== 'agent' ? contact : undefined
  if (aliasOpen && aliasContact) return <AliasSheet name={aliasContact.display_name} alias={aliasContact.alias} avatarUrl={aliasContact.avatar} seed={aliasContact.id} onSave={(alias) => updateContactAlias(aliasContact.id, alias)} onClose={onClose} />
  return (
    <Menu x={x} y={y} minWidth={160} onClose={() => { if (!aliasOpening.current) onClose() }}>
      {onStartChat ? (
        <MenuItem icon={<MessageCircle size={15} />} onClick={() => { onStartChat(); onClose() }}>
          {ct('contextMenu.startChat')}
        </MenuItem>
      ) : null}
      {aliasContact ? (
        <MenuItem data-testid={AUTOMATION_TEST_IDS.contactCtxSetAlias}
          icon={<Pencil size={15} />}
          onClick={() => { aliasOpening.current = true; setAliasOpen(true) }}
        >
          {ct('contextMenu.setAlias')}
        </MenuItem>
      ) : null}
      <MenuItem data-testid={AUTOMATION_TEST_IDS.contactCtxPin}
        icon={<Pin size={15} />}
        onClick={() => { onPin(); onClose() }}
      >
        {isPinned ? ct('contextMenu.unpin') : ct('contextMenu.pin')}
      </MenuItem>
      {onMarkUnread ? (
        <MenuItem data-testid={AUTOMATION_TEST_IDS.contactCtxMarkUnread}
          icon={<MailUnread size={15} />}
          onClick={() => { onMarkUnread(); onClose() }}
        >
          {ct('contextMenu.markUnread')}
        </MenuItem>
      ) : null}
      <MenuItem data-testid={AUTOMATION_TEST_IDS.contactCtxNotif}
        icon={<BellOff size={15} />}
        onClick={() => { onToggleNotif(); onClose() }}
      >
        {notifMuted ? ct('contextMenu.enableNotifications') : ct('contextMenu.disableNotifications')}
      </MenuItem>
      <MenuItem data-testid={AUTOMATION_TEST_IDS.contactCtxRemove}
        danger
        icon={<Trash size={15} />}
        onClick={() => { onRemove(); onClose() }}
      >
        {removeLabel}
      </MenuItem>
    </Menu>
  )
}

// #3253 hover 浮出的删除钮。为什么是行的 DOM **同级**而不是嵌在行里：行本身是 <button>，
// 按钮不能嵌按钮（HTML 非法，焦点行为也坏）。代价是指针移到钮上时行自身的 :hover 会假掉，
// 由 tokens.css 的 .gg-row-host:hover 接管行底色补上。
// 只让 opacity 参与过渡：会话页那条 hover 动作钮的注释记着，位移一起过渡会让刚 hover 的
// 100ms 内点击落空（`sidebar-session-item.tsx`），这里直接不做位移。
export function ContactRowDeleteButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={AUTOMATION_TEST_IDS.contactRowRemove}
      className="gg-ghost absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center opacity-0 transition-opacity duration-[var(--dur-fast)] [transition-timing-function:var(--ease)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover/contact-row:opacity-100"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onRemove()
      }}
    >
      <Trash size={15} />
    </button>
  )
}
