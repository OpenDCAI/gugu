// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { AgentLookPane } from '../../../../apps/desktop/src/components/agentsettings/AgentLookPane'
import { BODY_COLORS, REST_FACES } from '../../../../apps/desktop/src/components/agentAvatar/engine/identity'
import { colorSlug, parseAgentLook } from '../../../../apps/desktop/src/components/agentAvatar/look'
import type { ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'
import type { ToastContextValue } from '../../../../apps/desktop/src/components/toastContext'

const HOST = 'https://db.example/storage/v1/object/public/avatars'
const look = (slug: string, rest: string) => `${HOST}/agent-look/v1/${slug}.webp?rest=${rest}`

const OWNER = 'owner-1'
const agent = contact({ id: 'agent-1', type: 'agent', display_name: '写周报', owner_user_id: OWNER, avatar: look('lagoon', 'surprised'), gugu_number: 7 })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
})

async function open(options: { owner?: string } = {}) {
  const setAgentLook = vi.fn<ContactsContextValue['setAgentLook']>(async () => {})
  const toast = vi.fn<ToastContextValue['toast']>()
  await renderWithAppProviders(harness, createNode(AgentLookPane, { agent }), {
    auth: { id: options.owner ?? OWNER },
    contacts: { contacts: [agent], setAgentLook },
    toast,
  })
  return { setAgentLook, toast }
}

const q = <T extends Element = HTMLElement>(sel: string) => harness.container.querySelector<T>(sel)
const qa = (sel: string) => Array.from(harness.container.querySelectorAll<HTMLElement>(sel))
const checkedColor = () => q('[data-color][aria-checked="true"]')?.getAttribute('data-color')

