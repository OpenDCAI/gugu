/**
 * 手机长按菜单的版面(owner 11-05 定方案 A):回应条在气泡上方,动作列表在气泡下方,气泡本身浮在中间。
 * 三样必须同屏 —— 气泡尽量不动,放不下才挪到刚好放得下的位置;气泡比剩下的空间还高(长消息),
 * 就只留手指附近那一截当预览。这样菜单永远贴着它说的那条消息,❌ 被推到屏幕底部。
 */
export type Rect = { top: number; left: number; width: number; height: number }

export type PhoneMenuLayout = {
  /** 预览(那截气泡)在屏幕上的位置;height 小于气泡高度 ⇒ 裁过。 */
  preview: Rect
  /** 气泡里从哪一行开始露出来(裁剪时 > 0)。 */
  clipTop: number
  reactions: { top: number; left: number }
  list: { top: number; left: number }
}

const GAP = 8
const PAD = 8
/** 再长的消息也至少露出这么高,认得出是哪条。 */
const MIN_PREVIEW = 48
/** 浮起时放大的倍数(CSS 经 --lift-scale 读这一份)。放大多出来的那圈也要算进缝里,❌ 压到回应条 / 列表上。 */
export const LIFT_SCALE = 1.035

export function phoneMenuLayout({ bubble, touchY, viewport, reactions, list, mine }: {
  bubble: Rect
  touchY: number
  /** 能用的那块屏幕(扣掉刘海 / 手势条的安全区)。 */
  viewport: { top: number; width: number; height: number }
  reactions: { width: number; height: number }
  list: { width: number; height: number }
  mine: boolean
}): PhoneMenuLayout {
  const grow = (LIFT_SCALE - 1) / 2
  const room = (viewport.height - 2 * PAD - reactions.height - list.height - 2 * GAP) / (1 + 2 * grow)
  const height = Math.max(MIN_PREVIEW, Math.min(bubble.height, room))
  const gap = GAP + height * grow
  const clipTop = height < bubble.height ? clamp(touchY - bubble.top - height / 2, 0, bubble.height - height) : 0
  const top = clamp(bubble.top + clipTop, viewport.top + PAD + reactions.height + gap, viewport.top + viewport.height - PAD - list.height - gap - height)
  // 横向:贴着气泡那一侧(我发的靠右,别人发的靠左),碰到屏幕边就往里收。
  const along = (width: number) => clamp(mine ? bubble.left + bubble.width - width : bubble.left, PAD, viewport.width - PAD - width)
  return {
    preview: { top, left: bubble.left, width: bubble.width, height },
    clipTop,
    reactions: { top: top - gap - reactions.height, left: along(reactions.width) },
    list: { top: top + height + gap, left: along(list.width) },
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
