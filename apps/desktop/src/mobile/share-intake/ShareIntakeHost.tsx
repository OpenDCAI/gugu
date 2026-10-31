import { useCallback, useEffect, useState } from 'react'
import { platform } from '../../platform'
import type { IncomingShare } from '../../platform/types'
import { useTranslation } from 'react-i18next'
import { Sheet } from '../../components/ui/Sheet'
import { ShareIntakeContent } from './ShareIntakeSheet'

/**
 * 别的 App 分享给咕咕的入口(product spec),挂在登录后的整棵树上。
 * 没登录时分享进来的那一份由宿主留着,这里一订阅就补发过来 —— 登录完直接到「发送到」页。
 * 上一份还没选会话时又来一份,以新的为准:用户最后一次点的分享才是他此刻要发的。
 */
export function ShareIntakeHost({ active }: { active: boolean }) {
  const { t } = useTranslation('messaging')
  const [share, setShare] = useState<IncomingShare | (() => void) | null>(null)
  useEffect(() => {
    if (!active || !platform.subscribeIncomingShares) return
    return platform.subscribeIncomingShares(setShare)
  }, [active])
  const done = useCallback((afterClose?: () => void) => setShare(() => afterClose ?? null), [])
  const incoming = share && typeof share !== 'function' ? share : null
  return <Sheet open={incoming !== null} onClose={done} onClosed={() => { if (typeof share === 'function') { share(); setShare(null) } }} fullScreenMobile testId="share-intake-sheet" ariaLabel={t('shareIntake.title')}>
    {incoming ? <ShareIntakeContent share={incoming} onDone={done} /> : null}
  </Sheet>
}
