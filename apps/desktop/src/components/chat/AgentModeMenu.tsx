import { useTranslation } from 'react-i18next'
import { AppWindow, Check, ExternalLink, MessageCircle, Terminal, type IconComponent } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { DropdownMenu, MenuSeparator, menuRowClassName, menuRowLabelClassName } from '../ui/Menu'

type TaskView = 'code' | 'general'

/**
 * 模式按钮在聊天页的那一颗(#7167):Agent 私聊头部最右,取代「↗ 在任务中打开」。任务页那颗在会话页那棵树里
 * (session-mode-menu.tsx),两颗长相与排法同一套:触发器照「换模型」那颗(平时不铺底、次级灰字、不加粗、没箭头;
 * 悬浮浅底、开着淡蓝底),菜单宽度随内容,停一下就开、直接点也开。
 *
 * 排法(owner 10-14「编程和通用一般是二选一」「尽量不要让用户误触…去聊天挺频繁,编程和通用的切换没那么频繁」):
 * 分隔线上面是两个**去处** —— 聊天(人就在这,打勾)、这条任务(以它正在用的那种命名,点了只是过去看);下面是
 * 唯一的**动作**「切换为另一种」,与任务页那颗、页签右键同一句话。正在用的是哪种,从「哪种是去处、哪种要切换」
 * 一眼看得出,不必另写「使用中」;切换的代价(打断这一轮)由任务页的确认框在点下去时说。
 *
 * 选去处 = 打开这条任务;选动作 = 打开这条任务并请会话页换成那种(MainLayout → 窗口桥)。能不能换、换之前问不问,
 * 由会话页判断、会话页说 —— 这一侧不知道这一家给不给那种展示、机器是不是用 SSH 添加的,❌ 在聊天页再猜一遍锁。
 * 读不到任务正在用哪种(taskView = null)时分不出去处和动作,只给「在任务中打开」,❌ 猜一种去请求切换。
 */
export function AgentModeMenu({
  taskView,
  busy,
  onOpen,
}: {
  /** 这条任务现在以哪种展示开;null = 读不到。 */
  taskView: TaskView | null
  busy: boolean
  /** 不带 view = 原样打开这条任务;带 view = 打开并换成那种。 */
  onOpen: (view?: TaskView) => void
}) {
  const { t } = useTranslation('messaging')
  const VIEWS: Record<TaskView, { Icon: IconComponent; label: string; switchLabel: string }> = {
    code: { Icon: Terminal, label: t('agent.taskpage.mode.code'), switchLabel: t('agent.taskpage.mode.switchToCode') },
    general: { Icon: AppWindow, label: t('agent.taskpage.mode.general'), switchLabel: t('agent.taskpage.mode.switchToGeneral') },
  }
  const here = taskView === null ? null : { view: taskView, ...VIEWS[taskView] }
  const otherView: TaskView | null = taskView === null ? null : taskView === 'code' ? 'general' : 'code'
  const other = otherView === null ? null : { view: otherView, ...VIEWS[otherView] }
  const chatLabel = t('agent.taskpage.mode.chat')
  const rowClass = cn(menuRowClassName, 'px-[10px] py-[6px] data-[checked]:bg-[var(--selected)]')
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        openOnHover
        delay={100}
        closeDelay={200}
        disabled={busy}
        data-testid="agent-mode-trigger"
        aria-label={t('agent.taskpage.mode.menu', { mode: chatLabel })}
        className={cn(
          'window-no-drag-region inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-3',
          'border border-transparent text-[length:var(--font-body)] leading-none text-[var(--muted-fg)] select-none outline-none',
          'transition-colors duration-[var(--dur-fast)] ease-out motion-reduce:transition-none',
          'hover:bg-[var(--hover)] hover:text-[var(--fg)] data-[popup-open]:bg-[var(--selected)] data-[popup-open]:text-[var(--fg)]',
          'focus-visible:border-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-60',
        )}
      >
        <MessageCircle size={16} />
        <span>{chatLabel}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value="chat">
          <DropdownMenu.RadioItem value="chat" closeOnClick data-testid="agent-mode-chat" className={rowClass}>
            <MessageCircle size={16} className="shrink-0 text-[var(--menu-icon)]" />
            <span className={menuRowLabelClassName}>{chatLabel}</span>
            <Check size={16} className="ms-4 shrink-0" />
          </DropdownMenu.RadioItem>
          {here ? (
            <DropdownMenu.RadioItem
              value={here.view}
              // 一选就离开这一页,菜单必须跟着收。
              closeOnClick
              data-testid={`agent-mode-${here.view}`}
              className={rowClass}
              onClick={() => onOpen()}
            >
              <here.Icon size={16} className="shrink-0 text-[var(--menu-icon)]" />
              <span className={menuRowLabelClassName}>{here.label}</span>
            </DropdownMenu.RadioItem>
          ) : (
            <DropdownMenu.RadioItem value="task" closeOnClick data-testid="agent-mode-task" className={rowClass} onClick={() => onOpen()}>
              <ExternalLink size={16} className="shrink-0 text-[var(--menu-icon)]" />
              <span className={menuRowLabelClassName}>{t('agent.taskpage.open')}</span>
            </DropdownMenu.RadioItem>
          )}
        </DropdownMenu.RadioGroup>
        {other ? (
          <>
            <MenuSeparator />
            <DropdownMenu.Item
              closeOnClick
              data-testid={`agent-mode-${other.view}`}
              className={rowClass}
              onClick={() => onOpen(other.view)}
            >
              <other.Icon size={16} className="shrink-0 text-[var(--menu-icon)]" />
              <span className={menuRowLabelClassName}>{other.switchLabel}</span>
            </DropdownMenu.Item>
          </>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
