/**
 * @@@host-os — 「用户在什么操作系统上」的**唯一**探针。
 *
 * ⚠️ 它与 `lib/window-chrome.ts` 的 `readRendererPlatform()` 是**两件事**,别合并:
 *   · 这一条答「什么系统」—— 决定 ⌘/Ctrl 文案、路径写法、装不装得上某个东西。web 构建也要答。
 *   · 那一条答「画什么窗口外壳」—— 读 `<html data-platform>`,而 main.tsx **有意**让它在
 *     web 上恒为 'other'(没有无边框窗口就不该预留窗口按钮的位置)。
 *   拿 data-platform 去回答第一个问题,浏览器里的 mac 用户会被告知按 Ctrl。
 *
 * 2026-09-19 收敛之前,这个问题在渲染层有 8 处各自的写法、两套词汇
 * ('mac'|'other' 与 'darwin'|'win32'),任何一处漂移都只在一个平台上现形。
 *
 * 主进程与渲染层都会 import 本文件 ⇒ `navigator` 与 `process` **都不能假定存在**。
 * 渲染层的答案优先;在 node 上也安全:Node ≥21 定义了 `navigator` 且报的是浏览器形状的值
 * (实测 darwin/v24 = 'MacIntel'、linux/v22 = 'Linux x86_64'),所以 `darwin` 永远到不了正则。
 */
export type HostOsKind = 'mac' | 'win' | 'linux' | 'other';

function reportedPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const nav = navigator as { userAgentData?: { platform?: string }; platform?: string; userAgent?: string };
  return nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
}

/**
 * ⚠️ iPad / iPhone / iPod 归在 `'mac'` 这一档,**是有意的**:收敛之前四处探针写的都是
 * `/Mac|iPod|iPhone|iPad/`,因为这一档真正决定的是「这套键盘用不用 ⌘」,而苹果平台都用。
 * 把它们改判成 'other' 会让 iPad 上的 web 构建把 ⌘ 文案换成 Ctrl —— 那是**行为回退**,
 * 不是更准确。❌ 别顺手"修正"它。
 */
export function detectHostOs(): HostOsKind {
  const reported = reportedPlatform();
  if (reported) {
    if (/mac|ipod|iphone|ipad/i.test(reported)) return 'mac';
    if (/win/i.test(reported)) return 'win';
    if (/linux|x11/i.test(reported)) return 'linux';
    return 'other';
  }
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    if (process.platform === 'darwin') return 'mac';
    if (process.platform === 'win32') return 'win';
    if (process.platform === 'linux') return 'linux';
  }
  return 'other';
}

export function isMacHost(): boolean {
  return detectHostOs() === 'mac';
}

export function isWindowsHost(): boolean {
  return detectHostOs() === 'win';
}
