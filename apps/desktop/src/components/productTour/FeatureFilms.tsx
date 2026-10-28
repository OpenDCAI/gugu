import './catalog'
import './product-tour.css'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { FeatureTour } from './FeatureTour'
import { TOUR_FILMS } from './catalog'

/** 三段功能短片,只从「帮助与导览」打开(规范 4.1:导览本身只讲功能栏七格)。 */
export function FeatureFilms({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('productTour')
  const [index, setIndex] = useState(0)
  const last = index === TOUR_FILMS.length - 1
  return <FeatureTour index={index} onSelect={setIndex} onClose={onClose}>
    <footer className="product-tour-actions">
      <span />
      <div>
        {index > 0 && <Button variant="ghost" onClick={() => setIndex(index - 1)}>{t('previous')}</Button>}
        <Button variant="primary" onClick={() => (last ? onClose() : setIndex(index + 1))}>{last ? t('done') : t('next')}</Button>
      </div>
    </footer>
  </FeatureTour>
}
