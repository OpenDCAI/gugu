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
  ],
  desktop: [
    { id: 'assistant', anchor: '.gg-sidebar-rail [data-rail="assistant"]', use: '.gg-sidebar-rail [data-rail="assistant"]' },
    { id: 'collaboration', anchor: marker('desktop', 'collaboration'), use: `${marker('desktop', 'collaboration')} button, [data-project-row]` },
  ],
}

function hintSpaceOf(device: HintDevice, id: FirstRunHintId, anchor: HTMLElement): Element | null {
  const space = device === 'phone' && id === 'collaboration'
    ? anchor.closest('.gg-partners')?.querySelector('[data-first-run-hint-space="collaboration"]')
    : anchor.nextElementSibling
  return space?.getAttribute('data-first-run-hint-space') === id ? space : null
}

const HIDDEN_BY_ATTRIBUTE = '[hidden], [inert], [aria-hidden="true"]'

// @@@hint-visibility - 一个入口「看得见」由 IntersectionObserver 说:它在渲染这一步顺带算出,藏着的常驻面
// (content-visibility:hidden,见 retainedSurface)、display:none、滚出视口都判不相交。❌ 每次 DOM 变化就
// checkVisibility / getComputedStyle 逐层往上读:那会当场把被跳过的整棵隐藏子树的样式算一遍,会话越多,
// 每收一条消息越慢。DOM 变化只用来增删候选元素(按选择器,不读样式、不读布局)。
export function useFirstRunHintTargets(device: HintDevice, enabled: boolean): readonly HintTarget[] {
  const [targets, setTargets] = useState<readonly HintTarget[]>([])
  useEffect(() => {
    if (!enabled) {
      setTargets((current) => current.length ? [] : current)
      return
    }
    const entries = HINT_ENTRIES[device]
    const shown = new Map<HTMLElement, boolean>()
    const publish = () => {
      const next = entries.flatMap(({ id, anchor }) => {
        const element = [...shown].filter(([candidate, visible]) => visible && candidate.matches(anchor) && !candidate.closest(HIDDEN_BY_ATTRIBUTE))
          .map(([candidate]) => candidate)
          .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)[0]
        return element ? [{ id, anchor: element, space: hintSpaceOf(device, id, element) }] : []
      })
      setTargets((current) => current.length === next.length && current.every((target, i) => target.id === next[i].id && target.anchor === next[i].anchor && target.space === next[i].space) ? current : next)
    }
    const intersection = new IntersectionObserver((records) => {
      for (const record of records) {
        const element = record.target as HTMLElement
        if (shown.has(element)) shown.set(element, record.isIntersecting && record.boundingClientRect.width > 0 && record.boundingClientRect.height > 0)
      }
      publish()
    })
    const selector = entries.map(({ anchor }) => anchor).join(', ')
    const track = (element: Element) => {
      if (!(element instanceof HTMLElement) || shown.has(element)) return
      shown.set(element, false)
      intersection.observe(element)
    }
    const scan = (root: Element) => {
      if (root.matches(selector)) track(root)
      root.querySelectorAll(selector).forEach(track)
    }
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => { if (node instanceof Element) scan(node) })
        if (record.type === 'attributes' && record.target instanceof Element && record.target.matches(selector)) track(record.target)
      }
      for (const element of shown.keys()) {
        if (element.isConnected && element.matches(selector)) continue
        shown.delete(element)
        intersection.unobserve(element)
      }
      publish()
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'data-first-run-hint', 'data-first-run-device'] })
    scan(document.body)
    return () => {
      mutations.disconnect()
      intersection.disconnect()
    }
  }, [device, enabled])
  return targets
}
