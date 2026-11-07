import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { claimStartupBrand, hasStartupMotion, hasStartupVisual, subscribeStartupMotion } from '../../lib/startup-motion'
import { isAnimationWindowVisible, subscribeAnimationWindowVisibility } from '@gugu/session-shared/animation-visibility'
import motionDocument from './brand-motion.html?raw'

/** The approved D v2.3 bird/wordmark animation, isolated from the authentication document. */
export function AuthBrandMotion() {
  const host = useRef<HTMLDivElement>(null)
  const [claimedStartup, setClaimedStartup] = useState(hasStartupMotion)
  const startupVisual = useSyncExternalStore(subscribeStartupMotion, hasStartupVisual, () => false)
  const continuingStartup = claimedStartup && startupVisual
  const [document, setDocument] = useState('')
  const motion = useRef<HTMLIFrameElement>(null)
  const tellMotion = () => motion.current?.contentWindow?.postMessage({ guguWindowVisible: isAnimationWindowVisible() }, '*')
  useEffect(() => subscribeAnimationWindowVisibility(tellMotion), [])
  useLayoutEffect(() => {
    const release = claimStartupBrand(host.current!)
    setClaimedStartup(Boolean(release))
    return release ?? undefined
  }, [])
  useEffect(() => {
    if (continuingStartup) return
    const element = host.current!
    let visible = false
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const mount = () => {
      if (!visible) { setDocument(''); return }
      const colors = getComputedStyle(element)
      const rgb = colors.color.match(/[\d.]+/g)!.slice(0, 3).join(',')
      setDocument(motionDocument.replaceAll('__MOTION_RGB__', rgb).replaceAll('__MOTION_BG__', colors.backgroundColor))
    }
    const intersection = new IntersectionObserver(([entry]) => { visible = entry!.isIntersecting; mount() })
    intersection.observe(element)
    const theme = new MutationObserver(mount)
    theme.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    reducedMotion.addEventListener('change', mount)
    return () => { intersection.disconnect(); theme.disconnect(); reducedMotion.removeEventListener('change', mount) }
  }, [continuingStartup])
  return <div ref={host} className="gugu-auth-motion" aria-hidden="true">
    {!continuingStartup && document && <iframe ref={motion} onLoad={tellMotion} key={document} title="gugu" tabIndex={-1} sandbox="allow-scripts" srcDoc={document} />}
  </div>
}
