/**
 * @@@win-overlay-scrollbar Windows 上让 Chromium 画悬浮滚动条,与 mac 同一个样子。
 *
 * 症状:会话页树(任务页、App 页)的滚动条在 Windows 上常驻、带上下箭头、占 10px,压在阅读面的圆角上;
 * mac 上同一条 CSS 是系统悬浮条(静止不显示、不占宽)。
 *
 * 根因(Chromium 152.0.7977.54 = Electron 44 源码):会话页树写的是 `scrollbar-width: thin`,这是 design.md
 * 要的「quiet overlay scrollbar」,交给系统滚动条去画。Windows / Linux 上 Chromium 恒用 Fluent 滚动条
 * (`ui/native_theme/features/native_theme_features.cc` `IsFluentScrollbarEnabled`),悬浮与否取决于 feature
 * `OverlayScrollbar` —— 桌面默认关。关着时 Fluent 是经典条:15px × thin 的 2/3 = 10px,带箭头。
 *
 * 修法:Windows 上在 app ready 前打开 `OverlayScrollbar`。只影响**系统画的**滚动条(会话页树、App 的页);
 * 主渲染树自定义的 `::-webkit-scrollbar` 细条不受影响。Windows 设置里打开「始终显示滚动条」
 * (`HKCU\Control Panel\Accessibility\DynamicScrollbars` = 0)时 Chromium 自己退回常驻条,照样尊重用户设置。
 *
 * ❌ 改 CSS(删 `scrollbar-width` 换成自定义细条):那会把 mac 上设计要的悬浮条也换成常驻条。
 * ❌ 在 Linux 也开:Linux 同样是 Fluent 经典条,但没有读数;这一行只按 Windows 量过。
 * ⚠️ `enable-features` 整个主进程只能有这一处写:同名开关追加两次,Chromium 只认最后一个值。
 *   要再开别的 feature,合进这里的值(逗号分隔),❌ 另起一处 appendSwitch。
 */

/** 打开 Chromium 悬浮滚动条的 feature 名(Chromium 152 起;旧名 `FluentOverlayScrollbar` 已删,开了无效)。 */
export const OVERLAY_SCROLLBAR_FEATURE = 'OverlayScrollbar'

export function shouldEnableOverlayScrollbars(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

export function enableOverlayScrollbars(
  commandLine: { appendSwitch(key: string, value?: string): void },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!shouldEnableOverlayScrollbars(platform)) return false
  commandLine.appendSwitch('enable-features', OVERLAY_SCROLLBAR_FEATURE)
  return true
}
