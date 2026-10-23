import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { TOUR_FEATURES } from './catalog'
import split from '../../assets/product-tour/feature-1.webm'
import modes from '../../assets/product-tour/feature-2.webm'
import contacts from '../../assets/product-tour/feature-3.webm'
import report from '../../assets/product-tour/feature-4.webm'
import splitPoster from '../../assets/product-tour/feature-1.webp'
import modesPoster from '../../assets/product-tour/feature-2.webp'
import contactsPoster from '../../assets/product-tour/feature-3.webp'
import reportPoster from '../../assets/product-tour/feature-4.webp'

const films = [split, modes, contacts, report]
const posters = [splitPoster, modesPoster, contactsPoster, reportPoster]
const chapterStarts = [[0, 1.45, 4.3, 5.6, 8.2, 12.5], [0, 1.4, 3.6, 6.5, 9, 11.3, 14.1, 16.3, 19.9, 22.2, 24.3], [0, 2.3, 4.5, 7.2, 11.8], [0, 4.2, 7.5, 14, 17]]

export function FeatureTour({ index, children, onSelect, onClose }: { index: number; children: ReactNode; onSelect: (index: number) => void; onClose: () => void }) {
  const { t } = useTranslation('productTour')
  // The dialog primitive can emit a close notification while its controlled
  // content is being replaced (for example, when moving from film 1 to film 2).
  // Only the explicit tour controls are allowed to finish the tour; otherwise
  // a save transition could be mistaken for the user dismissing the tour.
  return <Dialog.Root open onOpenChange={() => {}}>
    <Dialog.Portal><Dialog.Backdrop className="product-tour-feature-backdrop" /><Dialog.Viewport className="product-tour-feature-viewport">
      <Dialog.Popup className="product-tour-feature">
        <header className="product-tour-feature-header">
          <span>{t('featureHeader')}</span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('skip')}>×</Button>
        </header>
        <div className="product-tour-feature-heading">
          <div className="product-tour-kicker">{t('featuresProgress', { current: index + 1, total: 4 })}</div>
          <Dialog.Title>{t(`feature.${TOUR_FEATURES[index]}.title`)}</Dialog.Title>
          <Dialog.Description>{t(`feature.${TOUR_FEATURES[index]}.body`)}</Dialog.Description>
        </div>
        <FeatureFilm key={index} index={index} />
        <div className="product-tour-feature-footer">
          <div className="product-tour-feature-dots" aria-label={t('featureSteps')}>
            {TOUR_FEATURES.map((feature, step) => <Button variant="ghost" size="icon" key={feature} aria-label={t(`feature.${feature}.title`)} onClick={() => onSelect(step)} aria-current={step === index ? 'step' : undefined}><span className="product-tour-dot" /></Button>)}
          </div>
          {children}
        </div>
      </Dialog.Popup>
    </Dialog.Viewport></Dialog.Portal>
  </Dialog.Root>
}

function FeatureFilm({ index }: { index: number }) {
  const { t } = useTranslation('productTour')
  const video = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)
  const [autoplay] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [playing, setPlaying] = useState(autoplay)
  useEffect(() => {
    if (!playing) return
    let frame: number
    const updateProgress = () => {
      if (video.current) setTime(video.current.currentTime)
      frame = requestAnimationFrame(updateProgress)
    }
    frame = requestAnimationFrame(updateProgress)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  const chapter = Math.max(0, chapterStarts[index].findLastIndex((start) => time >= start))
  const replay = () => {
    const player = video.current
    if (!player) return
    setFailed(false)
    if (player.error) player.load()
    player.currentTime = 0
    void player.play().then(() => setPlaying(true)).catch(() => { setFailed(true); setPlaying(false) })
  }
  const togglePlay = () => {
    const player = video.current
    if (!player) return
    if (player.paused) void player.play().then(() => setPlaying(true)).catch(() => { setFailed(true); setPlaying(false) })
    else { player.pause(); setPlaying(false) }
  }
  return <section aria-label={t(`feature.${TOUR_FEATURES[index]}.title`)}>
    <video className="product-tour-film" ref={video} src={films[index]} poster={posters[index]} muted playsInline autoPlay={autoplay}
      preload="metadata" aria-describedby="product-tour-film-caption" onError={() => { setFailed(true); setPlaying(false) }}
      onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}>
      <track kind="captions" srcLang="zh-CN" label="简体中文" src={new URL(`../../assets/product-tour/feature-${index + 1}.vtt`, import.meta.url).href} />
    </video>
    <div className="product-tour-film-controls">
      <Button variant="ghost" onClick={togglePlay}>{playing ? t('pause') : t('play')}</Button>
      <p id="product-tour-film-caption">{t(`feature.${TOUR_FEATURES[index]}.captions.${chapter}`)}</p>
      <Button variant="ghost" onClick={replay}>{t('replay')}</Button>
    </div>
    <div className="product-tour-film-track"><input aria-label={t('filmProgress')} type="range" min={0} max={duration || 1} step="any" value={Math.min(time, duration || 1)} onChange={(event) => {
      const next = Number(event.currentTarget.value)
      if (video.current) video.current.currentTime = next
      setTime(next)
    }} /><span>{Math.floor(time)}s / {Math.floor(duration)}s</span></div>
    {failed && <p role="alert" className="product-tour-error">{t('filmFailed')} <Button variant="ghost" onClick={replay}>{t('retry')}</Button></p>}
  </section>
}
