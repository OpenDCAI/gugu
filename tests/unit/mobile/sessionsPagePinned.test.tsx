// @vitest-environment jsdom
import { frame } from '../../support/dialogExit'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device, DeviceSessionSummary } from '@gugu/core/shared/types/chat'
import type {
  SessionpageSessionsListResult,
  SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import { ProjectsPage } from '../../../apps/desktop/src/mobile/agent-watch/ProjectsPage'
import { publishPhoneAssistant } from '../../../apps/desktop/src/mobile/assistant/phoneAssistantIdentity'
import {
  retainDeviceSessions,
  updateDeviceSessions,
} from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { createReactHarness } from '../../support/testHarness'

const rpc = vi.hoisted(() => ({
  list: { projects: [], sessions: [] } as SessionpageSessionsListResult,
  updateSession: vi.fn(),
  cancelPhoneSessionTurn: vi.fn(),
}))
/** 设备 store 的读数(「项目」页自己读它,不再由路由交一台机器进来)。 */
const store = vi.hoisted(() => ({ devices: [] as Device[], phones: [] as Device[] }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: store.devices, phones: store.phones, loading: false, error: null }),
}))

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  listSessions: vi.fn(async () => rpc.list),
  subscribeSessionsList: vi.fn(async () => ({})),
  unsubscribeSessionsList: vi.fn(async () => ({})),
  subscribeSessionsListEvents: vi.fn(() => () => undefined),
  onLinkChange: vi.fn(() => () => undefined),
  deleteSession: vi.fn(),
  updateSession: rpc.updateSession,
  cancelPhoneSessionTurn: rpc.cancelPhoneSessionTurn,
}))
/** 通讯录里自己的 agent(显示名只有 identity.users 那一份,手机上就在这里)。 */
const contacts = vi.hoisted(() => ({ list: [{ id: 'agent-1', display_name: 'Codex 3' }, { id: 'agent-7', display_name: 'Claude 7' }] }))
vi.mock('../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: contacts.list }) }))
vi.mock('../../../apps/desktop/src/session/shared/remote-sessions/session-list-cache', () => ({
  readCachedSessionList: vi.fn(async () => null),
  writeCachedSessionList: vi.fn(),
}))

const summary = (
  sessionId: string,
  minute: number,
  extra: Partial<SessionpageSessionSummary> = {},
): SessionpageSessionSummary => ({
  conversationId: sessionId,
  projectId: 'p1',
  title: `title-${sessionId}`,
  harness: 'codex',
  runtime: 'acp',
  agentStatus: null,
  lastInteractedAt: `2026-09-27T10:${String(minute).padStart(2, '0')}:00.000Z`,
  supported: true,
  ...extra,
})

const device = (overrides: Partial<Device> = {}): Device => ({
  device_id: 'device-1',
  label: 'Mac',
  hostname: 'mac',
  platform: 'darwin',
  status: 'online',
  last_seen_at: '2026-09-27T10:00:00.000Z',
  is_online: true,
  capabilities: { terminals: [], runtimes: [] },
  ...overrides,
})

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  localStorage.clear()
  rpc.updateSession.mockReset()
  rpc.cancelPhoneSessionTurn.mockReset().mockResolvedValue({ cancelled: true })
  store.devices = []
  store.phones = []
})
afterEach(() => {
  harness.cleanup()
  retainDeviceSessions([])
  publishPhoneAssistant(null)
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations
})

const pinnedSection = () => harness.container.querySelector('[data-testid="agent-watch-pinned-section"]')
const projectSection = () => harness.container.querySelector('[data-testid="agent-watch-session-group"]')
const row = (root: Element | null, id: string) => root?.querySelector(`[data-session-id="${id}"]`) ?? null
const scrollMemo = () => ({ current: 0 })
const noop = () => undefined

/** 把「项目」页挂在这些机器上(设备 store 的读数 + 目录那一格由壳根的同步写,各测自己写)。 */
async function renderPage(devices: Device[], props: Partial<React.ComponentProps<typeof ProjectsPage>> = {}) {
  store.devices = devices
  await harness.render(<ProjectsPage onOpenSession={noop} scrollMemo={scrollMemo()} {...props} />)
  await flush()
}

/** 目录那一格由壳根的同步写(这里替它写,也替机器推列表)。 */
function online(deviceId: string, sessions: SessionpageSessionSummary[]) {
  updateDeviceSessions(deviceId, {
    projects: [{ id: 'p1', name: 'Repo', path: '/repo' }],
    sessions,
    cached: false,
    loading: false,
    error: null,
  })
}

