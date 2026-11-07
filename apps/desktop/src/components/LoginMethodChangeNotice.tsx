import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { loginMethodNotice, LOGIN_METHOD_NOTICE_KEY } from '../lib/accountLinking'
import { localLoginNoticeKey } from '../lib/accountLinkingAdapter'
import { notify } from '../lib/notices'
import { rendererLogger } from '../lib/log'
import { supabase } from '../lib/supabase'
import '../i18n/registerSettingsCatalog'

const log = rendererLogger('auth/login-method-notice')

export function LoginMethodChangeNotice({ userId }: { userId: string }) {
  const { t } = useTranslation('settings')
  useEffect(() => {
    let alive = true
    void (async () => {
      const { data, error } = await supabase.auth.getUser()
      if (error) throw error
      if (!alive || data.user.id !== userId) return
      let notice = loginMethodNotice(data.user)
      const local = window.localStorage.getItem(localLoginNoticeKey(userId))
      if (local) {
        const value: unknown = JSON.parse(local)
        const pending = loginMethodNotice({ ...data.user, user_metadata: { [LOGIN_METHOD_NOTICE_KEY]: value } })
        if (pending && (!notice || Date.parse(pending.at) > Date.parse(notice.at))) notice = pending
      }
      if (!notice) return
      const seenKey = `gugu-login-method-notice-seen:${userId}`
      if (window.localStorage.getItem(seenKey) === notice.id) return
      notify({ title: t(`loginMethods.notices.${notice.kind}`), tier: 'info' })
      window.localStorage.setItem(seenKey, notice.id)
    })().catch((error: unknown) => { log.error({ error }, 'read login method notice failed') })
    return () => { alive = false }
  }, [userId, t])
  return null
}