describe('形象工坊', () => {
  it('the assistant workshop retains the saved look and all colors without agent sibling markers', async () => {
    await open()
    expect(qa('[role="radio"][data-color]')).toHaveLength(BODY_COLORS.length)
    expect(checkedColor()).toBe('lagoon')
    const taken = qa('[data-color]').filter((el) => el.querySelector('.gg-look-taken')).map((el) => el.getAttribute('data-color'))
    expect(taken).toEqual([])
    // 舞台上就是这只、这个样子
    const stage = q('canvas[data-agent-avatar]')
    expect(stage?.getAttribute('data-agent-avatar-color')).toBe('lagoon')
    expect(stage?.getAttribute('data-agent-avatar-rest')).toBe('surprised')
  })

  it('点一颗色球:舞台当场换色、标「未保存」;「就它了」才写库,写的是选中的颜色 + 原来的表情', async () => {
    const { setAgentLook, toast } = await open()
    expect(q('.gg-look-tag--draft')).toBeNull()
    await clickElement(q('[data-color="haze"]')!)
    expect(checkedColor()).toBe('haze')
    expect(q('canvas[data-agent-avatar]')?.getAttribute('data-agent-avatar-color')).toBe('haze')
    expect(q('.gg-look-tag--draft')).not.toBeNull()
    expect(setAgentLook).not.toHaveBeenCalled()

    await clickElement(q('.gg-look-save')!)
    expect(setAgentLook).toHaveBeenCalledTimes(1)
    expect(setAgentLook).toHaveBeenCalledWith('agent-1', { color: BODY_COLORS.findIndex((c) => c.en === 'Haze'), rest: 'surprised' })
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('表情页:日常 6 种 + 个性 10 种,点哪张舞台上就换哪张脸', async () => {
    await open()
    await clickElement(qa('[role="tab"]')[1])
    expect(qa('[data-face]')).toHaveLength(16)
    expect(qa('.gg-look-face-group')[0].querySelectorAll('[data-face]')).toHaveLength(REST_FACES.length)
    await clickElement(q('[data-face="laughing"]')!)
    expect(q('[data-face="laughing"]')?.getAttribute('aria-checked')).toBe('true')
    expect(q('canvas[data-agent-avatar]')?.getAttribute('data-agent-avatar-rest')).toBe('laughing')
  })

  it('assistant dice changes the look without writing until saved', async () => {
    vi.useFakeTimers()
    const { setAgentLook } = await open()
    let prev = checkedColor()
    for (let i = 0; i < 20; i++) {
      await clickElement(q('.gg-look-dice')!)
      expect(q('.gg-look-dice')?.getAttribute('data-rolling')).toBe('true')
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      const now = checkedColor()
      expect(BODY_COLORS.map((_, i) => colorSlug(i))).toContain(now)
      expect(now).not.toBe(prev)
      prev = now
    }
    expect(setAgentLook).not.toHaveBeenCalled()
  })

  it('撤销:回到存着的样子', async () => {
    await open()
    await clickElement(q('[data-color="cream"]')!)
    const undo = qa('.gg-look-foot button').find((b) => !b.classList.contains('gg-look-dice') && !b.classList.contains('gg-look-save'))!
    await clickElement(undo)
    expect(checkedColor()).toBe('lagoon')
    expect(q('.gg-look-tag--draft')).toBeNull()
  })

  it('不是主人:只能看 —— 色球不可点、没有骰子和保存', async () => {
    const { setAgentLook } = await open({ owner: 'someone-else' })
    expect(q('.gg-look-foot')).toBeNull()
    const ball = q('[data-color="cream"]')!
    expect(ball.hasAttribute('disabled') || ball.getAttribute('aria-disabled') === 'true' || ball.hasAttribute('data-disabled')).toBe(true)
    await clickElement(ball)
    expect(checkedColor()).toBe('lagoon')
    expect(setAgentLook).not.toHaveBeenCalled()
  })

  it('[对照] 形象地址确实写成了这只 agent 的颜色 + 表情', () => {
    expect(parseAgentLook(agent.avatar)).toEqual({ color: BODY_COLORS.findIndex((c) => colorSlug(BODY_COLORS.indexOf(c)) === 'lagoon'), rest: 'surprised' })
  })

  describe('装扮页签(DIY)', () => {
    const stageWear = () => q('canvas[data-agent-avatar]')?.getAttribute('data-agent-avatar-wear') ?? ''
    const openOutfits = async () => {
      const r = await open()
      await clickElement(qa('[role="tab"]')[2])
      return r
    }

    it('没存过装扮:穿的是按编号推导的默认装扮,页签上写明;一个位置一排,每排都有「不戴」', async () => {
      await openOutfits()
      expect(stageWear()).not.toBe('')
      expect(q('.gg-look-outfit-note')?.textContent).not.toBe('')
      expect(qa('.gg-look-outfit-group').length).toBe(8)
      for (const g of qa('.gg-look-outfit-group')) expect(g.querySelector('[data-outfit=""]')).not.toBeNull()
    })

    it('穿一件、换配色、和它打架的自动摘掉并说一声;「就它了」写进去的是这一身', async () => {
      const { setAgentLook } = await openOutfits()
      // 先把默认那一身每个位置都摘干净,从空的开始搭
      for (const g of qa('.gg-look-outfit-group')) await clickElement(g.querySelector<HTMLElement>('[data-outfit=""]')!)
      expect(stageWear()).toBe('')
      await clickElement(q('[data-outfit="crown"]')!)
      expect(stageWear()).toBe('crown.0')
      await clickElement(q('[data-colorway="2"]')!)
      expect(stageWear()).toBe('crown.2')
      await clickElement(q('[data-outfit="glasses"]')!)
      expect(stageWear()).toBe('crown.2,glasses.0')
      await clickElement(q('[data-outfit="headphones"]')!) // 耳机和所有帽子打架
      expect(stageWear()).toBe('glasses.0,headphones.0')
      expect(q('.gg-look-outfit-note')?.textContent).toMatch(/摘下了|took off/)
      expect(q('.gg-look-tag--draft')).not.toBeNull()
      await clickElement(q('.gg-look-save')!)
      expect(setAgentLook).toHaveBeenCalledWith('agent-1', { color: BODY_COLORS.findIndex((c) => c.en === 'Lagoon'), rest: 'surprised', wear: [{ id: 'glasses', cw: 0 }, { id: 'headphones', cw: 0 }] })
    })

    it('「全部摘掉」= 明确不戴(存成 wear=);「恢复默认」= 去掉 wear、回到推导的那一身', async () => {
      const { setAgentLook } = await openOutfits()
      const derived = stageWear()
      const clear = qa('.gg-look-outfit-actions button')[0]
      await clickElement(clear)
      expect(stageWear()).toBe('')
      await clickElement(q('.gg-look-save')!)
      expect(setAgentLook).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ wear: [] }))
      await clickElement(qa('.gg-look-outfit-actions button')[1])
      expect(stageWear()).toBe(derived)
    })

    it('装扮页签里的骰子只换装扮:颜色、表情不动', async () => {
      await openOutfits()
      const before = q('canvas[data-agent-avatar]')!
      const color = before.getAttribute('data-agent-avatar-color')
      const rest = before.getAttribute('data-agent-avatar-rest')
      const seen = new Set<string>()
      for (let i = 0; i < 8; i++) {
        await clickElement(q('.gg-look-dice')!)
        const c = q('canvas[data-agent-avatar]')!
        expect(c.getAttribute('data-agent-avatar-color')).toBe(color)
        expect(c.getAttribute('data-agent-avatar-rest')).toBe(rest)
        seen.add(stageWear())
      }
      expect(seen.size).toBeGreaterThan(1)
    })
  })
})
