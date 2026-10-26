import { useEffect, useState } from 'react'
import type { FirstRunHintId } from '@/lib/firstRunHints'

export type HintDevice = 'phone' | 'desktop'
export type HintTarget = { id: FirstRunHintId; anchor: HTMLElement; space: Element | null }
type HintEntry = { id: FirstRunHintId; anchor: string; use: string }
const marker = (device: HintDevice, id: FirstRunHintId) => `[data-first-run-hint="${id}"][data-first-run-device="${device}"]`

// The main UI and embedded workspace have separate React roots in the same document.
// Follow their real entries without introducing another cross-root data/IPC bridge.
export const HINT_ENTRIES: Record<HintDevice, readonly HintEntry[]> = {
  phone: [
    { id: 'assistant', anchor: marker('phone', 'assistant'), use: marker('phone', 'assistant') },
    { id: 'collaboration', anchor: marker('phone', 'collaboration'), use: '[data-testid="phone-partners-project"], [data-testid="phone-partners-friend"], .gg-partners-navrow' },
    { id: 'topics', anchor: marker('phone', 'topics'), use: `${marker('phone', 'topics')} [role="tab"]` },
  ],
  desktop: [
    { id: 'assistant', anchor: '.gg-sidebar-rail [data-rail="assistant"]', use: '.gg-sidebar-rail [data-rail="assistant"]' },
    { id: 'collaboration', anchor: marker('desktop', 'collaboration'), use: `${marker('desktop', 'collaboration')} button, [data-project-row]` },
    { id: 'topics', anchor: '.session-tab-bar:has([data-project-block-tab]) [data-topic-tab] [data-tab-label]', use: '.session-tab-bar:has([data-project-block-tab]) [data-topic-tab] [data-tab-label]' },
  ],
}

export function hintTargetVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  if (element.checkVisibility?.() === false) return false
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return false
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return false
  }
  return true
}

function hintSpaceOf(device: HintDevice, id: FirstRunHintId, anchor: HTMLElement): Element | null {
  const space = device === 'phone' && id === 'collaboration'
    ? anchor.closest('.gg-partners')?.querySelector('[data-first-run-hint-space="collaboration"]')
    : (device === 'desktop' && id === 'topics' ? anchor.closest('.session-tab-bar') : anchor)?.nextElementSibling
  return space?.getAttribute('data-first-run-hint-space') === id ? space : null
}

export function useFirstRunHintTargets(device: HintDevice, enabled: boolean): readonly HintTarget[] {
  const [targets, setTargets] = useState<readonly HintTarget[]>([])
  useEffect(() => {
    if (!enabled) {
      setTargets((current) => current.length ? [] : current)
      return
    }
    const locate = () => {
      const next = HINT_ENTRIES[device].flatMap(({ id, anchor }) => {
        const element = [...document.querySelectorAll<HTMLElement>(anchor)].find(hintTargetVisible)
        return element ? [{ id, anchor: element, space: hintSpaceOf(device, id, element) }] : []
      })
      setTargets((current) => current.length === next.length && current.every((target, i) => target.id === next[i].id && target.anchor === next[i].anchor && target.space === next[i].space) ? current : next)
    }
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'inert', 'aria-hidden', 'data-first-run-hint'] })
    window.addEventListener('resize', locate)
    document.addEventListener('scroll', locate, true)
    locate()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', locate)
      document.removeEventListener('scroll', locate, true)
    }
  }, [device, enabled])
  return targets
}