async function renderOnline(sessions: SessionpageSessionSummary[]) {
  rpc.list = { projects: [{ id: 'p1', name: 'Repo', path: '/repo' }], sessions }
  online('device-1', sessions)
  await renderPage([device()])
}

describe('ProjectsPage — 置顶分区与父子树(对齐桌面侧栏)', () => {
  it('置顶的会话在顶部「置顶」分区,不在项目分区', async () => {
    await renderOnline([summary('pinned', 1, { isPinned: true }), summary('plain', 2)])
    expect(row(pinnedSection(), 'pinned')).not.toBeNull()
    expect(row(projectSection(), 'pinned')).toBeNull()
    expect(row(projectSection(), 'plain')).not.toBeNull()
  })

  it('#6726 行的第二行带这条会话背后的 agent 名(行上只有 id,名字按 id 对上通讯录);还没有身份的行不编一个', async () => {
    await renderOnline([summary('named', 1, { agent: { userId: 'agent-1' } }), summary('bare', 2, { agent: null })])
    expect(row(projectSection(), 'named')?.querySelector('.gg-aw-item-meta')?.textContent).toContain('Codex 3')
    expect(row(projectSection(), 'bare')?.querySelector('.gg-aw-item-meta')?.textContent).not.toContain('Codex 3')
  })

  it('owner 10-09 第二行只留 agent 名与时间:不写状态词(图标就是它)、有名字不写 harness、名字就是标题不重复', async () => {
    contacts.list = [...contacts.list, { id: 'agent-echo', display_name: 'title-echo' }]
    await renderOnline([
      summary('named', 1, { agentStatus: 'working', agent: { userId: 'agent-1' } }),
      summary('bare', 2, { agentStatus: 'working', agent: null }),
      summary('echo', 3, { agent: { userId: 'agent-echo' } }),
    ])
    const parts = (id: string) => [...(row(projectSection(), id)?.querySelectorAll('.gg-aw-item-part') ?? [])].map((el) => el.textContent)
    expect(parts('named')).toHaveLength(2)
    expect(parts('named')[0]).toBe('Codex 3')
    expect(parts('bare')).toHaveLength(2)
    expect(parts('bare')[0]).toBe('codex')
    expect(parts('echo')).toHaveLength(2)
    expect(parts('echo')).not.toContain('title-echo')
  })

  it('没有置顶的会话就没有「置顶」分区', async () => {
    await renderOnline([summary('plain', 2)])
    expect(pinnedSection()).toBeNull()
  })

  it('子会话默认展开、缩进一层;点父行的开关收起', async () => {
    await renderOnline([summary('parent', 1), summary('child', 2, { parentConversationId: 'parent' })])
    const child = row(projectSection(), 'child')
    expect(child?.closest('.gg-aw-item-wrap')?.getAttribute('data-depth')).toBe('1')
    const toggle = harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-watch-session-children-toggle"]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => toggle!.click())
    expect(row(projectSection(), 'child')).toBeNull()
    expect(row(projectSection(), 'parent')).not.toBeNull()
  })

  it('在手机上置顶,这一行当场移进「置顶」分区', async () => {
    await renderOnline([summary('target', 1), summary('other', 2)])
    // 宿主那一侧:置顶写进库、发 sessionChanged{isPinned},列表订阅随之推整份(service.ts changesSessionList)。
    rpc.updateSession.mockImplementation(async () => {
      online('device-1', rpc.list.sessions.map((s) => (s.conversationId === 'target' ? { ...s, isPinned: true } : s)))
      return { title: 'title-target', isPinned: true, archived: false }
    })
    const menu = row(projectSection(), 'target')!
      .closest('.gg-aw-item-wrap')!
      .querySelector<HTMLButtonElement>('[data-testid="agent-watch-session-menu"]')!
    await act(async () => menu.click())
    await frame()
    expect(document.querySelector('[role="menu"]'), 'owner 10-26:贴着 ⋯ 弹菜单,❌ 底部抽屉').not.toBeNull()
    await act(async () => document.querySelector<HTMLElement>('[data-testid="agent-watch-session-pin"]')!.click())
    expect(document.querySelector('[data-testid="agent-watch-session-pin"]'), '点了就收').toBeNull()
    await flush()
    expect(rpc.updateSession).toHaveBeenCalledWith('device-1', { conversationId: 'target', pinned: true })
    expect(row(pinnedSection(), 'target')).not.toBeNull()
    expect(row(projectSection(), 'target')).toBeNull()
  })

  it('机器离线读心跳摘要:带 isPinned 的进「置顶」分区,老宿主不带这个键就不画置顶', async () => {
    const digest = (extra: Partial<DeviceSessionSummary>): DeviceSessionSummary[] => [{
      conversationId: 'offline-1',
      projectId: 'p1',
      projectName: 'Repo',
      title: 'offline',
      harness: 'codex',
      agentStatus: null,
      lastInteractedAt: '2026-09-27T10:00:00.000Z',
      supported: true,
      ...extra,
    }]
    const offline = (session_digest: DeviceSessionSummary[]) =>
      device({ is_online: false, status: 'offline', session_digest })

    const pinnedDevice = offline(digest({ isPinned: true }))
    await renderPage([pinnedDevice])
    expect(row(pinnedSection(), 'offline-1')).not.toBeNull()

    const plainDevice = offline(digest({}))
    await renderPage([plainDevice])
    expect(pinnedSection()).toBeNull()
    expect(row(projectSection(), 'offline-1')).not.toBeNull()
  })

  // owner 2026-10-09:进 Chole 看得到 125,看不到它下面在 ThinkPad 上的子会话。
  it('跨机器:别的机器上的子会话挂在父会话下,行上带那台机器的名字、带它自己的 agent 名;点开交出它所在的机器', async () => {
    const chole = device({ device_id: 'chole', label: 'Chole' })
    const thinkpad = device({ device_id: 'thinkpad', label: 'ThinkPad' })
    online('chole', [summary('125', 1)])
    online('thinkpad', [summary('lane', 2, { parentConversationId: '125', agent: { userId: 'agent-7' } })])
    const opened: Array<[string, string]> = []
    await renderPage([chole, thinkpad], { onOpenSession: (deviceId, s) => { opened.push([deviceId, s.conversationId]) } })
    const child = row(projectSection(), 'lane')
    expect(child?.closest('.gg-aw-item-wrap')?.getAttribute('data-depth')).toBe('1')
    expect(child?.querySelector('.gg-aw-item-meta')?.textContent).toContain('ThinkPad')
    expect(child?.querySelector('.gg-aw-item-meta')?.textContent).toContain('Claude 7')
    await act(async () => (child as HTMLButtonElement).click())
    expect(opened).toEqual([['thinkpad', 'lane']])

    // 阴控:ThinkPad 自己的分区(它上面有自己的项目)不再把它当散的根 —— 整页只有这一行。
    expect(harness.container.querySelectorAll('[data-session-id="lane"]')).toHaveLength(1)
  })

  it('跨机器:子会话那台机器离线 —— 读它的心跳摘要,行在、打不开;父会话照常打得开', async () => {
    const chole = device({ device_id: 'chole', label: 'Chole' })
    const thinkpad = device({
      device_id: 'thinkpad',
      label: 'ThinkPad',
      is_online: false,
      status: 'offline',
      session_digest: [{
        conversationId: 'lane',
        projectId: 't',
        projectName: 'T',
        title: 'lane',
        harness: 'claude',
        agentStatus: null,
        lastInteractedAt: '2026-09-27T10:02:00.000Z',
        supported: true,
        parentConversationId: '125',
      }],
    })
    online('chole', [summary('125', 1)])
    await renderPage([chole, thinkpad])
    expect((row(projectSection(), 'lane') as HTMLButtonElement | null)?.disabled).toBe(true)
    expect(row(projectSection(), 'lane')?.closest('.gg-aw-item-wrap')?.querySelector('[data-testid="agent-watch-session-menu"]')).toBeNull()
    expect((row(projectSection(), '125') as HTMLButtonElement | null)?.disabled).toBe(false)
  })
})

