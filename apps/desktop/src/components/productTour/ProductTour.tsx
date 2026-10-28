import { messageForUser } from '@/lib/userFacingError';
import './catalog'
import './product-tour.css'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { saveProductTourState, useRememberProductTourState, type ProductTourState, type TourStepId } from '../../lib/productTour'
import { rendererLogger } from '../../lib/log'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { useTourTarget } from './tourTargets'

const log = rendererLogger('product-tour')
const PAD = 8

/** 半透明遮罩挖空目标。四块遮罩接住点击(点了没反应,规范 2.2);挖空处不拦,目标照常能点。 */
function Spotlight({ rect }: { rect: DOMRect }) {
  const x = Math.max(0, rect.left - PAD)
  const y = Math.max(0, rect.top - PAD)
  const w = rect.width + PAD * 2
  const h = rect.height + PAD * 2
  const swallow = (event: React.SyntheticEvent) => { event.preventDefault(); event.stopPropagation() }
  const shade = (style: React.CSSProperties) => <div className="product-tour-shade" style={style} onPointerDown={swallow} onClick={swallow} aria-hidden />
  return (
    <div className="product-tour-spotlight" data-testid="product-tour-spotlight">
      {shade({ left: 0, top: 0, right: 0, height: y })}
      {shade({ left: 0, top: y + h, right: 0, bottom: 0 })}
      {shade({ left: 0, top: y, width: x, height: h })}
      {shade({ left: x + w, top: y, right: 0, height: h })}
      <div className="product-tour-ring" style={{ left: x, top: y, width: w, height: h }} aria-hidden />
    </div>
  )
}

/**
 * 功能栏导览(规范 2、4.1 第 6 步):遮罩挖空目标 + 带箭头的卡片 + 「n / N」+ 跳过 / 上一步 / 下一步。
 * 走到哪一步、跳过还是走完都记在账号上;跳过以后不再自动弹出,只能从「帮助与导览」继续或重来(规范 4.3)。
 */
export function ProductTour({ userId, steps, start, onDone }: {
  userId: string
  /** 开始时界面上找得到的步骤(availableTourSteps)。 */
  steps: readonly TourStepId[]
  start: TourStepId
  onDone: () => void
}) {
  const { t } = useTranslation('productTour')
  const remember = useRememberProductTourState(userId)
  const [index, setIndex] = useState(() => Math.max(0, steps.indexOf(start)))
  const [error, setError] = useState<string | null>(null)
  const saveTail = useRef(Promise.resolve())
  const card = useRef<HTMLDivElement>(null)
  const step = steps[index]
  const { target, rect } = useTourTarget(step)
  const last = index === steps.length - 1

  // 进度先在界面上走,再串行存到账号:存是为了换设备接着看,❌ 锁住下一步。
  const persist = (state: ProductTourState) => {
    remember(state)
    saveTail.current = saveTail.current.catch(() => undefined).then(() => saveProductTourState(userId, state)).catch((cause) => {
      log.error({ error: String(cause) }, 'save product tour progress failed')
      setError(messageForUser(cause))
    })
  }
  const goTo = (next: number) => {
    setError(null)
    setIndex(next)
    persist({ step: steps[next], status: 'active' })
  }
  const exit = (status: 'skipped' | 'done') => {
    persist({ step, status })
    onDone()
  }
  const next = () => (last ? exit('done') : goTo(index + 1))
  const previous = () => { if (index > 0) goTo(index - 1) }

  useEffect(() => { persist({ step, status: 'active' }) }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 开始那一刻记一次

  // 要动手的一步:点了高亮的目标才往下走。
  useEffect(() => {
    if (!target?.action) return
    const element = target.element
    const advance = () => next()
    element.addEventListener('click', advance)
    return () => element.removeEventListener('click', advance)
  })

  // 键盘(规范 2.2):Enter / → 下一步,← 上一步,Esc 跳过;Tab 只在卡片里转。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 高亮的设置入口照常可用。设置盖在非模态导览上方时,键盘由设置自己处理,导览停在原步骤。
      if (event.target instanceof Element && event.target.closest('[data-settings-modal-card]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exit('skipped'); return }
      if (event.key === 'ArrowLeft') { event.preventDefault(); previous(); return }
      if ((event.key === 'ArrowRight' || event.key === 'Enter') && !target?.action) {
        if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && card.current?.contains(event.target)) return
        event.preventDefault()
        next()
        return
      }
      if (event.key === 'Tab' && card.current) {
        const buttons = [...card.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
        if (!buttons.length) return
        const at = buttons.indexOf(document.activeElement as HTMLElement)
        event.preventDefault()
        buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  })

  if (!target || !rect) return null
  const copy = step === 'tasks' && target.action ? 'tasksSample' : step
  return <>
    <Spotlight rect={rect} />
    <Popover.Root open modal={false}>
      <Popover.Portal>
        <Popover.Positioner anchor={target.element} side="right" align="start" alignOffset={-PAD} sideOffset={PAD + 12} collisionPadding={12} className="product-tour-positioner">
          <Popover.Popup ref={card} className="product-tour-bubble" role="dialog" aria-labelledby="product-tour-title" aria-describedby="product-tour-progress" initialFocus={() => card.current?.querySelector<HTMLElement>('[data-primary]') ?? card.current} data-testid={`product-tour-step-${step}`}>
            <Popover.Arrow className="product-tour-arrow" />
            <div className="product-tour-kicker" id="product-tour-progress" aria-label={t('stepAria', { current: index + 1, total: steps.length })}>
              {t('stepProgress', { current: index + 1, total: steps.length })}
            </div>
            <h2 id="product-tour-title">{t(`steps.${copy}.title`)}</h2>
            <p>{t(`steps.${copy}.body`)}</p>
            {error && <p role="alert" className="product-tour-error">{error}</p>}
            <footer className="product-tour-actions">
              {last ? <span /> : <Button variant="ghost" size="sm" onClick={() => exit('skipped')} data-testid="product-tour-skip">{t('skip')}</Button>}
              <div>
                {index > 0 && <Button variant="ghost" size="sm" onClick={previous} data-testid="product-tour-previous">{t('previous')}</Button>}
                {!target.action && <Button variant="primary" size="sm" data-primary onClick={next} data-testid="product-tour-next">{last ? t('done') : t('next')}</Button>}
              </div>
            </footer>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </>
}
