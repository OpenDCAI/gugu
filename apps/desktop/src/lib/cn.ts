import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * @@@custom-type-scale - tailwind-merge 只认它内置的字号名。本仓在
 * `session/renderer/index.css` 的 `@theme` 里另立了三档(`--text-code` 13px /
 * `--text-tiny` 11px / `--text-micro` 10px),它一个都不认识 —— 于是把 `text-tiny`
 * 归进**文字颜色**那一组,和同一次 `cn()` 里的 `text-foreground-muted` 判成冲突,
 * 按「后写的赢」把**字号**丢掉。
 *
 * 症状是这一族里最难查的那种:class 字符串看着完全正确、`.text-tiny` 的字号规则
 * 也确实在产出的 CSS 里,只有 `getComputedStyle` 会说话 —— 元素上根本没有那个类。
 * (2026-09-07 #5196 实撞:MCP 卡片的 transport 徽标本该 11px,真机量到 15px,
 *  因为 `cn(mono, 'text-foreground-muted …')` 把 `text-tiny` 吃了。)
 *
 * ❌ 不要在调用点绕开它(手拼 class 串、或把颜色挪出这次 cn):那是给一处打补丁,
 *    下一个人换个组合照样中招。登记在这里,`text-*` 的裁决对全仓一次性正确。
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['tiny', 'micro', 'code'] }] } },
})

/**
 * @@@cn - 渲染层唯一的 class 合成入口。clsx 负责条件拼接,tailwind-merge 负责裁决冲突:
 * 后写的工具类赢,所以 `<Button className="px-6">` 能直接盖掉变体表里的 `px-[14px]`,
 * 不必靠 `!important` 或提高选择器特异性。
 *
 * ❌ 别再在组件文件里手写 `const cx = (...c) => c.filter(Boolean).join(' ')`:那种拼接不裁决冲突,
 * 两个 padding 工具类会一起进 class 列表,最后由 CSS 源序而不是调用者的意图决定谁生效。
 * 会话页的 `@renderer/utils/utils` 也 re-export 这一份,全 app 只有这一个实现。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
