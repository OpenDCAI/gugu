import { useTranslation } from 'react-i18next'
import { AppWindow, Check, ListChecks, MessageCircle } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { DropdownMenu, menuRowClassName, menuRowLabelClassName } from '@/components/ui/Menu'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/**
 * 手机上那颗模式按钮(#7197,behavior mobile-session-view「模式按钮」):看一条会话的那一页页头。
 * Agent 私聊页头没有这颗按钮(#691:私聊本身就是任务页那个转录)。
 *
 * 只在**手机自己**的两个视图之间跳:对话(这个 agent 的私聊)、项目(看这条会话的那一页,底栏「项目」那一格),人在哪儿哪儿打勾。
 * ❌ 没有「切换为编程 / 通用模式」—— 手机不让那台电脑换展示,电脑上的视图不受手机影响(owner 10-15「手机上切就是
 * 手机上切,电脑上视图是不变的」「根本不需电脑上同步」)。两行的名字与图标就是手机底部 tab 的那两格。
 *
 * 菜单是桌面那颗同款的下拉(DropdownMenu,锚在按钮下面),❌ 底部抽屉(owner 10-15 否决)。
 * 手机没有悬停:点一下打开;行加高到触控档;选不了的行变淡,原因写在行里。
 */
export function MobileModeMenu({
  at,
  onOpenChat,
  onOpenTask,
  apps = [],
  onOpenApp,
  iconOnly = false,
}: {
  /**
   * 人此刻在哪个视图:Agent 私聊页(对话),还是看这条会话的那一页(项目),或者这条会话上的一个 App(`app:<tab kind>`)。
   */
  at: 'chat' | 'task' | `app:${string}`
  /**
   * owner 10-16:这条会话上能开的 App 页签(装着、启用、不认领文件的那些,同电脑会话页「+」里那一段)。页面在手机上画,
   * 程序在会话所在的那台电脑上跑。
   */
  apps?: ReadonlyArray<{ kind: string; name: string }>
  /** 去这条会话上的那个 App(看会话那一页才给)。 */
  onOpenApp?: (kind: string) => void
  /** 去这个 agent 的私聊(看会话那一页才给);null = 还没有咕咕身份,那一行变淡说原因。 */
  onOpenChat?: (() => void) | null
  /** 去这条会话的那一页(私聊页才给)。 */
  onOpenTask?: () => void
  /**
   * 只画图标(名字进读屏标签):放不下名字的页头用,同桌面那颗「窄了只剩图标」。私聊页头一排已有头像、文件夹、「…」,
   * 带字时 390 宽的手机上 agent 名字被挤成「C…」(验收实拍)。
   */
  iconOnly?: boolean
}) {
  const { t } = useTranslation('main')
  const chatName = t('shell.chats')
  const taskName = t('shell.sessionView')
  const openApp = at.startsWith('app:') ? apps.find((one) => `app:${one.kind}` === at) : undefined
  const label = at === 'chat' ? chatName : openApp ? openApp.name : taskName
  const ariaLabel = translateSessionMessage('task.modeMenu', { mode: label })
  const TriggerIcon = at === 'chat' ? MessageCircle : openApp ? AppWindow : ListChecks
  const chatLocked = at === 'task' && !onOpenChat
  const rowClass = cn(menuRowClassName, 'px-[10px] py-[6px] data-[checked]:bg-[var(--selected)]')

  const trigger = iconOnly ? (
    <IconButton size="lg" aria-label={ariaLabel}>
      <TriggerIcon />
    </IconButton>
  ) : (
    // 照桌面「换模型」那颗:不铺底、次级灰字(ghost 自带)、不加粗、没箭头。
    <Button variant="ghost" size="sm" className="gap-2 font-[var(--font-weight-regular)]">
      <TriggerIcon size={16} />
      <span>{label}</span>
    </Button>
  )

  const rows: Array<{ view: string; name: string; Icon: typeof MessageCircle; lock: string | null; go?: (() => void) | null }> = [
    { view: 'chat', name: chatName, Icon: MessageCircle, lock: chatLocked ? translateSessionMessage('task.modeChatNeedsIdentity') : null, go: onOpenChat },
    { view: 'task', name: taskName, Icon: ListChecks, lock: null, go: onOpenTask },
    ...(onOpenApp ? apps.map((one) => ({ view: `app:${one.kind}`, name: one.name, Icon: AppWindow, lock: null, go: () => onOpenApp(one.kind) })) : []),
  ]

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        data-testid="agent-watch-mode-open"
        aria-label={ariaLabel}
        render={trigger}
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value={at}>
          {rows.map(({ view, name, Icon, lock, go }) => (
            <DropdownMenu.RadioItem
              key={view}
              value={view}
              // 一选就离开这一页(或停在原处),菜单都得跟着收。
              closeOnClick
              disabled={lock !== null}
              data-testid={`agent-watch-mode-${view}`}
              className={rowClass}
              onClick={() => { if (view !== at) go?.() }}
            >
              <Icon size={16} className="shrink-0 text-[var(--menu-icon)]" />
              <span className={menuRowLabelClassName}>
                {name}
                {lock ? <span className="block text-[length:var(--font-caption)] text-[var(--menu-icon)]">{lock}</span> : null}
              </span>
              {view === at ? <Check size={16} className="ms-4 shrink-0" /> : null}
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
