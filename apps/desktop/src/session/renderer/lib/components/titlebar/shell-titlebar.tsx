import { motion, useTransform } from 'framer-motion'
import { observer } from 'mobx-react-lite'
import { useEffect, type ReactNode } from 'react'
import { ListColumnToggle } from '@/components/PanelToggleButtons'
import { publishListHotkey, publishPanelToggle } from '@/lib/panelToggles'
import {
  hasWindowTitlebarRow,
  readRendererPlatform,
  shellRestoreLane,
  TITLEBAR_ACTION_SLOT_WIDTH_PX,
  TITLEBAR_LEFT_EDGE_GAP_PX,
  WINDOW_CONTROL_BAR_HEIGHT_PX,
} from '@/lib/window-chrome'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts'
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider'
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format'
import { useSessionMessages } from '@renderer/localization/use-session-messages'

/** 28px 按钮在这条 40px 带里居中 —— 左右两端同一个式子,❌ 别在调用点另写 top-*。 */
const TITLEBAR_ACTION_TOP_PX = (WINDOW_CONTROL_BAR_HEIGHT_PX - TITLEBAR_ACTION_SLOT_WIDTH_PX) / 2


/**
 * 会话页**唯一**一枚左侧栏开关:把侧栏登记进 panelToggles(#6753),并在没有标题栏行的平台上把那颗按钮挂在会话页根部。
 *
 * 它挂在会话页根部(<WorkspaceLayout>),不在侧栏里、也不在主区里 —— 所以侧栏开合时它一动不动,
 * 侧栏是从它下面滑过去的。改造前是两枚:侧栏展开时那枚长在侧栏顶端靠右,收起时另换一枚浮到
 * 主区左上角 —— 同一个功能的按钮在两种状态下落在两个坐标,点完一下手就得去别处找它。
 * 按钮本身是 PanelToggleButtons 的 <ListColumnToggle>,与对话页、Windows 标题栏行挂的是同一个组件;
 * 刚点完 / 预览浮着时不弹提示也在那里。
 *
 * **收起态下悬停它会浮出侧栏预览**(见 sidebar-peek.ts);此时再点 = 把预览钉成常驻,且不放动画(layout-provider 的 setCollapsed)——
 * 它已经画在那儿了,再从零滑一次是重影。
 */
export const ShellSidebarToggle = observer(function ShellSidebarToggle() {
  const { translate } = useSessionMessages()
  const { value: keyboard } = useAppSettingsKey('keyboard')
  const { isLeftOpen, isLeftPeeking, toggleLeft, setTriggerHovered } = useWorkspaceLayoutContext()
  const hotkey = getEffectiveHotkey('toggleLeftSidebar', keyboard)
  const shortcut = hotkey ? formatHotkeyText(hotkey) : undefined
  const label = translate(isLeftOpen ? 'task.collapseSidebar' : 'task.expandSidebar')

  useEffect(
    () =>
      publishPanelToggle('list:sessions', { open: isLeftOpen, label, peeking: isLeftPeeking, toggle: toggleLeft, setTriggerHovered, shortcut }),
    [isLeftOpen, isLeftPeeking, label, setTriggerHovered, shortcut, toggleLeft]
  )
  // 对话页的列表栏用同一个键(useListColumnCollapse)。
  useEffect(() => publishListHotkey(hotkey), [hotkey])

  // Windows 上这颗挂在标题栏行(WindowTitleBar),这里 ❌ 再挂第二颗(#5454)。
  if (hasWindowTitlebarRow(readRendererPlatform())) return null
  return (
    <div
      className="absolute z-50 [-webkit-app-region:no-drag]"
      // 几何内联而不用 utility:tokens.css 那条 `*{margin:0;padding:0}` 在皮肤壳外面会静默抹平 utility。
      style={{ top: TITLEBAR_ACTION_TOP_PX, left: TITLEBAR_LEFT_EDGE_GAP_PX }}
    >
      <ListColumnToggle slot="list:sessions" />
    </div>
  )
})

