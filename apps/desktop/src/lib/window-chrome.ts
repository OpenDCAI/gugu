export type RendererPlatform = 'mac' | 'win' | 'linux' | 'other'

export const WINDOW_CONTROL_BUTTON_WIDTH_PX = 46
export const WINDOW_CONTROL_BUTTON_COUNT = 3
export const WINDOW_CONTROL_BAR_HEIGHT_PX = 40
export const WINDOW_CONTROLS_WIDTH_PX = WINDOW_CONTROL_BUTTON_WIDTH_PX * WINDOW_CONTROL_BUTTON_COUNT

/**
 * 转瞬层(toast、余额横幅、分享浮层)从这条车道下沿起算 top(`--titlebar-actions-lane`)。
 * 车道本身 40px;有标题栏行的平台再加上那一行 —— main.tsx 按这个函数写 token。
 */
export const TITLEBAR_ACTIONS_LANE_PX = 40

export function titlebarActionsLane(platform: string | undefined): number {
  return windowTitlebarHeight(platform) + TITLEBAR_ACTIONS_LANE_PX
}

export const TITLEBAR_ACTION_SLOT_WIDTH_PX = 28
/**
 * 顶栏这一横排图标的**唯一**一档尺寸。真正落地的是 task renderer index.css 里那条容器规则
 * (`[data-titlebar-actions] svg` / `[data-tabbar-actions] svg`)—— 由容器规定,调用点写错也盖得住。
 * 这里导出同一个数只为让测试拿真值去量,❌ 改这里不会改样式,两处要一起改。
 *
 * 2026-09-07:14 → 16(owner 拍,与侧栏同档)。**这条注释救了这次**——我先只改了 CSS,
 * browser 项目的 titlebar-safe-area 用例当场量出 16 却断言 14 而红。留着这句。
 */
export const TITLEBAR_ACTION_ICON_SIZE_PX = 16
/**
 * 顶栏这一横排**唯一**的水平间距 —— 相邻两个按钮之间一律 4px,不分是不是同一组。
 *
 * 曾经这里还有一个更大的「组间距」,用来把消息栏动作组和窗口固定簇在视觉上分开。owner 否掉了
 * 那个前提,原话:「一簇不一簇是实际行为而不是靠视觉差」「这个 gap 差我不明确,因为都是一串按钮」。
 * 一排图标之间的空隙传达不了「这是两组」,只会读成一个洞;真正区分它们的是行为(一组跟着聊天栏
 * 走、一组锚在窗口),而空白承载不了这个信息。所以❌ 别再引入「组间距」去暗示分组。
 */
export const TITLEBAR_ACTION_SLOT_GAP_PX = 4
/** 固定簇与窗口(或窗口控制条)右缘之间的呼吸。 */
export const TITLEBAR_ACTION_EDGE_GAP_PX = 8

/** 顶栏**左**端与主内容区左缘之间的呼吸 —— 和右端那道 EDGE_GAP 同一档,一条带只有一个数。 */
export const TITLEBAR_LEFT_EDGE_GAP_PX = 8

/**
 * When the sidebar is closed only the collapse toggle stays at the workspace's left edge (the layout button belongs to the
 * list and goes with it, owner 2026-10-23). Reserve its slot plus the shared edge and gap before title content.
 *
 * 不让开就是「浮动按钮压住内容」:实机(#4129 那张图)工作区面板全屏 + 侧栏收起时,首个页签的
 * 文件图标和这枚按钮叠成一团。会话栏 header 早就在让(session-chat-column.tsx),页签条没跟上。
 *
 * ❌ 别在调用点手写车道宽度:按钮改档时这里是唯一要动的地方。
 */
export const SHELL_RESTORE_LANE_PX =
  TITLEBAR_LEFT_EDGE_GAP_PX + titlebarActionsWidth(1) + TITLEBAR_ACTION_SLOT_GAP_PX

/** While the sidebar shows, its header row starts after both controls: collapse, then layout. */
export const SIDEBAR_HEADER_CONTROLS_PX =
  TITLEBAR_LEFT_EDGE_GAP_PX + titlebarActionsWidth(2) + TITLEBAR_ACTION_SLOT_GAP_PX

/** n 个 28px 槽位 + (n-1) 道间距;n=0 时该组不占宽。 */
export function titlebarActionsWidth(slotCount: number): number {
  if (slotCount <= 0) return 0
  return (
    TITLEBAR_ACTION_SLOT_WIDTH_PX * slotCount + TITLEBAR_ACTION_SLOT_GAP_PX * (slotCount - 1)
  )
}

/**
 * Windows 的窗口按钮住在**自己的一行**里 —— 标准 Windows 应用的样子:顶上一条标题栏,
 * 左边前进/后退与「文件 / 编辑 / 视图 / 帮助」下拉菜单,右边最小化 / 最大化 / 关闭;
 * 内容区整体落在它下面,窗口接壤处用共享表面圆角与透明边线裁切,不另画外框(tokens.css)。
 *
 * Linux 仍是旧形态:三颗钮浮在内容右上角,内容给它们让位(windowControlsWidth)。
 * 两个平台分开是因为这一行只按 Windows 的惯例设计过,❌ 顺手把 Linux 一起换掉。
 */
export const WINDOW_TITLEBAR_HEIGHT_PX = 36

export function hasCustomWindowControls(platform: string | undefined): boolean {
  return platform === 'win' || platform === 'linux'
}

export function hasWindowTitlebarRow(platform: string | undefined): boolean {
  return platform === 'win'
}

/**
 * Sidebar controls share the content header on every desktop platform.
 */
export function shellRestoreLane(_platform: string | undefined): number {
  return SHELL_RESTORE_LANE_PX
}

/** 标题栏行占掉的竖直高度;没有这一行的平台为 0,内容从窗口顶端起。 */
export function windowTitlebarHeight(platform: string | undefined): number {
  return hasWindowTitlebarRow(platform) ? WINDOW_TITLEBAR_HEIGHT_PX : 0
}

export function readRendererPlatform(
  doc: Document | undefined = globalThis.document
): RendererPlatform {
  const platform = doc?.documentElement.dataset.platform
  return platform === 'mac' || platform === 'win' || platform === 'linux' ? platform : 'other'
}

/**
 * 内容区右上角要给窗口按钮**让出**的宽度 —— 只有按钮压在内容上时才非 0(Linux)。
 * Windows 的按钮在标题栏行里,不压内容,所以是 0:下面两个预留函数与 main.tsx 写的
 * `--titlebar-controls-width` 都从这里取,一处改全处跟。
 */
export function windowControlsWidth(platform: string | undefined): number {
  return hasCustomWindowControls(platform) && !hasWindowTitlebarRow(platform) ? WINDOW_CONTROLS_WIDTH_PX : 0
}

export function titlebarActionsRight(platform: string | undefined): number {
  return windowControlsWidth(platform) + TITLEBAR_ACTION_EDGE_GAP_PX
}
