import type PhotoSwipe from 'photoswipe'
import { bindFileZoom, readFileZoom, writeFileZoom, subscribeFileZoom, zoomForCommand } from './file-content-zoom'

/** The viewer's image reading zoom: applied per slide from the shared preference, written back on a real zoom, menu commands while focused. */
export function wireReadingZoom(pswp: PhotoSwipe): () => void {
  let applyingZoom = false
  let initialized = false
  const applyReadingZoom = () => {
    const slide = pswp.currSlide
    if (!initialized || !slide) return
    const next = Math.min(slide.zoomLevels.max, Math.max(slide.zoomLevels.initial, slide.zoomLevels.initial * readFileZoom('image')))
    if (Math.abs(next - slide.currZoomLevel) < 0.000001) return
    applyingZoom = true
    try { slide.zoomTo(next, undefined, 0) } finally { applyingZoom = false }
  }
  // A ratio held at this image's cap must not lower a larger preference that a bigger image or the workspace viewer can honour.
  pswp.on('zoomPanUpdate', ({ slide }) => {
    if (!initialized || applyingZoom || slide !== pswp.currSlide || !(slide.zoomLevels.initial > 0)) return
    const ratio = Math.max(1, slide.currZoomLevel / slide.zoomLevels.initial)
    if (slide.currZoomLevel >= slide.zoomLevels.max - 0.000001 && readFileZoom('image') >= ratio) return
    writeFileZoom('image', ratio)
  })
  pswp.on('afterInit', () => {
    initialized = true
    applyReadingZoom()
    if (!pswp.element) return
    const offCommand = bindFileZoom(pswp.element, command => {
      const slide = pswp.currSlide
      const shown = slide && slide.zoomLevels.initial > 0 ? slide.currZoomLevel / slide.zoomLevels.initial : readFileZoom('image')
      writeFileZoom('image', Math.max(1, zoomForCommand(shown, command)))
      applyReadingZoom()
    })
    const offPreference = subscribeFileZoom(applyReadingZoom)
    pswp.on('destroy', () => { offCommand(); offPreference() })
  })
  pswp.on('change', applyReadingZoom)
  return applyReadingZoom
}