/** The shared frameless-window handle used by full workspace and composer-only surfaces. */
export function ShellTitlebarDragRegion() {
  return (
    <div
      className="absolute inset-x-0 top-0 h-10 [-webkit-app-region:drag] pointer-events-none"
      data-session-titlebar-drag-region=""
    />
  )
}

/**
 * 会话页**唯一**的顶栏外壳。
 *
 * 为什么要有它:在它之前,同一个 app 里并行跑着两套 chrome —— 主页/新建任务/会话/项目用零高度浮层,
 * 而设置、自动化、技能、MCP 各自返回一条真的 40px 横条(其中技能与 MCP 那两条**里面一个控件都没有**,
 * 纯粹占 40px 高、画一条边框)。于是每换一屏就换一套顶栏。owner 实机原话:
 * 「我觉得这算是一个工作区,他应该得到统一,而不是这么分裂,一步一景」。
 *
 * 现在所有视图都用这一层:零高度浮层,不占版面、不画边框,内容从窗口顶端起。
 *  · leftSlot —— 这一屏的身份(标题 / 面包屑 / 项目菜单)。
 *  · children —— 右上角那一排里**属于窗口 chrome 的那层**(如工作区面板开关)。
 *    ❌ 没有工作区面板的视图别塞它:那个开关会去开新建会话页的面板,是个空动作。
 *
 * 竖直基线只有一个来源:28px 按钮居中在 40px 带里 = top 6px。❌ 别在调用点另写 top-*。
 *
 * ⚠️ 侧栏开关**不在这里** —— 它在会话页根部(<WorkspaceLayout> 的 <ShellSidebarToggle>),
 * 因为这一层住在主区里、会跟着侧栏左右移动,而那枚按钮的要求正是"不移动"。
 */
export const ShellTitlebar = observer(function ShellTitlebar({
  leftSlot,
  children,
}: {
  leftSlot?: ReactNode
  children?: ReactNode
}) {
  const { leftAnimatedWidth } = useWorkspaceLayoutContext()

  // leftSlot 只需要让开**压在主区上的那一截**开关车道:侧栏越宽,按钮越多地压在侧栏上,
  // 主区这边要让的就越少。用同一个动画值算,于是它和侧栏是连续地一起动,❌ 不是随 isLeftOpen 瞬跳。
  const leftSlotOffset = useTransform(leftAnimatedWidth, (width) =>
    Math.max(TITLEBAR_LEFT_EDGE_GAP_PX, shellRestoreLane(readRendererPlatform()) - width)
  )

  return (
    <div className="relative z-40 h-0">
      {/* Keep the shell layout zero-height, but make the full top chrome lane a usable window handle.

          这条带压在两层上,两层都要让开,少一层按钮就点不动:
           · OS 层 —— `[-webkit-app-region:drag]` 的区域**吞掉一切指针事件**(Electron
             *Custom Window Interactions* 原文:「Draggable areas ignore all pointer events」)。
             退订的唯一办法是 `app-region: no-drag`,见 index.css 的 @@@titlebar-no-drag。
           · Blink 层 —— 它还是一个 `pointer-events: auto` 的覆盖层,位于 `z-40` 上下文,
             盖在这条带里所有普通流内容之上。只有窗口固定簇靠 `fixed z-50` 逃掉,其余容器
             (消息栏动作、会话栏 header、分割线顶部 40px)的点击都落到这个 div 身上。
             所以它必须 `pointer-events-none`。

          `pointer-events-none` ❌ 不会让窗口拖不动:拖拽区由 `app-region` 定义,不经 Blink
          的命中测试。真机实测(真鼠标点击,不是 elementFromPoint):只有 no-drag 时三个按钮
          全部点不到,叠加本行后全部点到,还原后又全部点不到。 */}
      <ShellTitlebarDragRegion />
      {leftSlot ? (
        <motion.div
          className="absolute top-0 flex h-10 items-center [-webkit-app-region:no-drag]"
          style={{ left: leftSlotOffset }}
          data-shell-titlebar-left=""
        >
          {leftSlot}
        </motion.div>
      ) : null}
      {children}
    </div>
  )
})
