/**
 * @@@5637 Linux 桌面上把「有鼠标、能 hover」钉死,别让 Chromium 的设备猜测决定 UI 能不能用。
 *
 * 症状:Linux 包里会话页侧栏 hover 才浮出的「置顶 / 归档」按钮永远不出现,所有 Tailwind
 * `hover:` / `group-hover:` 浮出的控件同样全灭;键盘快捷键不受影响。
 *
 * 根因(d22 真机读数,Electron 44 / Chrome 152,XFCE + Xtigervnc):
 *   matchMedia('(hover: hover)')  → false      matchMedia('(pointer: none)') → true
 * X11 下 Chromium 按 XInput2 枚举到的设备判指针能力;VNC / RustDesk / 无物理鼠标的虚拟桌面
 * 常常一台鼠标都枚举不到,于是整台机器被判成「无指针、不能 hover」。而 Tailwind v4 把全部
 * `hover:` 变体包在 `@media (hover: hover)` 里 —— 媒体查询为假,整块 hover 样式被静默关掉。
 *
 * 修法:Linux 上在 app ready 前用 Chromium 的 `--blink-settings` 只钉 **primary**(主输入设备)的
 * 指针 / hover 类型为 fine + hover。`(hover)` / `(pointer)` 媒体特性按 CSS 规范读的正是 primary,
 * 所以这两条翻真、Tailwind 的 hover 样式恢复。**不碰 available***(`(any-hover)` / `(any-pointer)`
 * 读的那组)—— 留给 Chromium 的设备默认,真有触屏的 Linux 机器上 any-* 仍能如实说「也有触摸」。
 * 已在同一台机器同一个包上实测:加开关后 `(hover: hover)` / `(pointer: fine)` 翻真,hover 按钮浮出并可点。
 *
 * 取值是 blink `PointerType` / `HoverType` 位掩码:hover = 2、pointer fine = 4。
 *
 * ❌ 不改 Tailwind 的 hover 变体定义(`@custom-variant hover (&:hover)`):那会连带改掉 Android 壳
 *   (同一套 web UI)的触屏语义 —— 触屏上 hover 样式会在点按后粘住。
 * ❌ 不钉 available*:把 any-hover / any-pointer 一起写死会抹掉「这机器也有触摸」的真实信息,
 *   而修本 issue 不需要它 —— Tailwind 的 `@media (hover: hover)` 只看 primary。
 * ❌ 不在 mac / Windows 也开:mac 上 Chromium 写死 fine+hover 不会错;Windows 走 SM_MOUSEPRESENT /
 *   平板模式启发式,与 Linux 同类 —— 但本 issue 只在 Linux 量到过,没读数就不钉。
 * ❌ 不给 fallback:开关是无条件钉死,不需要「先探测再决定」——桌面 Linux 客户端一定有鼠标。
 */

/** Chromium `--blink-settings` 的值:只钉 primary 的 hover(2)+ pointer fine(4);available* 不碰。 */
export const LINUX_POINTER_BLINK_SETTINGS = 'primaryHoverType=2,primaryPointerType=4'

/** 只在 Linux 桌面钉指针能力;其它平台 Chromium 的设备读数是对的,不动。 */
export function shouldPinDesktopPointerMedia(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}

export function pinDesktopPointerMedia(
  commandLine: { appendSwitch(key: string, value?: string): void },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!shouldPinDesktopPointerMedia(platform)) return false
  commandLine.appendSwitch('blink-settings', LINUX_POINTER_BLINK_SETTINGS)
  return true
}
