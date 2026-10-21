// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 发现页三个 pane 的挂载策略。
 *
 * 起因：广场的两个子面板原本是条件渲染 —— 切到「找群」再切回来，PlazaMomentsPane
 * 整个卸载，写了一半的草稿就没了，动态还要重拉一次。同一个文件里的 WorkbenchPane
 * 却是「常驻挂载 + CSS 显隐」，两种相反的策略并存。
 *
 * 这里锁住统一后的行为：切子标签不丢用户输入、不重复取数、被隐藏的面板退出可访问性树。
 */

const moments = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }))
const contacts = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('../../../../apps/desktop/src/lib/moments', () => ({
  listFeedPosts: moments.list,
  createMomentPost: moments.create,
  subscribeMoments: vi.fn(() => () => {}),
}))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({
  contactsService: { searchDiscoverableGroups: contacts.search, joinPublicGroup: vi.fn(), requestGroupJoin: vi.fn() },
}))
vi.mock('../../../../apps/desktop/src/lib/presetTeamCatalog', () => ({ loadPresetTeamCatalog: vi.fn(async () => []) }))
vi.mock('../../../../apps/desktop/src/lib/presetTeams', () => ({ presetTeamToAgentTeam: vi.fn((v) => v) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const q: Record<string, unknown> = {}
  q.select = vi.fn(() => q); q.eq = vi.fn(() => q); q.order = vi.fn(() => q)
  q.then = (f: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(f)
  return { identityDb: { from: vi.fn(() => q) } }
})
vi.mock('../../../../apps/desktop/src/lib/createAgentTeam', () => ({
  cancelAgentTeamCreation: vi.fn(), completeAgentTeamCreationHandoff: vi.fn(), createAgentTeam: vi.fn(),
  hydrateAgentTeamForReentry: vi.fn(async (t) => ({ team: t, cancellationOperationId: null })),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ setDraft: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/BuildAgentWizard', () => ({ BuildAgentWizard: () => null }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('../../../../apps/desktop/src/components/discover/PostComments', () => ({ PostComments: () => null }))

import { ExplorePage } from '../../../../apps/desktop/src/pages/ExplorePage'
import { discoverQueryClient } from '../../../../apps/desktop/src/lib/discoverQueryClient'

let container: HTMLDivElement
let root: Root

const q = <T extends Element = Element>(sel: string) => container.querySelector<T>(sel)
const all = (sel: string) => Array.from(container.querySelectorAll(sel))
const subtab = (label: string) =>
  all('[role="tab"]').find((b) => b.textContent?.trim() === label) as HTMLButtonElement

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  discoverQueryClient.clear()
  moments.list.mockResolvedValue([])
  contacts.search.mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(ExplorePage)) })
  await settle()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

const openPlaza = async () => {
  await act(async () => { subtab('广场').click() })
  await settle()
}

describe('发现页 pane 挂载策略', () => {
  it('所有 pane 常驻 DOM，靠 gg-on 显隐 —— 一种策略，不是两种', async () => {
    await openPlaza()
    // wb / pz 是顶层两个面板；mo / gp 是广场里的子面板（嵌套 tablist 在 tabpanel 内，ARIA 允许）
    expect(all('[data-dpane]').map((n) => n.getAttribute('data-dpane')).sort())
      .toEqual(['gp', 'mo', 'pz', 'wb'])
  })

  it('每个 pane 都是 tabpanel，且被对应标签的 aria-controls 指到', async () => {
    await openPlaza()
    for (const t of all('[role="tab"]')) {
      const id = t.getAttribute('aria-controls')
      expect(id, `标签「${t.textContent}」没有 aria-controls`).toBeTruthy()
      const panel = document.getElementById(id!)
      expect(panel?.getAttribute('role')).toBe('tabpanel')
    }
  })

  it('切走再切回来，写了一半的草稿还在（原来这里会整个卸载，草稿凭空消失）', async () => {
    await openPlaza()
    const ta = q<HTMLTextAreaElement>('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(ta, '写到一半的动态')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => { subtab('找群').click() }); await settle()
    await act(async () => { subtab('好友动态').click() }); await settle()

    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('写到一半的动态')
  })

  it('切走再切回来不重新拉动态 —— 面板没卸载，就没有第二次取数', async () => {
    await openPlaza()
    expect(moments.list).toHaveBeenCalledTimes(1)
    await act(async () => { subtab('找群').click() }); await settle()
    await act(async () => { subtab('好友动态').click() }); await settle()
    expect(moments.list).toHaveBeenCalledTimes(1)
  })

  it('隐藏的 pane 不带 gg-on —— 显隐交给 CSS，但读屏顺序里它仍在，靠 tabpanel 语义分区', async () => {
    const wb = q('[data-dpane="wb"]')!
    expect(wb.className).toContain('gg-on')
    await openPlaza()
    expect(q('[data-dpane="wb"]')!.className).not.toContain('gg-on')
    expect(q('[data-dpane="mo"]')!.className).toContain('gg-on')
    expect(q('[data-dpane="gp"]')!.className).not.toContain('gg-on')
  })
})
