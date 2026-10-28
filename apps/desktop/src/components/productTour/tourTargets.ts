import { useLayoutEffect, useState } from 'react'
import { TOUR_STEPS, type TourStepId } from '../../lib/productTour'
import { readPanelToggle } from '../../lib/panelToggles'

/**
 * 每一步指着的真实入口(规范 2.1)。「项目」那一步有示例项目时是要动手的一步:点开它才往下走(规范 4.2)。
 * 「项目」「对话」两格在「消息」里:页签不在屏上时先把「消息」打开,❌ 别的入口替人点。
 */
type Target = { element: HTMLElement; action: boolean }
function findTarget(step: TourStepId): Target | null {
  const visible = (el: Element | null): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
      && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
  }
  if ((step === 'tasks' || step === 'chats') && readPanelToggle('list:sessions')?.open === false) return null
  if (step === 'tasks') {
    const sample = document.querySelector('[data-tour="sample-project"]')
    if (visible(sample)) return { element: sample, action: true }
    const tab = document.querySelector('[data-testid="sidebar-list-page-projects"]')
    return visible(tab) ? { element: tab, action: false } : null
  }
  if (step === 'chats') {
    const tab = document.querySelector('[data-testid="sidebar-list-page-chats"]')
    return visible(tab) ? { element: tab, action: false } : null
  }
  const rail = document.querySelector(`.gg-sidebar-rail [data-rail="${step}"]`)
  return visible(rail) ? { element: rail, action: false } : null
}

/** 这一刻界面上找得到的步骤;找不到的那一步不出现,N 跟着少(规范 2.3)。「项目」「对话」在「消息」里,能打开就算有。 */
export function availableTourSteps(): TourStepId[] {
  // 收起的列表仍保留 DOM,但其页签已经滑出窗口。先用原有控制器展开,不能指着那份离屏坐标。
  const list = readPanelToggle('list:sessions')
  if (list && !list.open) list.toggle()
  const messages = document.querySelector('.gg-sidebar-rail [data-rail="chats"]')
  const messagesVisible = messages instanceof HTMLElement && messages.getBoundingClientRect().width > 0 && messages.getBoundingClientRect().height > 0
  return TOUR_STEPS.filter((step) => (step === 'tasks' || step === 'chats') ? messagesVisible || !!findTarget(step) : !!findTarget(step))
}

function openMessagesIfNeeded(step: TourStepId) {
  if ((step === 'tasks' || step === 'chats') && !findTarget(step)) {
    document.querySelector<HTMLElement>('.gg-sidebar-rail [data-rail="chats"]')?.click()
  }
}

export function useTourTarget(step: TourStepId): { target: Target | null; rect: DOMRect | null } {
  const [target, setTarget] = useState<Target | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    openMessagesIfNeeded(step)
    let frame = 0
    let observed: HTMLElement | null = null
    const resize = new ResizeObserver(() => schedule())
    // 高亮、卡片、箭头在同一帧里按目标的新位置重算,❌ 三者错位(规范 2.3)。
    const measure = () => {
      frame = 0
      const next = findTarget(step)
      if (next?.element !== observed) {
        if (observed) resize.unobserve(observed)
        observed = next?.element ?? null
        if (observed) {
          resize.observe(observed)
          observed.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }
      setTarget((current) => current?.element === next?.element && current?.action === next?.action ? current : next)
      const box = next?.element.getBoundingClientRect() ?? null
      setRect((current) => current && box && current.x === box.x && current.y === box.y && current.width === box.width && current.height === box.height ? current : box)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
    }
  }, [step])
  return { target, rect }
}

