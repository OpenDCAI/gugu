import { useEffect, useState } from 'react'
import { platform } from '../platform'

// @@@mobile-shell (#1278) — single source for "are we in the mobile shell?", extracted from
// MainLayout so shared primitives (e.g. the responsive Sheet) branch on the SAME rule the layout
// does.
//
// @@@desktop-never-mobile (#3566) — 手机 shell 只属于手机:原生 Capacitor 壳,或在手机浏览器里打开的
// web 目标(视口窄于 720px 的平板断点)。**桌面 Electron 主窗无论被拖到多窄都保持桌面形态**——
// owner 2026-09-08 拍板:「我是不想要手机端形态的展示在桌面端,这很奇怪」。此前 #2525 反过来把主窗
// 地板降到 360 好让桌面窗口"进得去"手机 shell,那条决策已作废(地板回到 800,见 electron/main.ts)。
// web 目标仍按视口宽度实时切换(resize 监听),那是 #5014「手机看管 agent」在手机浏览器里的真实形态。
export const MOBILE_SHELL_MAX_WIDTH = 720

/** 同步读一次当前是否处于手机 shell;MainLayout 的冷启动初值走它,避免首帧落错 tab 再由 effect 纠回。 */
export function readMobileShell(): boolean {
  if (platform.kind === 'capacitor') return true
  if (platform.kind === 'electron') return false
  return window.innerWidth < MOBILE_SHELL_MAX_WIDTH
}

export function useMobileShell(): boolean {
  const [mobile, setMobile] = useState(readMobileShell)

  useEffect(() => {
    if (platform.kind !== 'web') return
    const handleResize = () => setMobile(readMobileShell())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return mobile
}
