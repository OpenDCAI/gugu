/**
 * 原生窗口外壳的常量 —— 主进程建窗时用。放 `@shared` 是因为它**两边都要**:
 * 渲染层那份(`src/lib/window-chrome.ts`)管的是网页内要让出多少;这份管的是系统在窗口上画什么。
 */

/**
 * @@@traffic-lights — macOS 原生交通灯在窗口里的位置,**全 app 一个数**。
 *
 * 从前三个窗口各写各的:主窗 `{x:5,y:14}`、会话页那份(已删)`{x:10,y:10}`、
 * widget 窗 `{x:8,y:14}` —— 而 Titlebar 给它们让位用的是单一常量。三套坐标对一套让位,
 * 哪个对谁都说不清。值取主窗那一份:#822 定的,由 68px rail 给三颗灯右侧留出少量呼吸。
 */
export const TRAFFIC_LIGHT_POSITION = { x: 5, y: 14 } as const;

/**
 * @@@822 无边框统一标题栏:mac 保留原生交通灯(`hiddenInset`),Windows/Linux 完全无边框、
 * 由 renderer 自绘 min/max/close。
 *
 * ⚠️ `titleBarStyle: 'hiddenInset'` **只在 mac 生效**;无条件设它 = Windows/Linux 回落原生边框,
 * 那正是 #822 的根因。❌ 别再在某个窗口上单独写一份 —— 新开窗口从这里取。
 */
export function nativeWindowChrome(platform: NodeJS.Platform): Record<string, unknown> {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHT_POSITION };
  }
  return { frame: false };
}
