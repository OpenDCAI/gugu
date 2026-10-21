import { useSyncExternalStore } from 'react'

/**
 * @@@sidebar-tint owner 2026-09-10：三栏应该是一条底色阶梯 —— 最左的功能栏最深、中间的
 * 会话/任务列表居中、右边的消息区最浅。浅色主题下中间那一档是缺席的(`--sidebar` 就是 #fff,
 * 与消息区一模一样),于是列表和内容糊成一片。这个开关把中间那一档补上。
 *
 * **默认关**：关着的时候今天的界面一个像素都不动,颜色只在打开后才换。
 *
 * 真值落在 `<html data-sidebar-tint="on">` 上,颜色本身在 styles/tokens.css 里只改写
 * `--sidebar` 一个 token —— 会话列表 / 通讯录 / 设置导航(`.gg-pane[data-role='nav']`)与
 * 会话页左栏(皮肤桥的 `.bg-background-tertiary` + `--em-background-secondary`)本来就都吃
 * 这一个 token,所以一处到位。会话页那棵 Shadow DOM 靠自定义属性的继承拿到同一个值,
 * ❌ 不需要第二条同步链。
 *
 * 首帧之前由 index.html 的引导脚本落一次属性(与主题同一个位置、同一套规则),避免开着这个
 * 选项启动时先闪一下白底再变灰。
 */
const STORAGE_KEY = 'gugu.sidebar-tint'
const DEFAULT_ENABLED = false
const ATTRIBUTE = 'data-sidebar-tint'
const ATTRIBUTE_ON = 'on'

const listeners = new Set<() => void>()
let current: boolean | null = null

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return DEFAULT_ENABLED
  }
}

export function readSidebarTintEnabled(): boolean {
  if (typeof window === 'undefined') return DEFAULT_ENABLED
  current ??= readStored()
  return current
}

/** 把开关的当下值落到 `<html>` 属性上 —— 上色的唯一出口。 */
export function applySidebarTint(enabled: boolean = readSidebarTintEnabled()): void {
  if (typeof document === 'undefined') return
  if (enabled) document.documentElement.setAttribute(ATTRIBUTE, ATTRIBUTE_ON)
  else document.documentElement.removeAttribute(ATTRIBUTE)
}

export function setSidebarTintEnabled(enabled: boolean): void {
  if (readSidebarTintEnabled() === enabled) return
  current = enabled
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch {
    // 存不下(隐私模式/配额满)不该拦住这次视觉切换:本次会话照样生效,下次启动退回默认。
  }
  applySidebarTint(enabled)
  for (const listener of listeners) listener()
}

/** 把存下来的偏好落到属性上。引导脚本已经做过一次,这里兜住属性被别处清掉的情况。 */
export function hydrateSidebarTint(): void {
  applySidebarTint(readSidebarTintEnabled())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSidebarTintEnabled(): boolean {
  return useSyncExternalStore(subscribe, readSidebarTintEnabled, () => DEFAULT_ENABLED)
}
