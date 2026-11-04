import { AUTOMATION_TEST_IDS } from './automationDom'

/**
 * @@@composer-focus-contract (#4315) — 全 app 唯一一条「聚焦输入框」的路。
 *
 * reason 分两类，语义不同：
 * - **进入可输入语境**：用户主动进入一条会话（点会话行、通讯录发消息、群、发现页、新建 agent 落地、
 *   点系统通知、切 tab 回到会话）。
 * - **会话内续接动作**：用户已经在这条会话里打字（选了 slash 命令、点了引用、刚发出一条、插入表情/提及）。
 *
 * 两条门控写在契约里，❌ 不散到各入口：
 * ① **只有用户主动动作才抢焦点**。后台事件（新消息到达、别处 agent 起来了、outbox 重投、远端
 *    provisioning）没有 reason，也就没有入口 —— 这与 [[app-shell]] 的导航来源门控是同一条边界。
 * ② **移动壳「进入会话」不抢焦点**：抢了就立刻弹软键盘，把本来就短的消息区再挤掉一半，
 *    与微信 / iMessage / Telegram 的惯例相反；移动端由用户点输入框来决定什么时候起键盘。
 *    会话内续接动作不受此限 —— 那时键盘本来就起着，不聚焦反而会把它收掉、打断正在打的这句话。
 * ③ **移动壳「刚发出一条」收键盘**(owner 10-28 手机试用):这句话已经说完，键盘该收起把消息区还回来。
 *    以前它算续接动作要重新聚焦 —— 点发送键时焦点先落到按钮上、键盘开始收、壳跟着可视视口长高，
 *    下一帧又被抢回输入框、键盘再弹、壳再缩：整个 App 上下抽一下(「发一条消息全屏闪一下」)。
 *    手机发送后收键盘由 ChatComposer.handleSubmit 负责；这里只禁止发送后抢回焦点。
 */
export type ComposerFocusReason =
  | 'chat-entry'
  | 'tab-return'
  | 'profile-chat'
  | 'group-chat'
  | 'explore-chat'
  | 'notification-open'
  | 'slash-command'
  | 'quote-attached'
  | 'message-sent'
  | 'caret-move'
  /** #7199 手机助理 App:点了收起的输入条,或「问问它」把一句话填进来 —— 人要接着打字(唤起键盘)。 */
  | 'composer-open'

/** 「进入可输入语境」的那一类 reason —— 只有它们受移动软键盘惯例约束。 */
const SESSION_ENTRY_REASONS: ReadonlySet<ComposerFocusReason> = new Set([
  'chat-entry',
  'tab-return',
  'profile-chat',
  'group-chat',
  'explore-chat',
  'notification-open',
])

export interface ComposerFocusContext {
  /** 当前是不是移动壳（`useMobileShell`）。缺省按桌面处理。 */
  mobileShell?: boolean
  /** 聚焦后把光标放在第几个字符（插入表情/提及后回到插入点）。缺省不动光标。 */
  caret?: number
  /** 会话内续接动作落在动作发生的那个输入框(话题分栏那份不登记,只能这样指名)。缺省 = 登记的主输入框。 */
  target?: () => HTMLElement | null
}

/** 纯判定：这次 reason 在这个宿主形态下该不该抢焦点。单测直接测它，不需要 DOM。 */
export function shouldFocusComposer(
  reason: ComposerFocusReason,
  context: ComposerFocusContext = {},
): boolean {
  if (reason === 'message-sent') return context.mobileShell !== true
  if (!SESSION_ENTRY_REASONS.has(reason)) return true
  return context.mobileShell !== true
}

const COMPOSER_SELECTOR = `[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`
const MAX_FOCUS_FRAMES = 40

type ComposerTargetResolver = () => HTMLElement | null
// ⚠️ @@@5856 一扇窗里同一时刻只有一个输入框该接「进入会话」的落点 ——
// 话题分栏那一份必须传 surface="aside" 不登记,否则分栏一开,「进入会话」那一类的落点就被它接管:
// 从会话列表点进主线,光标却落在话题输入框里 —— 正是话题要隔离的那个方向,反过来了。
// #7199 主输入框不止一个(对话页一个、「助理」App 里那条私聊一个),两个都常驻、同一时刻至多一个摆在眼前:
// 后登记的优先,但藏着的(visibility:hidden / display:none 的面里)跳过 —— ❌ 光标落进看不见的那一个。
// 会话内续接动作不看登记,由 context.target 指名动作发生的那个输入框。
const registeredTargets: ComposerTargetResolver[] = []

/**
 * composer 挂载时登记自己的输入框，让契约不必靠 DOM 查询猜哪个是它（也让同一份实现能带光标位置）。
 * 没有登记时退回按 test-id 查询：那是驱动与 shell 共用的稳定锚点。
 */
export function registerComposerFocusTarget(resolve: ComposerTargetResolver): () => void {
  registeredTargets.push(resolve)
  return () => {
    const at = registeredTargets.lastIndexOf(resolve)
    if (at >= 0) registeredTargets.splice(at, 1)
  }
}

function onScreen(element: HTMLElement): boolean {
  return typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true })
}

function resolveComposer(target?: ComposerTargetResolver): HTMLElement | null {
  if (target) return target()
  for (let at = registeredTargets.length - 1; at >= 0; at -= 1) {
    const registered = registeredTargets[at]()
    if (registered && onScreen(registered)) return registered
  }
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>(COMPOSER_SELECTOR)
}

/** Focus the normal chat composer when a user explicitly enters or continues a conversation. */
export function focusComposer(reason: ComposerFocusReason, context: ComposerFocusContext = {}): boolean {
  if (typeof document === 'undefined') return false
  if (!shouldFocusComposer(reason, context)) return false
  const composer = resolveComposer(context.target)
  if (!composer || composer.matches(':disabled, [aria-disabled="true"]')) return false
  if (context.caret !== undefined && composer instanceof HTMLTextAreaElement) {
    composer.selectionStart = context.caret
    composer.selectionEnd = context.caret
  }
  composer.focus({ preventScroll: true })
  return document.activeElement === composer
}

/** Retry across the render boundary without introducing per-entry timers. */
export function scheduleComposerFocus(
  reason: ComposerFocusReason,
  context: ComposerFocusContext = {},
): () => void {
  if (typeof window === 'undefined') return () => {}
  // 判定与重试分开:被门控挡下的 reason 一帧都不排,❌ 不让它空转 40 帧再放弃。
  if (!shouldFocusComposer(reason, context)) return () => {}
  let cancelled = false
  let framesLeft = MAX_FOCUS_FRAMES
  const attempt = () => {
    if (cancelled || focusComposer(reason, context) || framesLeft-- <= 0) return
    window.requestAnimationFrame(attempt)
  }
  window.requestAnimationFrame(attempt)
  return () => {
    cancelled = true
  }
}
