import type { Settlement } from '@gugu/session-core/session-record/contract'
import { installedExtensionsStore, type ExtensionTabContributionEntry } from '@/session/renderer/features/extensions/installed-extensions-store'

// 这台电脑上装着的 Browser Use 与它的「浏览器」页签(宿主页)。只读 App 清单:任务卡 / 审批条引它也不拖进会话页的仓库。

/** Browser Use 本身的 App id(它的清单在另一个仓库)。 */
export const BROWSER_USE_APP_ID = 'browser-use'

/**
 * 装着的 App 里那张宿主浏览器页(manifest `hostPage: 'browser'`),优先 Browser Use 本身(`browser-use`)。
 * `state`:ready = 开得出;disabled = 装着但停用了;missing = 没装。
 */
export function browserUseTab(): { state: 'ready' | 'disabled' | 'missing'; tab: ExtensionTabContributionEntry | null } {
  const pages = installedExtensionsStore.allTabContributions
    .filter((entry) => entry.hostBrowser)
    .sort((a, b) => Number(b.extensionId === BROWSER_USE_APP_ID) - Number(a.extensionId === BROWSER_USE_APP_ID))
  const on = pages.find((entry) => entry.enabled)
  if (on) return { state: 'ready', tab: on }
  return pages.length > 0 ? { state: 'disabled', tab: pages[0] ?? null } : { state: 'missing', tab: null }
}

/** 这一问是不是 agent 在等人替它用浏览器(登录 / 接手一步,`browser-assistance`)。 */
export function isBrowserAssistance(settlement: Pick<Settlement, 'origin'> | null | undefined): boolean {
  return settlement?.origin?.source === 'browser-assistance'
}
