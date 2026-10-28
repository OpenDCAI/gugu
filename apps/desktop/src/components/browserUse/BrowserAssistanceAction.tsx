import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import '../../i18n/registerBrowserUseCatalog'
import './browserUse.css'
import { useMobileShell } from '@/hooks/useMobileShell'
import { Globe, KeyRound } from '@/lib/icons'
import { followLink } from '@/lib/guguLinks'
import { notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import type { Settlement } from '@gugu/session-core/session-record/contract'
import type { CloudBrowserAssistance } from '@/session/shared/cloud-browser'
import { Button } from '../ui/Button'
import { BROWSER_USE_APP_ID, browserUseTab, isBrowserAssistance, openBrowserUseTab } from './browserUsePlace'

/**
 * 任务卡 / 审批条上「agent 请你登录 / 接手」那一问的主入口:打开这个任务的 Browser Use 页签(那里有画面、接管和
 * 密码保险箱;登录请求一打开就递出保险箱)。「完成 / 取消」照旧由那一问自己的按钮答。
 * 没装 / 停用了 Browser Use:照实说,指到它在「App」页上的那一页(装 / 启用都在那里)—— ❌ 摆一个点了没反应的按钮。
 */
export const BrowserAssistanceAction = observer(function BrowserAssistanceAction({
  sessionId,
  settlement,
}: {
  sessionId: string
  settlement: Pick<Settlement, 'origin'>
}) {
  const { t } = useTranslation('browserUse')
  const [opening, setOpening] = useState(false)
  // App 页签只在桌面上:手机上这一问照旧只有它自己的按钮。
  const mobile = useMobileShell()
  if (mobile || !isBrowserAssistance(settlement)) return null
  const login = (settlement.origin?.payload as Partial<CloudBrowserAssistance> | undefined)?.kind === 'login'
  const { state, tab } = browserUseTab()
  if (state !== 'ready') {
    return (
      <div className="bu-ask" data-testid="browser-assistance-action" data-state={state}>
        <p className="bu-ask-note">{t(state === 'disabled' ? 'ask.disabled' : 'ask.missing')}</p>
        <Button variant="secondary" size="sm" onClick={() => followLink({ kind: 'app-detail', extensionId: tab?.extensionId ?? BROWSER_USE_APP_ID })}>{t('ask.goToApps')}</Button>
      </div>
    )
  }
  const open = () => {
    setOpening(true)
    void openBrowserUseTab(sessionId)
      .catch((error: unknown) => notify({ tier: 'error', title: t('ask.openFailed', { reason: messageForUser(error) }) }))
      .finally(() => setOpening(false))
  }
  return (
    <div className="bu-ask" data-testid="browser-assistance-action" data-state={state}>
      <Button variant="primary" size="sm" disabled={opening} onClick={open}>
        {login ? <KeyRound size={14} /> : <Globe size={14} />} {t(login ? 'ask.login' : 'ask.open')}
      </Button>
    </div>
  )
})
