import type { ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { TOAST_DWELL_MS, isReadableTier, type ToastTier } from './toastTiers'

/**
 * 全 app 唯一的提示出口(#137)。主 app 与会话页两个 React 根共用同一份 sonner 状态
 * (生产构建里它在两个入口共享的 vendor chunk 里),所以谁调都落到 `<NoticeHost/>` 那一个提示条上。
 *
 * 一条提示有两个轴:
 *  · key —— 同一个 key 永远是同一条:再发一次 = 原地更新它(标题 / 说明 / 档位 / 图标),❌ 叠一条新的。
 *    一件事的状态在变(重连中 → 失败 / 恢复),就用 key 把它们串成一条。
 *  · 寿命 —— 默认到点消失(按档位的停留,见 toastTiers);`ongoing` 是「这件事还没完」:它描述的状态不变就一直在,
 *    由它的结果(再发一条同 key 的、或 dismissNotice)收掉。常驻的一定给关闭钮,❌ 用户想关关不掉。
 */
export interface Notice {
  /** 同 key = 同一条,原地更新。不给 = 一次性的新提示。 */
  key?: string
  title?: string
  description?: ReactNode
  /**
   * 档位与会话页、主 app 同一套(#4891)。没给 = 旧行为一字不变(见下面 `variant`),
   * ❌ 把没迁的调用一次性改成 info 样式 + 3s 停留,是一次没人审过的外观变更。
   */
  tier?: ToastTier
  /** @deprecated 用 `tier`。留着是为了不把 80 多处调用堵在一个 PR 里,迁完即删。 */
  variant?: 'default' | 'destructive'
  /** 这件事还没完:不按停留消失。 */
  ongoing?: boolean
  /** 在等:图标是产品里唯一的那个加载态(loading-state spec),❌ 另画 spinner。 */
  waiting?: boolean
  action?: { label: string; onClick: () => void }
  icon?: ReactNode
  /** 带一次性动作(撤销)的提示要留够点它的时间;不给就是档位的停留。 */
  duration?: number
  /**
   * 这条被收掉时(用户点了关闭钮 / 滑走,以及 `dismissNotice`)。要区分「用户关的」就在调 `dismissNotice` 之前先记下自己要收,
   * ❌ 指望这里分得出来。
   */
  onDismiss?: () => void
}

/**
 * key → 它此刻在 sonner 里的 id。一条提示结束了(被收、被关、到点消失)这个 id 就作废,同 key 再发是新的一条:
 *  · sonner 的收(dismiss)排到下一帧才执行,同 id 紧接着再发,新的那条会被这次收顺手杀掉,还会触发它的 onDismiss
 *    (实测:新建页切到项目页,离线提示没了、而且被当成用户关的,不再回来);
 *  · 同 id 的更新是 `{...旧的, ...新的}`,沿用结束了的 id 就会继承上一条的字段。
 * 还活着的同 key 提示照旧原地更新(同一个 id)。
 */
const liveIds = new Map<string, string>()
let idSeq = 0

const SONNER_BY_TIER = {
  success: sonner.success,
  error: sonner.error,
  warning: sonner.warning,
  info: sonner.info,
} as const

export function notify({ key, title, description, tier, variant, ongoing, waiting, action, icon, duration, onDismiss }: Notice): string | number {
  // 转瞬的确认(成功 / 提示、没有动作、不常驻)点击穿透,别挡住下面的按钮一个停留周期。
  const passthrough = !ongoing && !action && (tier === 'success' || tier === 'info')
  // 每个字段都显式给(没有就是 undefined):sonner 更新同 id 的提示时是 `{...旧的, ...新的}`,省略的字段会沿用上一次 ——
  // 上一次是转瞬的成功(点击穿透)的话,下一次同 key 的常驻提示就会继承它,关闭钮点不到。
  let id: string | undefined
  if (key !== undefined) {
    id = liveIds.get(key) ?? `${key}#${++idSeq}`
    liveIds.set(key, id)
  }
  const retire = () => {
    if (key !== undefined && liveIds.get(key) === id) liveIds.delete(key)
  }
  const options = {
    ...(id !== undefined && { id }),
    description,
    icon: waiting ? <LoadingIndicator size="inline" /> : icon,
    action: action ? { label: action.label, onClick: action.onClick } : undefined,
    onDismiss: () => {
      retire()
      onDismiss?.()
    },
    onAutoClose: retire,
    className: passthrough ? 'gugu-notice-passthrough' : undefined,
    duration: ongoing ? Infinity : duration,
    closeButton: ongoing ? true : undefined,
  }

  // 没显式给档位的调用行为一字不变。
  if (!tier) {
    if (variant === 'destructive') return sonner.error(title ?? '', options)
    return sonner(title ?? '', options)
  }

  return SONNER_BY_TIER[tier](title ?? '', {
    ...options,
    duration: options.duration ?? TOAST_DWELL_MS[tier],
    // 要读要复制的那两档必须能当场关掉 —— 停留翻倍之后,「不可关闭」比「短暂遮挡」更难受。
    closeButton: ongoing || isReadableTier(tier),
  })
}

/** 收掉一条(按它的 key)。没有这条 = 什么都不发生。 */
export function dismissNotice(key: string): void {
  const id = liveIds.get(key)
  if (id === undefined) return
  liveIds.delete(key)
  sonner.dismiss(id)
}
