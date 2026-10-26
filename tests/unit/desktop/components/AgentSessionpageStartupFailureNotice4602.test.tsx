// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { presentationOfDisplayStatus } from '../../../support/agentDisplayStatusTestDouble'
import {
  SESSIONPAGE_SESSION_STARTUP_FAILURE_BRIDGE_KEY,
  type SessionpageSessionStartupFailure,
  type SessionpageSessionStartupFailureBridge,
} from '../../../../apps/desktop/src/lib/sessionpageSessionStartupFailureBridge'
// #4602 —— 会话页会话 hydrate 以具名错误停住时,当前 DM 必须把它作为会话事实显形:根因原文 + 真重试。
// 这里判的是聊天面的接线(账本 → 通知槽);失败本身怎么产生、桥怎么装,各在自己的单测里。
const projection = vi.hoisted(() => ({
  sessionId: 'task-conversation-1' as string | null,
  // 宿主按 provider-blocker 那张表写好的状态(presence 表给的展示态,本机那一条带着阻塞)。
  status: 'idle' as 'idle' | 'needs_user' | 'error',
  providerBlocker: null as { kind: 'provider'; reason: 'workspace-trust' | 'auth' | 'account' | 'config'; message: string } | null,
  platformRecovery: null as { status: 'live' | 'expired' | 'reopening' | 'failed'; error?: string } | null,
}))
vi.mock('../../../../apps/desktop/src/hooks/useSessionpageAgentProjection', () => ({
  useSessionpageAgentProjection: () => (projection.sessionId
    ? {
        kind: 'mapped',
        error: null,
        agentUserId: 'agent-1',
        context: {
          projectId: 'project-1', sessionId: projection.sessionId,
          platformRecovery: projection.platformRecovery, projectionError: null,
        },
      }
    : { kind: 'unmapped', error: null, context: null, agentUserId: 'agent-1' }),
}))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))
import { useAgentSessionpagePresentation } from '../../../../apps/desktop/src/components/chat/AgentSessionpagePresentation'
import { sessionStartupFailureBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-startup-failures'
import { translateSessionMessage } from '../../../../apps/desktop/src/session/renderer/localization/locale-store'
const GUGU_SIDE = () => translateSessionMessage('guguCatalog.reason.service-unavailable')
// 主进程按层打好码之后,IPC 交到任务 renderer 的原文长这样(spawn-failure `startupFailureForUser`)。
const ipc = (code: string) => `Error invoking remote method 'sessions.hydrateSession': Error: ${code}`
const chat = {
  id: 'chat-agent', kind: 'ai', status: 'active', name: '', peer_user_id: 'agent-1', created_at: '',
  last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null,
  last_read_seq: 0, next_message_seq: 1,
} satisfies ChatItem
const openInSessions = vi.fn(async () => {})
function fakeBridge(rows: readonly SessionpageSessionStartupFailure[]) {
  const listeners = new Set<() => void>()
  let current = rows
  const bridge: SessionpageSessionStartupFailureBridge & { retried: string[]; publish(next: readonly SessionpageSessionStartupFailure[]): void } = {
    retried: [],
    snapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    retry: (sessionId) => { bridge.retried.push(sessionId); return current.some((r) => r.sessionId === sessionId) },
    // 真的那一个(#7103 评审 M8:假替身按旧规则说话,把产品的分叉盖住了)。
    describe: sessionStartupFailureBridge.describe,
    publish: (next) => { current = next; for (const l of listeners) l() },
  }
  return bridge
}
function install(bridge: SessionpageSessionStartupFailureBridge | undefined) {
  const w = window as unknown as Record<string, unknown>
  if (bridge) w[SESSIONPAGE_SESSION_STARTUP_FAILURE_BRIDGE_KEY] = bridge
  else delete w[SESSIONPAGE_SESSION_STARTUP_FAILURE_BRIDGE_KEY]
}
function Probe() {
  const { sessionpageNotices, status, failureExplained } = useAgentSessionpagePresentation(
    chat,
    { display_name: 'cline 1', avatar: null },
    {
      status: projection.status,
      presentation: presentationOfDisplayStatus(projection.status),
      runningActivity: null,
      local: projection.sessionId
        ? {
            sessionId: projection.sessionId,
            reading: null,
            unseen: false,
            reviewGate: null,
            providerBlocker: projection.providerBlocker,
            statusSourceFault: null,
          }
        : null,
    },
    false,
    openInSessions,
    undefined,
  )
  return <div data-testid="agent-taskpage-probe" data-status={status ?? 'null'} data-failure-explained={String(failureExplained)}>{sessionpageNotices}</div>
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  projection.sessionId = 'task-conversation-1'
  projection.providerBlocker = null
  projection.status = 'idle'
  projection.platformRecovery = null
  openInSessions.mockClear()
  install(undefined)
})
afterEach(() => {
  harness.cleanup()
  install(undefined)
})
describe('#4602 会话启动失败在当前 DM 显形', () => {
  // 咕咕自己的运行时超时(推理进程的 `request timed out: POST /session`):主进程按层打成 service-unavailable,
  // 横幅说「咕咕这边出错了」—— 主进程那一半在 spawn-failure.test「startupFailureForUser」。
  it('咕咕自己的运行时超时:通知槽说任务页同一句「咕咕这边出错了」(❌ 原文)并给重试;按重试真的打到桥上', async () => {
    const bridge = fakeBridge([
      { sessionId: 'task-conversation-1', message: ipc('gugu-models:service-unavailable'), retrying: false, runtimeUpgrade: null },
    ])
    install(bridge)
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')
    expect(notice, '失败条必须渲染出来').not.toBeNull()
    expect(notice!.getAttribute('role')).toBe('alert')
    // #7103 与任务页内容区同一句;原文只进日志。
    expect(notice!.textContent).toContain(GUGU_SIDE())
    expect(notice!.textContent).not.toContain('gugu-models')
    // 横幅在说这次失败:同槽位的「本次回复出错」不再说一遍(#7103)。
    expect(harness.container.querySelector('[data-testid="agent-taskpage-probe"]')?.getAttribute('data-failure-explained')).toBe('true')
    const retry = notice!.querySelector<HTMLButtonElement>('[data-testid="agent-sessionpage-startup-failure-retry"]')
    expect(retry, '要有重试出口').not.toBeNull()
    await act(async () => { retry!.click() })
    expect(bridge.retried).toEqual(['task-conversation-1'])
  })
  // #4657 咕咕以外的(harness 自己起不来,主进程不打码):递它的原话一行,去掉本机路径。
  it('harness 自己说的照原话一行(去掉路径),给重试', async () => {
    install(fakeBridge([
      { sessionId: 'task-conversation-1', message: ipc('claude not installed: /Users/someone/.local/bin/claude was not found\n    at resolve'), retrying: false, runtimeUpgrade: null },
    ]))
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')
    expect(notice!.textContent).toContain('claude not installed: [path] was not found')
    expect(notice!.textContent).not.toContain('/Users/someone')
    expect(notice!.textContent).not.toContain('at resolve')
    expect(notice!.querySelector('[data-testid="agent-sessionpage-startup-failure-retry"]')).not.toBeNull()
  })
  // 登录失效:在别处登好了回来再起一次,横幅给重试(人点的重试先清掉取票退避)。
  it('登录失效说原因表那一句,给重试', async () => {
    install(fakeBridge([
      { sessionId: 'task-conversation-1', message: ipc('gugu-models:signed-out'), retrying: false, runtimeUpgrade: null },
    ]))
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')
    expect(notice!.textContent).toContain(translateSessionMessage('guguCatalog.reason.signed-out'))
    expect(notice!.querySelector('[data-testid="agent-sessionpage-startup-failure-retry"]')).not.toBeNull()
  })
  it('重试改变不了的(要会员):不给重试,给「打开任务」—— 去路在任务页上', async () => {
    const bridge = fakeBridge([
      { sessionId: 'task-conversation-1', message: ipc('gugu-models:membership-required'), retrying: false, runtimeUpgrade: null },
    ])
    install(bridge)
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')
    expect(notice!.textContent).toContain(translateSessionMessage('guguCatalog.reason.membership-required'))
    expect(notice!.textContent).not.toContain('gugu-models:')
    expect(notice!.querySelector('[data-testid="agent-sessionpage-startup-failure-retry"]')).toBeNull()
    const open = notice!.querySelector<HTMLButtonElement>('[data-testid="agent-sessionpage-startup-failure-open"]')
    expect(open).not.toBeNull()
    await act(async () => { open!.click() })
    expect(openInSessions).toHaveBeenCalledOnce()
    expect(bridge.retried).toEqual([])
  })
  it('[阴性对照] 账本里没有这条会话(或失败已清)时不渲染失败条', async () => {
    const bridge = fakeBridge([
      { sessionId: 'someone-else', message: 'boom', retrying: false, runtimeUpgrade: null },
    ])
    install(bridge)
    await harness.render(createNode(Probe, {}))
    expect(harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-taskpage-probe"]')?.getAttribute('data-failure-explained')).toBe('false')
    // 写进来 → 出现;清掉 → 消失:提示跟着账本走。
    await act(async () => {
      bridge.publish([{ sessionId: 'task-conversation-1', message: 'boom', retrying: false, runtimeUpgrade: null }])
    })
    expect(harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')).not.toBeNull()
    await act(async () => { bridge.publish([]) })
    expect(harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')).toBeNull()
  })
  it('重试飞行中:失败条留着、按钮禁用并写「重试中」—— ❌ 不把这一段显示成「没事了」', async () => {
    const bridge = fakeBridge([
      { sessionId: 'task-conversation-1', message: ipc('gugu-models:service-unavailable'), retrying: true, runtimeUpgrade: null },
    ])
    install(bridge)
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-startup-failure"]')
    expect(notice).not.toBeNull()
    const retry = notice!.querySelector<HTMLButtonElement>('[data-testid="agent-sessionpage-startup-failure-retry"]')
    expect(retry?.disabled).toBe(true)
    expect(retry?.textContent).not.toBe('Retry')
    // 走设计系统的 Button(sm 档:<720px 自动 ≥44px 触控目标、自带按压态),❌ 不是手搓的 <button style>。
    expect(retry?.getAttribute('data-slot'), '动作按钮必须是 components/ui/Button').toBe('button')
    expect(retry?.getAttribute('data-size')).toBe('sm')
  })
  it('provider 原生阻塞在当前 DM 显形并提供在任务中打开入口', async () => {
    projection.providerBlocker = { kind: 'provider', reason: 'config', message: 'Connect a Provider' }
    projection.status = 'error'
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-provider-blocker"]')
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(notice?.textContent).toContain('Connect a Provider')
    const open = notice?.querySelector<HTMLButtonElement>('[data-testid="agent-sessionpage-provider-blocker-open"]')
    expect(open).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-taskpage-probe"]')?.getAttribute('data-status'))
      .toBe('error')
    await act(async () => { open!.click() })
    expect(openInSessions).toHaveBeenCalledOnce()
  })
  it('工作区信任这类「批一下就继续」的阻塞按宿主给的 needs_user 显示,聊天面不再二次归类成 error', async () => {
    projection.providerBlocker = { kind: 'provider', reason: 'workspace-trust', message: 'Accessing workspace' }
    projection.status = 'needs_user'
    await harness.render(createNode(Probe, {}))
    expect(harness.container.querySelector('[data-testid="agent-sessionpage-provider-blocker"]')?.textContent)
      .toContain('Accessing workspace')
    expect(harness.container.querySelector('[data-testid="agent-taskpage-probe"]')?.getAttribute('data-status'))
      .toBe('needs_user')
  })
  // Uncoded recovery failures retain their actual sanitized cause.
  it('平台恢复失败保留实际原因并给重试入口', async () => {
    projection.platformRecovery = { status: 'failed', error: 'gateway rejected replacement credential' }
    install(fakeBridge([]))
    const invoke = vi.fn(async () => ({ status: 'ready' }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, eventOn: () => () => {} }
    await harness.render(createNode(Probe, {}))
    const notice = harness.container.querySelector('[data-testid="agent-sessionpage-platform-recovery-failed"]')
    expect(notice?.textContent).toContain('gateway rejected replacement credential')
    const retry = notice?.querySelector<HTMLButtonElement>('[data-testid="agent-sessionpage-platform-recovery-retry"]')
    expect(retry).not.toBeNull()
    await act(async () => { retry!.click() })
    expect(invoke).toHaveBeenCalledWith('sessionpage:retry-platform-recovery', 'task-conversation-1')
  })
})
