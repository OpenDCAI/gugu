import { useEffect,useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notices'
import './connection-copy'

/** One transient notice per empty read episode; cached views stay silent. */
export function useConnectionReadNotice(key: string,hasData: boolean,failures: number) {
  const { t } = useTranslation('connections'),shown = useRef('')
  useEffect(() => {
    if (hasData || failures < 4 || shown.current === key) return
    shown.current = key
    notify({ key: `connections-read:${key}`,tier: 'error',title: t('readUnavailable') })
  },[key,hasData,failures,t])
}
