import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '../platform'
import { Sheet } from './ui/Sheet'
import { Button } from './ui/Button'

/**
 * 扫码时相机权限没开(product spec「缺了干不了活的」):动作当场拦下,明说,并给一步去开的路。
 *
 * 「去开启」:系统还肯弹框就再弹一次;不肯弹了就直达系统里咕咕的应用详情;连那一页都跳不过去就说清去哪改。
 * 开好了就收起,❌ 不替用户重扫 —— 从系统设置回来时扫码那一帧早已不在,让他自己再点一次扫码最可预期。
 */
const BODY_STYLE: CSSProperties = { padding: '22px 22px 20px', display: 'flex', flexDirection: 'column', gap: 8 }
const TITLE_STYLE: CSSProperties = { fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--fg)' }
const DESCRIPTION_STYLE: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--muted-fg)', lineHeight: 1.5 }
const ACTIONS_STYLE: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }

export function CameraPermissionSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('main')
  const [pending, setPending] = useState(false)
  const [unreachable, setUnreachable] = useState(false)

  const turnOn = async () => {
    setPending(true)
    try {
      const state = await platform.checkSystemPermission('camera')
      if (state === 'granted') {
        onClose()
        return
      }
      if (state === 'prompt') {
        // 又被拒一次就留在这里:此时系统多半已不肯再弹,下一次点「去开启」会直达系统设置。
        if (await platform.requestSystemPermission('camera') === 'granted') onClose()
        return
      }
      if (!(await platform.openSystemPermissionSettings('camera'))) {
        setUnreachable(true)
        return
      }
      if (await platform.checkSystemPermission('camera') === 'granted') onClose()
    } catch {
      // 弹框或跳转本身失败:下一步只剩用户自己去系统设置,照实指路。
      setUnreachable(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet
      onClose={onClose}
      mobileFitContent
      desktopWidth="min(360px, 100%)"
      testId="camera-permission-sheet"
      ariaLabel={t('shell.cameraPermission.title')}
    >
      <div style={BODY_STYLE}>
        <div style={TITLE_STYLE}>{t('shell.cameraPermission.title')}</div>
        <div role={unreachable ? 'status' : undefined} style={DESCRIPTION_STYLE}>
          {t(unreachable ? 'shell.cameraPermission.unreachable' : 'shell.cameraPermission.description')}
        </div>
        <div style={ACTIONS_STYLE}>
          <Button variant="secondary" onClick={onClose}>{t('shell.cameraPermission.cancel')}</Button>
          <Button variant="primary" disabled={pending} onClick={() => { void turnOn() }}>
            {t('shell.cameraPermission.open')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
