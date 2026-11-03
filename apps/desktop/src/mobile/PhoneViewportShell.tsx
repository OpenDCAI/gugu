import { useImperativeHandle, useLayoutEffect, useRef, type ComponentProps } from 'react'
import { PhoneViewportContext, usePhoneViewport } from './usePhoneViewport'
import './PhoneViewportShell.css'

/** Keep keyboard geometry in shell chrome: resizing must not rerender every retained page. */
export function PhoneViewportShell({ mobile, ref, className, style, children, ...props }: ComponentProps<'div'> & { mobile: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => root.current!, [])
  const viewport = usePhoneViewport(mobile)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    if (mobile) {
      element.style.setProperty('--phone-viewport-height', viewport.viewportHeight === null ? '100dvh' : `${viewport.viewportHeight}px`)
      element.style.setProperty('--phone-viewport-top', `${viewport.viewportOffsetTop}px`)
    } else {
      element.style.removeProperty('--phone-viewport-height')
      element.style.removeProperty('--phone-viewport-top')
    }
  }, [mobile, viewport.viewportHeight, viewport.viewportOffsetTop])
  return <PhoneViewportContext.Provider value={viewport}>
    <div {...props} ref={root} className={mobile ? `gg-phone-viewport-shell ${className ?? ''}` : className} style={style}>{children}</div>
  </PhoneViewportContext.Provider>
}
