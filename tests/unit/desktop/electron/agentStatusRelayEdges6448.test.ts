// spec status-event-log「翻译」(#6448)—— sidecar 终端腿(codex app-server、opencode / mimocode serve)从引擎自己的
// 事件流里读出的边,经宿主唯一的翻法 `relayTurnLifecycleEvent` 变成 AgentEvent,再走状态写入者同一条
// 翻译 + 日志 reduce。断言产品读得到的:基础态、附属态、「做完」那条边响没响。
import { describe, expect, it } from 'vitest'
import {
  codexThreadWaitEdges,
  codexTurnLifecycle,
  type CodexWaitFlag,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import {
  opencodeSessionErrorEdge,
  opencodeWaitEdge,
} from '../../../../apps/desktop/electron/sessionpage/opencode-serve-attach-transport'
import {
  edgeEndsTurn,
  relayTurnLifecycleEvent,
  type TurnLifecycleEdge,
} from '../../../../apps/desktop/electron/sessionpage/turn-lifecycle-relay'
import {
  emptyStatusLogState,
  readStatusLog,
  stepStatusLog,
} from '../../../../apps/desktop/electron/session/main/core/agent-status/status-event-log'
import { translateAgentEvent } from '../../../../apps/desktop/electron/session/main/core/agent-status/status-event-translator'

const THREAD = 'thr_main'
const target = { sessionId: 'c1', providerId: 'codex', projectId: 'p1' }

const completed = (status: unknown, threadId = THREAD) => ({
  method: 'turn/completed',
  params: { threadId, turn: { id: 'turn-1', status } },
})
const statusChanged = (status: unknown, threadId = THREAD) => ({
  method: 'thread/status/changed',
  params: { threadId, status },
})
const frame = (type: string, properties: Record<string, unknown>) => ({ type, properties })

/** 一串边 → 宿主翻成 AgentEvent → 翻译 → reduce;记下每步读数与「做完」边的次数。 */
function relay(edges: readonly TurnLifecycleEdge[], opts: { autoApproved?: boolean } = {}) {
  const state = emptyStatusLogState()
  const anomalies: string[] = []
  let doneEdges = 0
  const readings = edges.map((edge) => {
    const events = translateAgentEvent(relayTurnLifecycleEvent(edge, target, 1), {
      running: state.running,
      waiting: state.waits.size > 0,
      failed: state.error !== null,
      autoApproved: opts.autoApproved === true,
    })
    for (const event of events) stepStatusLog(state, event, (what) => anomalies.push(what))
    const reading = readStatusLog(state)
    if (events.length > 0 && reading.finished) doneEdges += 1
    return { status: reading.status, detail: reading.detail, running: reading.running }
  })
  return { readings, doneEdges, anomalies }
}

describe('codex app-server turn/completed (#6448)', () => {
  it('maps an interrupted turn to a cancelled stop, not a finished one', () => {
    expect(codexTurnLifecycle(completed('interrupted'), THREAD)).toEqual({ type: 'stop', outcome: 'cancelled' })
    expect(codexTurnLifecycle(completed('completed'), THREAD)).toEqual({ type: 'stop' })
    expect(codexTurnLifecycle(completed('failed'), THREAD)).toEqual({ type: 'error' })
  })

  it('refuses a completion status it does not know instead of calling it done', () => {
    expect(() => codexTurnLifecycle(completed('inProgress'), THREAD)).toThrow(/unknown turn status/)
    expect(() => codexTurnLifecycle(completed(undefined), THREAD)).toThrow(/unknown turn status/)
  })

  it('an Esc-interrupted turn goes idle without the done edge (no unread, no chime)', () => {
    const interrupted = codexTurnLifecycle(completed('interrupted'), THREAD)!
    const { readings, doneEdges } = relay([{ type: 'start' }, interrupted])
    expect(readings.at(-1)).toEqual({ status: 'idle', detail: 'plain', running: false })
    expect(doneEdges).toBe(0)
    // 对照:同样的起止、正常做完,那条边响一次。
    expect(relay([{ type: 'start' }, { type: 'stop' }]).doneEdges).toBe(1)
  })
})

describe('codex app-server thread/status/changed → wait edges (#6448)', () => {
  const none: ReadonlySet<CodexWaitFlag> = new Set()

  it('opens a wait per new active flag and closes it when the flag clears', () => {
    const asked = codexThreadWaitEdges(none, statusChanged({ type: 'active', activeFlags: ['waitingOnApproval'] }), THREAD)!
    expect(asked.edges).toEqual([{ type: 'wait', waitKind: 'approval', waitId: 'waitingOnApproval' }])

    const both = codexThreadWaitEdges(
      asked.flags,
      statusChanged({ type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] }),
      THREAD,
    )!
    expect(both.edges).toEqual([{ type: 'wait', waitKind: 'question', waitId: 'waitingOnUserInput' }])

    const answered = codexThreadWaitEdges(both.flags, statusChanged({ type: 'active', activeFlags: ['waitingOnUserInput'] }), THREAD)!
    expect(answered.edges).toEqual([{ type: 'wait_resolved', waitId: 'waitingOnApproval' }])

    const idle = codexThreadWaitEdges(answered.flags, statusChanged({ type: 'idle' }), THREAD)!
    expect(idle.edges).toEqual([{ type: 'wait_resolved', waitId: 'waitingOnUserInput' }])
    expect([...idle.flags]).toEqual([])
  })

  it('ignores other threads and other notifications', () => {
    expect(codexThreadWaitEdges(none, statusChanged({ type: 'active', activeFlags: ['waitingOnApproval'] }, 'thr_child'), THREAD)).toBeNull()
    expect(codexThreadWaitEdges(none, completed('completed'), THREAD)).toBeNull()
  })

  it('an unchanged snapshot says nothing new', () => {
    const flags = new Set<CodexWaitFlag>(['waitingOnApproval'])
    expect(codexThreadWaitEdges(flags, statusChanged({ type: 'active', activeFlags: ['waitingOnApproval'] }), THREAD)!.edges).toEqual([])
  })

  it('refuses a status it cannot read', () => {
    expect(() => codexThreadWaitEdges(none, statusChanged({ type: 'active', activeFlags: ['waitingOnSomething'] }), THREAD)).toThrow(/unknown active flag/)
    expect(() => codexThreadWaitEdges(none, statusChanged({ type: 'busy' }), THREAD)).toThrow(/unknown status type/)
    expect(() => codexThreadWaitEdges(none, statusChanged({ type: 'active' }), THREAD)).toThrow(/no activeFlags/)
    expect(() => codexThreadWaitEdges(none, statusChanged('active'), THREAD)).toThrow(/no status object/)
  })

  it('a turn waiting on approval reads needs_user/approval, then working again once answered', () => {
    let flags: ReadonlySet<CodexWaitFlag> = new Set()
    const edges: TurnLifecycleEdge[] = [{ type: 'start' }]
    for (const status of [
      { type: 'active', activeFlags: ['waitingOnApproval'] },
      { type: 'active', activeFlags: [] },
    ]) {
      const observed = codexThreadWaitEdges(flags, statusChanged(status), THREAD)!
      flags = observed.flags
      edges.push(...observed.edges)
    }
    const { readings, anomalies } = relay(edges)
    expect(readings[1]).toEqual({ status: 'needs_user', detail: 'approval', running: true })
    expect(readings[2]).toEqual({ status: 'working', detail: 'running', running: true })
    expect(anomalies).toEqual([])
  })

  it('a question is never swallowed by auto-approve; an approval is', () => {
    const question: TurnLifecycleEdge = { type: 'wait', waitKind: 'question', waitId: 'waitingOnUserInput' }
    const approval: TurnLifecycleEdge = { type: 'wait', waitKind: 'approval', waitId: 'waitingOnApproval' }
    expect(relay([{ type: 'start' }, question], { autoApproved: true }).readings.at(-1)).toMatchObject({ status: 'needs_user', detail: 'question' })
    expect(relay([{ type: 'start' }, approval], { autoApproved: true }).readings.at(-1)).toMatchObject({ status: 'working' })
  })
})

