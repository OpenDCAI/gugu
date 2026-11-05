import { readMobileShell } from '../../hooks/useMobileShell'
import { UI_EVENTS } from '../uiEvents'

/** 购买入口跟随积分卡:桌面订阅、手机账户;用量只查看统计。 */
export function membershipSettingsSection(mobile = readMobileShell()): 'account' | 'subscriptions' {
  return mobile ? 'account' : 'subscriptions'
}

/** Keep conversation links on the same real credit-card destination as account settings. */
export function openCreditSettings(): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: membershipSettingsSection() } }))
}
