import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../components/toastContext'
import { openAppLink, SERVER_LOGIN_APPROVE_EVENT, type ServerLoginApproveDetail } from '../../lib/inAppLinks'
import { rendererLogger } from '../../lib/log'
import { useMobileShell } from '../../hooks/useMobileShell'
import { platform } from '../../platform'
import { ServerLoginApproveSheet } from './ServerLoginApproveSheet'

const log = rendererLogger('mobile/server-login')

/**
 * 「批准机器」页的宿主,挂在登录后的整棵树上(与 ShareIntakeHost 同一处)。只在手机壳里接:桌面上点那条链接照旧开浏览器。
 * 两个入口都经 openAppLink:聊天里点的链接(chatLinks)、系统交给 App 的链接(安卓 App Links → subscribeOpenedLinks;
 * 没登录时到的那一条由平台留着,登录后订阅时补发)。后来的那一条为准:人最后点的才是他此刻要批的。
 */
export function ServerLoginApproveHost({ active }: { active: boolean }) {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const mobile = useMobileShell()
  const [code, setCode] = useState<string | null>(null)
  const on = active && mobile
  useEffect(() => {
    if (!on) return
    const take = (event: Event) => {
      event.preventDefault()
      setCode((event as CustomEvent<ServerLoginApproveDetail>).detail.code)
    }
    window.addEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    // 系统按 manifest 把链接交给了咕咕,咕咕却认不出(打包时 manifest 的库与网页连的库不一致):说出来,❌ 当没点过。
    // 不转交浏览器:系统会按同一条 intent-filter 再交回咕咕。
    const unsubscribe = platform.subscribeOpenedLinks?.((url) => {
      if (openAppLink(url)) return
      log.warn({ url: url.split('?')[0] }, 'opened link not recognised')
      toast(t('devices.approveServer.unrecognised'), 'error')
    })
    return () => {
      window.removeEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
      unsubscribe?.()
    }
  }, [on, t, toast])
  const done = useCallback(() => setCode(null), [])
  return code !== null ? <ServerLoginApproveSheet key={code} code={code} onDone={done} /> : null
}
