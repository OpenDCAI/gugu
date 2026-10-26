import { messageForUser } from '@/lib/userFacingError';
import './catalog'
import './product-tour.css'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { finishFirstRun } from '../../lib/firstRun'
import { nextProductTourPosition, previousProductTourPosition, saveProductTourPosition, type ProductTourPosition } from '../../lib/productTour'
import { rendererLogger } from '../../lib/log'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { TOUR_MODULES } from './catalog'
import { useTourAnchor } from './useTourAnchor'
import { FeatureTour } from './FeatureTour'

const log = rendererLogger('product-tour')

export function ProductTour({ userId, initial, onDone }: { userId: string; initial?: ProductTourPosition | null; onDone: () => void }) {
  const { t } = useTranslation('productTour')
  const [position, setPosition] = useState<ProductTourPosition>(initial ?? { phase: 'modules', index: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTail = useRef(Promise.resolve())
  const rail = position.phase === 'modules' ? TOUR_MODULES[position.index] : null
  const target = useTourAnchor(rail, true)

  const go = async (next: ProductTourPosition | null) => {
    if (busy) return
    if (next) {
      // 先切换界面，再串行持久化进度。保存是跨设备恢复用的后台工作，不能锁住下一步按钮。
      const previous = position
      setPosition(next)
      if (next.phase === 'features') document.querySelector<HTMLElement>('.gg-sidebar-rail [data-rail="chats"]')?.click()
      saveTail.current = saveTail.current
        .catch(() => undefined)
        .then(() => saveProductTourPosition(userId, next))
        .catch((cause) => {
          log.error({ error: String(cause) }, 'save product tour progress failed')
          setPosition((current) => current.phase === next.phase && current.index === next.index ? previous : current)
          setError(messageForUser(cause))
        })
      return
    }
    setBusy(true)
    setError(null)
    try {
      // A pending position write must finish before marking the account's tour complete.
      await saveTail.current
      await finishFirstRun()
      onDone()
    } catch (cause) {
      log.error({ error: String(cause) }, 'finish product tour failed')
      setError(messageForUser(cause))
    } finally {
      setBusy(false)
    }
  }
  const previous = previousProductTourPosition(position)
  const controls = <>
    {error && <p role="alert" className="product-tour-error">{error}</p>}
    <footer className="product-tour-actions">
      <Button variant="ghost" disabled={busy} onClick={() => void go(null)}>{t('skip')}</Button>
      <div>
        {previous && <Button variant="ghost" disabled={busy} onClick={() => void go(previous)}>{t('previous')}</Button>}
        <Button variant="primary" disabled={busy} onClick={() => void go(nextProductTourPosition(position))}>
          {position.phase === 'features' && position.index === 3 ? t('done') : position.phase === 'modules' && position.index === 6 ? t('features') : t('next')}
        </Button>
      </div>
    </footer>
  </>

  if (position.phase === 'features') return <FeatureTour index={position.index} onSelect={(index) => void go({ phase: 'features', index })} onClose={() => void go(null)}>{controls}</FeatureTour>
  if (!target || !rail) return null
  return <Popover.Root open modal={false} onOpenChange={(open, event) => { if (!open && event.reason === 'escape-key') void go(null) }}>
    <Popover.Portal container={target.container}>
      <Popover.Positioner anchor={target.anchor} side="right" align="center" sideOffset={16} className="product-tour-positioner">
        <Popover.Popup className="product-tour-bubble" aria-labelledby="product-tour-title" initialFocus>
          <Popover.Arrow className="product-tour-arrow" />
          <div className="product-tour-kicker">{t('modulesProgress', { current: position.index + 1, total: 7 })}</div>
          <h2 id="product-tour-title">{t(`modules.${rail}.title`)}</h2>
          <p>{t(`modules.${rail}.body`)}</p>
          {controls}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