describe('opencode / mimocode serve permission and question frames (#6448)', () => {
  const session = { sessionID: 'ses_1' }

  it('maps permission.asked / permission.replied to an approval wait and its end', () => {
    expect(opencodeWaitEdge(frame('permission.asked', {
      ...session, id: 'per_1', permission: 'bash', patterns: ['rm *'], metadata: {}, always: [],
    }))).toEqual({ type: 'wait', waitKind: 'approval', waitId: 'per_1' })
    expect(opencodeWaitEdge(frame('permission.replied', { ...session, requestID: 'per_1', reply: 'once' })))
      .toEqual({ type: 'wait_resolved', waitId: 'per_1' })
  })

  it('maps question.asked / question.replied / question.rejected to a question wait and its end', () => {
    expect(opencodeWaitEdge(frame('question.asked', { ...session, id: 'que_1', questions: [] })))
      .toEqual({ type: 'wait', waitKind: 'question', waitId: 'que_1' })
    expect(opencodeWaitEdge(frame('question.replied', { ...session, requestID: 'que_1', answers: [['yes']] })))
      .toEqual({ type: 'wait_resolved', waitId: 'que_1' })
    expect(opencodeWaitEdge(frame('question.rejected', { ...session, requestID: 'que_1' })))
      .toEqual({ type: 'wait_resolved', waitId: 'que_1' })
  })

  it('refuses a frame whose pairing id is missing', () => {
    expect(() => opencodeWaitEdge(frame('permission.asked', { ...session, permission: 'bash' }))).toThrow(/properties\.id/)
    expect(() => opencodeWaitEdge(frame('question.replied', { ...session, id: 'que_1' }))).toThrow(/properties\.requestID/)
  })

  it('ignores every other frame', () => {
    expect(opencodeWaitEdge(frame('session.status', { ...session, status: { type: 'busy' } }))).toBeNull()
    expect(opencodeWaitEdge(frame('session.idle', session))).toBeNull()
  })

  it('a turn blocked on a question reads needs_user/question and resumes when it is answered', () => {
    const { readings, anomalies } = relay([
      { type: 'start' },
      opencodeWaitEdge(frame('question.asked', { ...session, id: 'que_1', questions: [] }))!,
      opencodeWaitEdge(frame('question.replied', { ...session, requestID: 'que_1', answers: [] }))!,
      { type: 'stop' },
    ])
    expect(readings[1]).toEqual({ status: 'needs_user', detail: 'question', running: true })
    expect(readings[2]).toEqual({ status: 'working', detail: 'running', running: true })
    expect(readings[3]).toEqual({ status: 'idle', detail: 'done', running: false })
    expect(anomalies).toEqual([])
  })

  it('maps a user abort to a cancelled stop and any other session.error to an error', () => {
    const abort = frame('session.error', { ...session, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } })
    const failed = frame('session.error', { ...session, error: { name: 'APIError', data: { message: 'backend 502' } } })
    expect(opencodeSessionErrorEdge(abort)).toEqual({ type: 'stop', outcome: 'cancelled' })
    expect(opencodeSessionErrorEdge(failed)).toEqual({ type: 'error' })
  })

  it('a user abort is not a finished turn', () => {
    const abort = frame('session.error', { ...session, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } })
    const { readings, doneEdges } = relay([{ type: 'start' }, opencodeSessionErrorEdge(abort)])
    expect(readings.at(-1)).toEqual({ status: 'idle', detail: 'plain', running: false })
    expect(doneEdges).toBe(0)
  })
})

