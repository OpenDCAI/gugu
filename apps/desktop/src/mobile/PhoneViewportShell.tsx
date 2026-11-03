import type { ComponentProps } from 'react'
import { PhoneViewportContext, usePhoneViewport } from './usePhoneViewport'

/** Keep keyboard geometry in shell chrome: resizing must not rerender every retained page. */
export function PhoneViewportShell({ mobile, style, children, ...props }: ComponentProps<'div'> & { mobile: boolean }) {
  const viewport = usePhoneViewport(mobile)
  return <PhoneViewportContext.Provider value={viewport}>
    <div {...props} style={{ ...style, ...(mobile ? {
      height: viewport.viewportHeight ?? '100dvh',
      top: viewport.viewportOffsetTop,
    } : {}) }}>{children}</div>
  </PhoneViewportContext.Provider>
}