// #7199 owner 10-16:手机底栏「项目」= 所有机器上的项目一页;机器是分区页头上的属性;个人助理派的会话是一组。
describe('ProjectsPage — 所有机器一页、个人助理一组', () => {
  const ASSISTANT = 'assistant-agent'
  const repo = { id: 'p1', name: 'Repo', path: '/repo' }
  const mac = device({ device_id: 'mac', label: 'Mac' })
  const thinkpad = device({ device_id: 'thinkpad', label: 'ThinkPad' })
  const home = device({ device_id: 'home', label: '云电脑', capabilities: { terminals: [], runtimes: [], assistant_home: true } })

  const write = (deviceId: string, sessions: SessionpageSessionSummary[], projects = [repo]) =>
    updateDeviceSessions(deviceId, { projects, sessions, cached: false, loading: false, error: null })
  const groups = () => [...harness.container.querySelectorAll('[data-testid="agent-watch-session-group"]')]
  const heading = (el: Element) => el.querySelector('[data-testid="agent-watch-session-group-toggle"]')?.textContent
  const metaOf = (id: string) => harness.container.querySelector(`[data-session-id="${id}"]`)?.querySelector('.gg-aw-item-meta')?.textContent ?? ''

  it('手机与电脑会话都打开任务时间线，手机不需要私聊绑定', async () => {
    const phone = device({ device_id: 'phone', label: 'Android', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: [{ id: 'pi', available: true }] } as unknown as Device['capabilities'] })
    write('mac', [summary('desktop-task', 1)])
    write('phone', [summary('phone-task', 2, { harness: 'pi', agentStatus: 'working', supported: true, agent: { userId: 'phone-agent' } })])
    const onOpenSession = vi.fn()
    await renderPage([phone, mac], { onOpenSession })
    expect(harness.container.querySelector('[data-testid="agent-watch-sessions-error"]')).toBeNull()
    const phoneRow = harness.container.querySelector<HTMLButtonElement>('[data-session-id="phone-task"]')!
    expect(phoneRow.disabled).toBe(false)
    expect(phoneRow.dataset.supported).toBe('true')
    expect(metaOf('phone-task')).toMatch(/手机 Agent|Phone Agent/)
    expect(metaOf('phone-task').toLowerCase()).not.toContain('pi')
    expect(metaOf('desktop-task')).toContain('codex')
    expect(phoneRow.querySelector('[data-agent-avatar-boring]')?.getAttribute('aria-label')).toMatch(/运行中|Working/)
    await act(async () => phoneRow.click())
    expect(onOpenSession).toHaveBeenCalledWith('phone', expect.objectContaining({ conversationId: 'phone-task' }))
    expect(harness.container.querySelector('[data-session-id="desktop-task"]')).not.toBeNull()
  })

  it.each(['not-started', 'harness-unsupported'] as const)('手机 %s 状态仍隐藏引擎名,电脑上的 Pi 类型保留', async (recordState) => {
    const phone = device({ device_id: 'phone', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: ['pi'] } as Device['capabilities'] })
    write('phone', [summary('phone-task', 2, { harness: 'pi', supported: false, recordState })])
    write('mac', [summary('desktop-pi', 1, { harness: 'pi', supported: true })])
    await renderPage([phone, mac])
    expect(metaOf('phone-task')).toMatch(/手机 Agent|Phone Agent/)
    expect(metaOf('phone-task').toLowerCase()).not.toContain('pi')
    expect([...harness.container.querySelectorAll('[data-session-id="desktop-pi"] .gg-aw-item-part')].map((part) => part.textContent)).toContain('pi')
  })

  it('账号只有手机宿主时，空态不谎报账号没有机器', async () => {
    const phone = device({ device_id: 'phone', label: 'Android', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: [{ id: 'pi', available: true }] } as unknown as Device['capabilities'] })
    write('phone', [])
    await renderPage([phone])
    const hint = harness.container.querySelector('[data-testid="agent-watch-projects-empty"]')?.lastElementChild?.textContent
    expect(hint).toBeTruthy()
    expect(hint).not.toMatch(/还没有机器|no machines/i)
    expect(harness.container.querySelector('[data-testid="agent-watch-sessions-error"]')).toBeNull()
  })

  it('停止后的手机会话仍能打开历史任务页，旧摘要不能显示还在运行', async () => {
    const stoppedPhone = device({ device_id: 'phone', label: 'Android', is_online: false, status: 'offline', capabilities: { host_kind: 'phone', host_runtime_capability: 0, terminals: [], runtimes: [] } as Device['capabilities'] })
    write('phone', [summary('phone-task', 2, { harness: 'pi', agentStatus: 'working', supported: true, agent: { userId: 'phone-agent' } })])
    store.phones = [stoppedPhone]
    const onOpenSession = vi.fn()
    await renderPage([], { onOpenSession })
    const phoneRow = harness.container.querySelector<HTMLButtonElement>('[data-session-id="phone-task"]')!
    expect(phoneRow.disabled).toBe(false)
    expect(phoneRow.querySelector('[data-agent-avatar-boring]')?.getAttribute('aria-label')).not.toMatch(/运行中|Working/)
    expect(phoneRow.closest('.gg-aw-item-wrap')?.querySelector('[data-testid="agent-watch-session-menu"]')).toBeNull()
    await act(async () => phoneRow.click())
    expect(onOpenSession).toHaveBeenCalledWith('phone', expect.objectContaining({ conversationId: 'phone-task' }))
  })

  it('旧手机摘要既不支持也不带记录状态时不能假开时间线', async () => {
    const phone = device({ device_id: 'phone', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: ['pi'] } as Device['capabilities'] })
    write('phone', [summary('phone-task', 2, { supported: false, agent: { userId: 'phone-agent' } })])
    const onOpenSession = vi.fn()
    await renderPage([phone], { onOpenSession })
    const phoneRow = harness.container.querySelector<HTMLButtonElement>('[data-session-id="phone-task"]')!
    expect(phoneRow.disabled).toBe(true)
    await act(async () => phoneRow.click())
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it('手机行菜单只提供真实可用的停止任务,不暴露未实现的置顶/改名/归档', async () => {
    const phone = device({ device_id: 'phone', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: ['pi'] } as Device['capabilities'] })
    write('phone', [summary('phone-task', 2, { agentStatus: 'working', supported: false, chatId: 'phone-dm', agent: { userId: 'phone-agent' } })])
    await renderPage([phone])
    const menu = harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-watch-session-menu"]')!
    await act(async () => menu.click())
    expect(document.querySelector('[data-testid="agent-watch-session-pin"]')).toBeNull()
    expect(document.querySelector('[data-testid="agent-watch-session-rename"]')).toBeNull()
    expect(document.querySelector('[data-testid="agent-watch-session-archive"]')).toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="agent-watch-session-stop"]')!.click())
    expect(rpc.cancelPhoneSessionTurn).toHaveBeenCalledWith('phone', 'phone-task')
    expect(rpc.updateSession).not.toHaveBeenCalled()
  })

  it('只有本机项目时页头不追加设备型号', async () => {
    const phone = device({ device_id: 'phone', label: 'sdk_gphone64_arm64', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: ['pi'] } as Device['capabilities'] })
    write('phone', [summary('phone-task', 2)], [{ id: 'p1', name: '手机任务', path: '/phone' }])
    await renderPage([phone])
    expect(heading(groups()[0]!)).toBe('手机任务')
    expect(heading(groups()[0]!)).not.toContain('sdk_gphone64_arm64')
  })

  it('每台机器的每个项目一格,页头是「项目 · 机器」;两台机器上同名的项目各是一格', async () => {
    write('mac', [summary('m1', 1)])
    write('thinkpad', [summary('t1', 2)])
    await renderPage([mac, thinkpad])
    expect(groups().map(heading)).toEqual(['Repo · ThinkPad', 'Repo · Mac'])
    expect(row(groups()[0], 't1')).not.toBeNull()
    expect(row(groups()[1], 'm1')).not.toBeNull()
    // 阴控:没有会话的机器不画空分区。
    await act(async () => write('thinkpad', []))
    expect(groups().map(heading)).toEqual(['Repo · Mac'])
  })

  it('页头是「项目」、右上只有一颗 +,点它交给上层去选机器', async () => {
    write('mac', [summary('m1', 1)])
    const onCreate = vi.fn()
    await renderPage([mac], { onCreate })
    expect(['项目', 'Projects']).toContain(harness.container.querySelector('.gg-pane-title')?.textContent)
    const actions = harness.container.querySelectorAll('.gg-pane-actions button')
    expect(actions).toHaveLength(1)
    await act(async () => (actions[0] as HTMLButtonElement).click())
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('[data-testid="agent-watch-projects"] .gg-pane-header button')).toBe(actions[0])
  })

  it('个人助理派的会话收成一组(组名是它、每行标由它发起),不再列在项目下;它自己那条与它住的那台都不出现', async () => {
    write('home', [
      summary('assistant-own', 1, { projectId: 'hp', agent: { userId: ASSISTANT } }),
      summary('on-home', 2, { projectId: 'hp', parentConversationId: 'assistant-own' }),
      // 住在它那台上、却不是它派的:也归这一组(那台的项目名不对人露出)。
      summary('home-loose', 5, { projectId: 'hp' }),
    ], [{ id: 'hp', name: '云电脑项目', path: '/home' }])
    write('mac', [summary('dispatched', 3, { spawnedByConversationId: 'assistant-own' }), summary('mine', 4)])
    publishPhoneAssistant({ id: ASSISTANT, name: '小咕' })
    await renderPage([mac, home])
    expect(groups()).toHaveLength(2)
    // 分区按最近动静排,助理那一组与项目分区一起比:这里各找各的。
    const first = groups().find((g) => g.getAttribute('data-assistant') !== 'true')!
    const second = groups().find((g) => g.getAttribute('data-assistant') === 'true')!
    expect(heading(first)).toBe('Repo')
    expect(heading(second)).toBe('小咕')
    expect(row(first, 'mine')).not.toBeNull()
    expect(row(first, 'dispatched')).toBeNull()
    expect(row(second, 'dispatched')).not.toBeNull()
    expect(row(second, 'on-home')).not.toBeNull()
    expect(row(second, 'home-loose')).not.toBeNull()
    expect(harness.container.querySelector('[data-session-id="assistant-own"]')).toBeNull()
    expect(metaOf('dispatched')).toContain('小咕')
    expect(harness.container.textContent).not.toContain('云电脑')
    expect(groups()).toHaveLength(2)

    // 阴控:认不出它是谁(身份没读到)时,「派的」就认不出来 —— 那条回到自己的项目里。
    await act(async () => publishPhoneAssistant(null))
    expect(row(groups().find((g) => heading(g) === 'Repo') ?? null, 'dispatched')).not.toBeNull()
  })

  it('离线的机器:说明跟在它名下分区的页头后面(一行),别的分区没有;收起的分区不画', async () => {
    const offline = device({
      device_id: 'thinkpad',
      label: 'ThinkPad',
      is_online: false,
      status: 'offline',
      session_digest: [{
        conversationId: 'off-1', projectId: 'p1', projectName: 'Repo', title: 'off', harness: 'codex',
        agentStatus: null, lastInteractedAt: '2026-09-27T10:09:00.000Z', supported: true,
      }],
    })
    write('mac', [summary('m1', 1)])
    await renderPage([mac, offline])
    const [offlineGroup, macGroup] = groups()
    expect(heading(offlineGroup)).toBe('Repo · ThinkPad')
    expect(offlineGroup.querySelector('[data-testid="agent-watch-offline-why"]')).not.toBeNull()
    expect(macGroup.querySelector('[data-testid="agent-watch-offline-why"]')).toBeNull()
    // 页上只有分区里这一份,没有顶上一整块「机器离线」。
    expect(harness.container.querySelectorAll('[data-testid="agent-watch-offline-why"]')).toHaveLength(1)
    await act(async () => (offlineGroup.querySelector('[data-testid="agent-watch-session-group-toggle"]') as HTMLElement).click())
    expect(groups()[0].querySelector('[data-testid="agent-watch-offline-why"]')).toBeNull()
  })

  describe('在线却此刻读不到那台机器(它一时连不上):画它自己上报过的那份', () => {
    const unreachable = '此刻连不上「ThinkPad」。'
    const reported = device({
      device_id: 'thinkpad',
      label: 'ThinkPad',
      session_digest: [{
        conversationId: 'dig-1', projectId: 'p1', projectName: 'Repo', title: 'reported', harness: 'codex',
        agentStatus: null, lastInteractedAt: '2026-09-27T10:09:00.000Z', supported: true,
      }],
    })
    const note = (root: ParentNode) => root.querySelector('[data-testid="agent-watch-unreachable"]')
    const red = () => harness.container.querySelector('[data-testid="agent-watch-sessions-error"]')

    it('冷开、从没读到过:照摘要列出、点得开;分区下一行灰字说连不上,❌ 红框、❌「正在读取」', async () => {
      updateDeviceSessions('thinkpad', { loading: false, error: unreachable })
      await renderPage([reported])
      const dug = harness.container.querySelector<HTMLButtonElement>('[data-session-id="dig-1"]')
      expect(dug).not.toBeNull()
      expect(dug!.disabled).toBe(false)
      expect(red()).toBeNull()
      expect(note(groups()[0])?.textContent).toBe(unreachable)
      expect(harness.container.querySelector('[data-testid="agent-watch-projects-refreshing"]')).toBeNull()
    })

    it('读到过之后连不上(回前台重订失败):读到的那份留着,同样只有灰字', async () => {
      write('thinkpad', [summary('live-1', 1)])
      updateDeviceSessions('thinkpad', { loading: false, error: unreachable })
      await renderPage([reported])
      expect(row(groups()[0], 'live-1')).not.toBeNull()
      expect(red()).toBeNull()
      expect(note(groups()[0])?.textContent).toBe(unreachable)
    })

    it('阳控:一行都拿不出来(它也没报过摘要)才画红框', async () => {
      updateDeviceSessions('thinkpad', { loading: false, error: unreachable })
      await renderPage([device({ device_id: 'thinkpad', label: 'ThinkPad' })])
      expect(red()?.textContent).toContain(unreachable)
    })
  })

  it('云端宿主收回着:助理那一组 ❌ 说休息 / 叫醒(owner 10-17),它上面的会话照常列出', async () => {
    const asleep = device({
      device_id: 'home',
      label: '云电脑',
      is_online: false,
      status: 'offline',
      cloud_computer: 'asleep',
      session_digest: [{
        conversationId: 'h1', projectId: 'hp', projectName: '云电脑项目', title: 'h1', harness: 'codex',
        agentStatus: null, lastInteractedAt: '2026-09-27T10:09:00.000Z', supported: true,
      }],
    })
    write('mac', [summary('m1', 1)])
    publishPhoneAssistant({ id: ASSISTANT, name: '小咕' })
    await renderPage([mac, asleep])
    const group = groups().find((g) => g.getAttribute('data-assistant') === 'true')!
    expect(heading(group)).toBe('小咕')
    expect(harness.container.querySelector('[data-testid="agent-watch-cloud-computer-note"]')).toBeNull()
    expect(group.querySelector('[data-testid="agent-watch-offline-why"]')).toBeNull()
    expect(group.textContent).not.toMatch(/休息|叫醒/)
  })

  it('助理住的宿主真离线(不是收回着):照常说离线(阳控:上面那条不是因为整组没画出来)', async () => {
    const offlineHome = device({
      device_id: 'home',
      label: '云电脑',
      is_online: false,
      status: 'offline',
      capabilities: { terminals: [], runtimes: [], assistant_home: true },
      session_digest: [{
        conversationId: 'h1', projectId: 'hp', projectName: '云电脑项目', title: 'h1', harness: 'codex',
        agentStatus: null, lastInteractedAt: '2026-09-27T10:09:00.000Z', supported: true,
      }],
    })
    write('mac', [summary('m1', 1)])
    publishPhoneAssistant({ id: ASSISTANT, name: '小咕' })
    await renderPage([mac, offlineHome])
    const group = groups().find((g) => g.getAttribute('data-assistant') === 'true')!
    expect(group.querySelector('[data-testid="agent-watch-offline-why"]')).not.toBeNull()
  })

  it('一台机器都没有 / 机器上还没有会话:各说各的空态,不画空分区', async () => {
    await renderPage([])
    expect(harness.container.querySelector('[data-testid="agent-watch-projects-empty"]')).not.toBeNull()
    expect(groups()).toHaveLength(0)
    const noMachines = harness.container.querySelector('[data-testid="agent-watch-projects-empty"]')?.textContent
    await act(async () => write('mac', []))
    await renderPage([mac])
    const noSessions = harness.container.querySelector('[data-testid="agent-watch-projects-empty"]')?.textContent
    expect(noSessions).toBeTruthy()
    expect(noSessions).not.toBe(noMachines)
  })

  it('点名定位:收起的分区被展开、滚到那一行;没点名时收起照旧', async () => {
    localStorage.setItem('gugu.agent-watch.collapsed.projects', JSON.stringify(['device-1|p1']))
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      rpc.list = { projects: [repo], sessions: [summary('wanted', 1)] }
      online('device-1', rpc.list.sessions)
      await renderPage([device()])
      expect(row(harness.container, 'wanted'), '阳控:收起的分区不画行').toBeNull()
      await renderPage([device()], { reveal: { deviceId: 'device-1', sessionId: 'wanted' } })
      await flush()
      expect(row(harness.container, 'wanted')).not.toBeNull()
      expect(scrollIntoView).toHaveBeenCalled()
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(row(harness.container, 'wanted'))
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})