describe('host relay translation (#6448)', () => {
  it('carries the outcome and the wait facts into the AgentEvent payload', () => {
    expect(relayTurnLifecycleEvent({ type: 'stop', outcome: 'cancelled' }, target, 5)).toEqual({
      type: 'stop', ...target, timestamp: 5, payload: { outcome: 'cancelled' },
    })
    expect(relayTurnLifecycleEvent({ type: 'wait', waitKind: 'question', waitId: 'q' }, target, 5).payload)
      .toEqual({ waitKind: 'question', waitId: 'q' })
    expect(relayTurnLifecycleEvent({ type: 'wait_resolved', waitId: 'q' }, target, 5).payload).toEqual({ waitId: 'q' })
    expect(relayTurnLifecycleEvent({ type: 'start' }, target, 5).payload).toEqual({})
  })

  // #6264 codex 回合被「这台机器上的登录不能用了」拒掉:这件事随失败那条边走,宿主据此回写「登录已失效」。
  it('carries the sign-in fact on the error edge, and only there', () => {
    expect(relayTurnLifecycleEvent({ type: 'error', signInRequired: true }, target, 5).payload).toEqual({ signInRequired: true })
    expect(relayTurnLifecycleEvent({ type: 'error' }, target, 5).payload).toEqual({})
    // 失败仍是失败:读数与不带这件事时一样。
    expect(relay([{ type: 'start' }, { type: 'error', signInRequired: true }]).readings.at(-1)).toMatchObject({ status: 'error' })
  })

  it('only stop and error end a turn (a wait is not a turn end for the platform recovery)', () => {
    expect(edgeEndsTurn({ type: 'stop' })).toBe(true)
    expect(edgeEndsTurn({ type: 'stop', outcome: 'cancelled' })).toBe(true)
    expect(edgeEndsTurn({ type: 'error' })).toBe(true)
    expect(edgeEndsTurn({ type: 'start' })).toBe(false)
    expect(edgeEndsTurn({ type: 'wait', waitKind: 'approval', waitId: 'w' })).toBe(false)
    expect(edgeEndsTurn({ type: 'wait_resolved', waitId: 'w' })).toBe(false)
  })
})
