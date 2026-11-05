// @vitest-environment jsdom
// #709 把任务卡那一面抽成 ComposerCardFrame / TaskCardHandedTo,示例项目也画这一面。群里真卡的样子一点不变:
// 下面每一种卡说了什么、带着哪些标记(data-* / title / role / aria-label),都对着抽之前的组件录下的样子;
// 类名、行内样式与图标路径不在里面 —— 改样式不该让它们跟着重录。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerCardView } from '../../../../apps/desktop/src/components/chat/ComposerCardView'
import type { ComposerCard, ScheduleCard, TaskCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { domFace } from '../../../support/domFace'

vi.mock('../../../../apps/desktop/src/components/chat/openTaskCardSession', () => ({ openTaskCardSession: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, getLocalDeviceSelfSnapshot: async () => ({ device_id: 'device-1' }) } }
})
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
const joins = vi.hoisted(() => ({ status: new Map<string, string>() }))
vi.mock('../../../../apps/desktop/src/lib/groupAgentJoinService', () => ({ listMyAgentJoinRequests: async () => new Map(joins.status) }))
let agentStatus: string | undefined
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({
  useAgentDisplayStatuses: (ids: string[]) => Object.fromEntries(ids.map((id) => [id, agentStatus])),
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); agentStatus = undefined; joins.status = new Map() })
afterEach(() => { harness.cleanup() })

const TASK: TaskCard = {
  v: 1, type: 'task', text: '用一句话介绍你自己', agentUserId: 'agent-1', agentName: 'Codex 1', agentType: 'codex',
  sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'This computer',
}
const chat = { subscribeAccountRevision: () => () => {} }

async function markup(card: Exclude<ComposerCard, { type: 'question' }>, props: { isMine?: boolean; isGroup?: boolean; memberProfiles?: Record<string, MemberProfileCardModel>; onOpenTopic?: () => void } = {}) {
  await renderWithAppProviders(harness, createNode(ComposerCardView, {
    card, isMine: props.isMine ?? true, isGroup: props.isGroup ?? true, chatId: 'chat-1', senderName: 'Ana', time: '21:06',
    memberProfiles: props.memberProfiles, onOpenTopic: props.onOpenTopic,
  }), { chat })
  await act(async () => { await Promise.resolve() })
  return domFace(harness.container)
}

const seated = { 'agent-1': { membership: 'member', ownerUserId: null } } as unknown as Record<string, MemberProfileCardModel>

describe('task card face is unchanged by the extraction (#709)', () => {
  it('my card on this computer, done', async () => {
    agentStatus = 'idle'
    expect(await markup(TASK, { memberProfiles: seated })).toMatchInlineSnapshot(`
      {
        "marks": [
          "button data-openable=true data-testid=composer-card data-card-type=task title=打开这个会话",
          "span data-agent-harness=codex role=img aria-label=Codex",
          "svg role=img",
          "div data-agent=",
          "svg role=img aria-label=Codex 1 data-agent-avatar-boring=agent-1",
          "svg role=img aria-label=空闲",
        ],
        "text": [
          "新任务",
          "21:06",
          "用一句话介绍你自己",
          "交给",
          "Codex 1",
        ],
      }
    `)
  })

  it('my card while its agent runs', async () => {
    agentStatus = 'working'
    expect(await markup(TASK, { memberProfiles: seated })).toMatchInlineSnapshot(`
      {
        "marks": [
          "button data-openable=true data-testid=composer-card data-card-type=task title=打开这个会话",
          "span data-agent-harness=codex role=img aria-label=Codex",
          "svg role=img",
          "div data-agent=",
          "svg role=img aria-label=Codex 1 data-agent-avatar-boring=agent-1",
          "span aria-label=运行中",
        ],
        "text": [
          "新任务",
          "21:06",
          "用一句话介绍你自己",
          "交给",
          "Codex 1",
          "⠈",
          "⠉",
          "⠋",
          "⠓",
          "⠒",
          "⠐",
          "⠐",
          "⠒",
          "⠖",
          "⠦",
          "⠤",
          "⠠",
          "⠠",
          "⠤",
          "⠦",
          "⠖",
          "⠒",
          "⠐",
          "⠐",
          "⠒",
          "⠓",
          "⠋",
          "⠉",
          "⠈",
        ],
      }
    `)
  })

  it('my card waiting for the group owner', async () => {
    joins.status.set('agent-1', 'pending')
    expect(await markup(TASK)).toMatchInlineSnapshot(`
      {
        "marks": [
          "button data-openable=true data-testid=composer-card data-card-type=task title=打开这个会话",
          "span data-agent-harness=codex role=img aria-label=Codex",
          "svg role=img",
          "div data-agent=",
          "svg role=img aria-label=Codex 1 data-agent-avatar-boring=agent-1",
        ],
        "text": [
          "新任务",
          "21:06",
          "用一句话介绍你自己",
          "交给",
          "Codex 1",
          "· 等群主同意它进群",
        ],
      }
    `)
  })

  it("a colleague's card", async () => {
    expect(await markup(TASK, { isMine: false })).toMatchInlineSnapshot(`
      {
        "marks": [
          "div data-testid=composer-card data-card-type=task",
          "span data-agent-harness=codex role=img aria-label=Codex",
          "svg role=img",
        ],
        "text": [
          "新任务",
          "21:06",
          "用一句话介绍你自己",
          "Ana 的任务 · 无法查看",
        ],
      }
    `)
  })

  it('a card that opens its topic on the phone', async () => {
    expect(await markup(TASK, { isMine: false, onOpenTopic: () => {} })).toMatchInlineSnapshot(`
      {
        "marks": [
          "button data-openable=true data-testid=composer-card data-card-type=task title=打开这个会话",
          "span data-agent-harness=codex role=img aria-label=Codex",
          "svg role=img",
        ],
        "text": [
          "新任务",
          "21:06",
          "用一句话介绍你自己",
          "Ana 的任务 · 无法查看",
        ],
      }
    `)
  })

  it('a card from before the agent type was kept', async () => {
    const { agentType: _dropped, ...old } = TASK
    expect(await markup(old as TaskCard, { memberProfiles: seated })).toMatchInlineSnapshot(`
      {
        "marks": [
          "button data-openable=true data-testid=composer-card data-card-type=task title=打开这个会话",
          "div data-agent=",
          "svg role=img aria-label=Codex 1 data-agent-avatar-boring=agent-1",
        ],
        "text": [
          "新任务",
          "21:06",
          "用一句话介绍你自己",
          "交给",
          "Codex 1",
        ],
      }
    `)
  })

  it('a scheduled card', async () => {
    const schedule: ScheduleCard = { v: 1, type: 'schedule', text: '每天早上看一眼 CI', automationId: 'auto-1', scheduleLabel: '每天 9:00', deviceId: 'device-1', machineLabel: 'This computer' }
    expect(await markup(schedule)).toMatchInlineSnapshot(`
      {
        "marks": [
          "div data-testid=composer-card data-card-type=schedule",
        ],
        "text": [
          "已安排 · 每天 9:00",
          "21:06",
          "每天早上看一眼 CI",
        ],
      }
    `)
  })
})
