// @vitest-environment jsdom
/**
 * #5858 —— 改口过的那一轮,**必须跨过推送边界到达渲染侧**。
 *
 * ## 这条判据补的是哪一格
 *
 * 引擎在回合中途死掉时,运行时会把那一轮**改口**:先按「连接塌了」落成 `prompt_failed`,
 * 毫秒之后收到进程 exit,再据此改成 `process_closed` + 退出码/信号/stderr 尾巴
 * (provider 原来那句话作为第二行留着)。
 *
 * 真机实测(mac1 2026-09-20)当时的样子:**运行时完全正确**,日志里
 * `SessionCell: turn outcome superseded` 写着 `nowReason=process_closed`;
 * **而产品面仍然显示「这条指令没能送达」,与修之前逐字一样。**
 * 根因:把新历史推给渲染侧的那条路(运行时 `emitCommittedTurns`)**只发新增的那几轮** ——
 * 改口不改变轮数,于是它一条都不发。
 *
 * ⚠️ 当时运行时那一侧已经有 8 条单测、3 对双向判据,**全绿** —— 因为它们全长在
 * 边界的**同一侧**。所以这里读的不是运行时算出了什么,而是**渲染侧手上最后是什么**:
 * `chatState.transcript.state.committedTurns`。
 *
 * ## 判据能判假吗
 *
 * 能,而且必失败条件就是那一行:把 `_onSessionLost` 里的 `void this._refreshHistory()` 删掉,
 * 「改口之后」那条立刻红(渲染侧会停在改口之前那份 `prompt_failed` 上),
 * 而同一条 `it` 里的阳性对照(改口之前确实是 `prompt_failed`)保持绿 ——
 * 于是这条判据动的只有「有没有再问一次」这一个变量。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../../../../../../../tests/support/awaitCondition'
import type { TranscriptTurn } from '@gugu/session-core/acp'

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }))

type StoreModule = typeof import('./acp-chat-store')
type StoreCtor = StoreModule['AcpChatStore']

// 桥必须在模块图加载之前就位(与 acp-chat-store.reconnect-5318.test.ts 同一个先例)。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
})
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: () => Promise.resolve([]),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
})
const { AcpChatStore }: StoreModule = await import('./acp-chat-store')

/** provider 在 prompt 边界上说的那句话 —— 改口之后它必须**逐字**还在。 */
const PRIOR = 'ACP connection closed'
/** 改口之后运行时手上的那一份:退出事实在前,原话在后。 */
const SUPERSEDED_DETAIL = `signal=SIGKILL\n${PRIOR}`

function turn(outcome: TranscriptTurn['outcome']): TranscriptTurn {
  return {
    id: 'turn-1',
    seq: 1,
    initiator: 'user',
    items: [{ kind: 'message', id: 'msg-1', seq: 0, role: 'user', text: '跑一下 sleep 300' }],
    ...(outcome ? { outcome } : {}),
  } as TranscriptTurn
}

const settledTurn = turn({ kind: 'error', reason: 'prompt_failed', detail: PRIOR })
const supersededTurn = turn({ kind: 'error', reason: 'process_closed', detail: SUPERSEDED_DETAIL })

let seq = 0

/**
 * 一个只回答「再问一次历史时你给什么」的假 handle。
 * 被测的是**渲染侧会不会再问**,不是 live session 自己的行为。
 */
function makeStore(): { store: InstanceType<StoreCtor>; asked: { value: number } } {
  seq += 1
  const store = new AcpChatStore(`conv-5858-${seq}`, 'proj-1')
  const asked = { value: 0 }
  store.session = {
    getHistory: async () => {
      asked.value += 1
      // 运行时改口之后手上的那一份。
      return { success: true as const, data: { turns: [supersededTurn], nextCursor: null } }
    },
    config: { current: () => ({}) },
  } as unknown as NonNullable<InstanceType<StoreCtor>['session']>
  store.historyLoading = false
  // 渲染侧此刻手上的,是**改口之前**那一份 —— 这正是真机上停住的那个状态。
  store.chatState.transcript.history.seed([settledTurn])
  return { store, asked }
}

const lastOutcome = (store: InstanceType<StoreCtor>): TranscriptTurn['outcome'] =>
  store.chatState.transcript.state.committedTurns.at(-1)?.outcome

beforeEach(() => {
  seq += 1
})

describe('#5858 改口过的那一轮要跨过推送边界', () => {
  it('阳性对照:会话死之前,渲染侧手上确实是改口**之前**那一份', () => {
    const { store, asked } = makeStore()
    expect(lastOutcome(store)).toMatchObject({ reason: 'prompt_failed', detail: PRIOR })
    expect(asked.value, '还没问过历史 —— 否则下面那条读的不是「因为死了才去问」').toBe(0)
  })

  it('会话死掉之后,渲染侧手上的那一轮变成 process_closed,且 provider 原话逐字还在', async () => {
    const { store, asked } = makeStore()

    ;(store as unknown as { _onSessionLost: (n: unknown) => void })._onSessionLost({
      failure: { message: 'ACP adapter exited unexpectedly (signal SIGKILL)' },
    })
    // `_refreshHistory` 是异步的,落到 transcript(Solid 信号)上没有可 await 的完成信号:轮询这一轮的结局。
    await until(
      '渲染侧那一轮换成运行时改口之后的结局',
      () => lastOutcome(store)?.reason,
      (reason) => reason === 'process_closed',
    )
    expect(asked.value).toBeGreaterThan(0)

    const detail = (lastOutcome(store) as { detail?: string } | undefined)?.detail ?? ''
    expect(detail, '退出事实没到屏幕这一侧').toContain('signal=SIGKILL')
    expect(detail, '改口把 provider 原来那句话弄丢了 —— 那正是本票要救的东西').toContain(PRIOR)
  })

  it('会话死掉这件事本身照旧显形(❌ 重读不许把 lost 提示吃掉)', () => {
    const { store } = makeStore()
    ;(store as unknown as { _onSessionLost: (n: unknown) => void })._onSessionLost({
      failure: { message: 'ACP adapter exited unexpectedly (signal SIGKILL)' },
    })
    expect(store.loadError?.kind).toBe('adapter_lost')
    expect(store.historyLoading).toBe(false)
  })
})
