import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, UserPlus, Users } from '@/lib/icons'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { Button } from '../ui/Button'
import { IconButton as UiIconButton } from '../ui/IconButton'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

/**
 * 通讯录头部那颗加人按钮 —— 一颗按钮，两个意图。
 *
 * 为什么是菜单不是页内切换（owner 2026-09-06:「为什么不用这个按钮变多功能按钮」）:
 * 「加入群聊」原先只能在「添加联系人」页里靠一排分段标签切到，而**那一页本身就没有稳定入口** ——
 * 它只在「个人」分区的空态里露一行内联文字（「还没有联系人 添加联系人」），有了联系人那行就消失。
 * 于是这个功能对已有联系人的用户等于不存在。把两个意图摊在按钮上，入口才是恒定可见的。
 *
 * ❌ 页内不再留第二个开关:选择已经发生在这里，再放一排标签就是重复的装饰。
 *
 * 形状照会话列表那颗「+」（ChatListPanel 的 PlusMenuItems），❌ 别另发明一套下拉。
 */
export function AddContactMenu({
  mobile,
  onAddContact,
  onJoinGroup,
}: {
  mobile?: boolean
  onAddContact: () => void
  onJoinGroup: () => void
}) {
  const { t } = useTranslation('contacts')
  const [open, setOpen] = useState(false)

  const pick = (run: () => void) => () => {
    setOpen(false)
    run()
  }

  return (
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        className="gg-icon-btn gg-ghost gg-pressable window-no-drag-region"
        data-size="md"
        data-mobile={mobile || undefined}
        data-on={open || undefined}
        data-testid="contacts-add-menu-button"
        aria-label={t('panel.addContact')}
        title={t('panel.addContact')}
      >
        <UserPlus />
      </DropdownMenu.Trigger>
      {open ? (
        <DropdownMenu.Content
          aria-label={t('panel.addContact')}
          side="bottom"
          align="end"
          sideOffset={4}
          className="min-w-[160px]"
          // 菜单默认会在关闭时把焦点还给触发按钮 —— 那正好盖掉落地页搜索框的 autoFocus,
          // 于是「点菜单进去还得再点一下输入框」。选完就该能直接打字,所以这里不收口焦点。
          // (实测:不设这个,关闭后 activeElement 是 contacts-add-menu-button。)
          finalFocus={false}
        >
          <MenuItem
            data-testid="contacts-add-menu-contact"
            icon={<UserPlus size={15} />}
            onClick={pick(onAddContact)}
          >
            {t('panel.addContact')}
          </MenuItem>
          <MenuItem
            data-testid="contacts-add-menu-group"
            icon={<Users size={15} />}
            onClick={pick(onJoinGroup)}
          >
            {t('joinGroup.title')}
          </MenuItem>
        </DropdownMenu.Content>
      ) : null}
    </DropdownMenu.Root>
  )
}

/**
 * 通讯录头部的动作区 —— 多选态是一颗「完成」，常态是「多选」+「加人菜单」。
 *
 * 从 ContactsPanel 抽出来的:那是 CI 冻结行数的上帝文件之一，加东西必须先还回去。
 * 抽的边界是「头部动作区」这一个内聚单元，❌ 不是为了凑行数随手切一刀。
 */
export function ContactsHeaderActions({
  mobile,
  selectionMode,
  labels,
  onFinishSelectionMode,
  onEnterSelectionMode,
  onSelectAddFriend,
}: {
  mobile?: boolean
  selectionMode: boolean
  labels: { selectModeDone: string; selectMode: string }
  onFinishSelectionMode: () => void
  onEnterSelectionMode: () => void
  onSelectAddFriend: (mode: 'contact' | 'group') => void
}) {
  if (selectionMode) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-[var(--primary)]"
        title={labels.selectModeDone}
        aria-label={labels.selectModeDone}
        data-testid={AUTOMATION_TEST_IDS.contactsSelectModeDoneButton}
        onClick={onFinishSelectionMode}
      >
        {labels.selectModeDone}
      </Button>
    )
  }
  return (
    <>
      <UiIconButton
        title={labels.selectMode}
        aria-label={labels.selectMode}
        data-testid={AUTOMATION_TEST_IDS.contactsSelectModeButton}
        onClick={onEnterSelectionMode}
      >
        <ListChecks />
      </UiIconButton>
      <AddContactMenu
        mobile={mobile}
        onAddContact={() => onSelectAddFriend('contact')}
        onJoinGroup={() => onSelectAddFriend('group')}
      />
    </>
  )
}
