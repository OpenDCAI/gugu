import { readMobileShell } from '../../hooks/useMobileShell'

/** 购买入口跟随积分卡:桌面订阅、手机账户;用量只查看统计。 */
export function membershipSettingsSection(mobile = readMobileShell()): 'account' | 'subscriptions' {
  return mobile ? 'account' : 'subscriptions'
}
