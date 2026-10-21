import type { Theme } from '@/store/theme'

/**
 * 会话页内容的主题类:gugu-skin 皮肤 + 跟随 gugu 当前主题的会话页主题类。会话页的全局规则收窄在
 * `.gugu-skin` 上(session/renderer/index.css),两套 token 命名空间由 emlight/emdark 驱动 ——
 * 会话页挂载元素与设置弹窗里会话页那几格(SessionSettingsSection)用同一个。
 */
export function sessionSkinClassName(theme: Theme): string {
  return `${theme === 'light' ? 'emlight' : 'emdark'} gugu-skin`
}
