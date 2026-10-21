import { platform } from '../platform'
import { i18n } from '@/i18n'

/**
 * @@@5301 通知这一格的两个出口:**替用户去开权限**,以及**自己验一遍链路**。
 *
 * 设置里的开关只表达「用户想不想收」,能不能真的弹出来由系统权限说了算 —— 两者不是一回事,
 * 而界面上原本只有前者:系统那头把横幅拦掉时,这里仍然显示「已开启」,用户无从知道断在哪
 * (owner 2026-09-09:「他如果要权限，那应该监控下权限把倒是，现在失败都不知道失败在那」)。
 *
 * 这两个函数**不放在 SettingsPanel.tsx 里**:那是组件文件,再导出非组件会破 react-refresh
 * 的 fast-refresh 边界(`react-refresh/only-export-components`,仓库 lint `--max-warnings 0`)。
 */

/**
 * 自验:发一条真的系统通知,并把**系统给的结论**带回来。
 *
 * `accepted` 只代表系统收下了这条请求 —— 提醒样式是「无」时它会被直接归档进通知中心,
 * 那一层 Electron 读不到,所以 ❌ 不要把 accepted 讲成「用户看见横幅了」。
 * `rejected` 才是硬读数:macOS 从 Electron 42 起走 UNNotification,被拒时系统回一个原因
 * (常见的是 "Notifications are not allowed for this application"),这里原样带给用户。
 */
export type NotificationTestResult =
  | { kind: 'accepted' }
  | { kind: 'rejected'; error: string }
  | { kind: 'unsupported' }

export async function sendTestNotification(): Promise<NotificationTestResult> {
  if (!platform.capabilities.notifications) return { kind: 'unsupported' }
  try {
    const result = await platform.showNotification({
      title: i18n.t('settings.general.notificationsTestTitle', { ns: 'main' }),
      body: i18n.t('settings.general.notificationsTestBody', { ns: 'main' }),
      chatId: null,
    }) as { displayed?: unknown; unsupported?: unknown; error?: unknown } | null
    if (result?.unsupported === true) return { kind: 'unsupported' }
    if (typeof result?.error === 'string' && result.error.length > 0) {
      return { kind: 'rejected', error: result.error }
    }
    return { kind: 'accepted' }
  } catch (error) {
    return { kind: 'rejected', error: String(error) }
  }
}
