import { observeAnimationViewport } from '@gugu/session-shared/animation-visibility'
import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react'
import { textShimmer, textShimmerBaseSweep, textShimmerClip, textShimmerInk, textShimmerLightInk, textShimmerSweep } from '@gugu/session-chat-ui/styles/effects'

/** React labels share the transcript's stationary glyphs and composited masks. */
export function TextShimmer({ children, className, ...props }: Omit<ComponentPropsWithoutRef<'span'>, 'children'> & { children: string }) {
  const host = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    return observeAnimationViewport(element, visible => {
      element.dataset.shimmerVisible = String(visible)
    })
  }, [])
  return (
    <span {...props} ref={host} className={`${textShimmer}${className ? ` ${className}` : ''}`}>
      {children}
      <span aria-hidden="true" className={textShimmerClip}>
        <span className={textShimmerBaseSweep}>
          <span className={textShimmerInk} data-shimmer-text={children} />
        </span>
        <span className={textShimmerSweep}>
          <span className={`${textShimmerInk} ${textShimmerLightInk}`} data-shimmer-text={children} />
        </span>
      </span>
    </span>
  )
}
