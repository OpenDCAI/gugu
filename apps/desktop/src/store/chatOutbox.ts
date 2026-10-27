// @@@send-outbox (#1762 洞③/#1941) — 发送 outbox:所有文本族消息发送的唯一 chokepoint(对齐 #1904
// 未读水位 chokepoint 哲学)。store.sendMessage 只「入队」,本模块的 drainer 是唯一真投递点。
//
// 状态机: pending →(领取)→ sending →(prepare 前置 → writer 返回送达)→ sent(删行,onSent)
//                                   →(错误/15s 超时)→ 退避重试(2s/8s,共 3 次尝试)→ failed(可见,onState)
//         failed →(手动重试 | window online)→ pending
//
// 设计要点(#1762 评论拍板):
// * 持久化经注入的 persistence(localSyncDb outbox store):enqueue 先落盘再投,reload/崩溃不丢;
//   重启时 state='sending' 的行(死在投递中)视同 pending 重投。
// * 幂等:clientMessageId = 乐观行 id = messages 主键 = client_message_id;投递 writer 在数据库事务内
//   原子收敛等价重放。outbox 不解释 409/唯一键错误:writer 未返回成功的错误一律进入重试/fail-loud。
// * 投递超时 15s 用 Promise.race(不给冻结的 lib/chat.ts 加 abortSignal 参数):慢成功被判失败后,
//   重投由 writer 原子收敛到同一行,语义闭环无损。
// * 按会话分道串行 drain:每个 chatId 一条车道、车道内单在途 FIFO —— 同会话内消息不乱序,退避等待期间
//   不放行同会话后续消息(乱序代价 > 等待);不同会话互不阻塞:一条会话卡在 15s 超时 + 退避里,
//   别的会话照常投递(从前全局单在途,一条卡住所有会话都「发送中」最长 ~55s)。
// * fail-loud:每次状态迁移经 onState 反映到 UI 乐观行;'sent' 即删行,outbox 不做第二事实源。

import type { OutboxRecord } from '../lib/imRepository'
import { i18n } from '@/i18n'
import { rendererLogger } from '../lib/log'
import { chatSendTimings, finishChatSendTiming } from '../lib/chatSendTiming'

const outboxLog = rendererLogger('chat/outbox')

export const OUTBOX_DELIVER_TIMEOUT_MS = 15_000
// 3 次尝试(拍板 a):真实故障是分钟级网关中断,更长退避只会推迟 fail-loud 暴露;
// 快退避(~10s 总预算)兜秒级瞬断,之后立刻亮 failed 交手动 + online kick。
export const OUTBOX_RETRY_BACKOFF_MS = [2_000, 8_000] as const

export interface OutboxDeps {
  load(): Promise<OutboxRecord[]>
  save(record: OutboxRecord): Promise<void>
  remove(clientMessageId: string): Promise<void>
  /** 送达确认的持久化提交；产品接线在同一 repository transaction 内写 message + 删 outbox。 */
  ack?(record: OutboxRecord, delivered: unknown, isActive: () => boolean): Promise<unknown>
  /**
   * 投递前置(每次尝试都在 deliver 之前跑):会话就绪、收件人解析等。返回的记录若与入参不同就落盘后再投。
   * 抛错 = 本次尝试失败(与投递失败同路:退避重试 → failed 可见可重试)。它不计入投递超时:
   * 前置是「能不能开始投」,超时量的是「投出去有没有回音」。
   */
  prepare?(record: OutboxRecord): Promise<OutboxRecord>
  /** 真投递(chatService.sendMessage 的闭包);返回权威送达 row,抛错 = 本次尝试失败。 */
  deliver(record: OutboxRecord): Promise<unknown>
  /** 状态迁移 → UI(乐观行 local_send_state 同步;'pending'/'sending' 由 UI 统一显示为发送中)。 */
  onState(record: OutboxRecord): void
  /** writer 确认送达后的连带动作(水位/预览/运行态点亮)。行已从 outbox 删除。 */
  onSent(record: OutboxRecord, acknowledged?: unknown): void | Promise<void>
  onDiscarded(record: OutboxRecord): void
  /** 注入时钟(测试用假定时器)。 */
  setTimeout?: (fn: () => void, ms: number) => unknown
  now?: () => number
  timeoutMs?: number
  backoffMs?: readonly number[]
}

export interface ChatOutbox {
  /** Stop this account epoch without deleting durable rows. */
  dispose(): void
  /** 入队(先落盘再投)。resolve = 已入队,不等送达。 */
  enqueue(record: OutboxRecord): Promise<void>
  /** failed → pending 重投(手动重试;attempts 归零重新获得自动重试预算)。 */
  retry(clientMessageId: string): Promise<void>
  /** 显式丢弃:删行 + onDiscarded(调用方负责移除乐观行)。 */
  discard(clientMessageId: string): Promise<void>
  /** 网络恢复 kick:全部 failed → pending 自动重投(验收②的自动路径)。 */
  retryAllFailed(): Promise<void>
  /** 启动恢复:载入持久化行('sending'→'pending'),返回记录供 UI 重建乐观行,并开始投递。 */
  restore(): Promise<OutboxRecord[]>
  /** 当前未决记录快照(chatId/threadRootId 过滤;UI 合并点注入用)。 */
  pendingFor(chatId: string, threadRootId: string | null): OutboxRecord[]
  /** 等某条真送达(送达 resolve;终态 failed/丢弃 reject)。结构性发送(新建话题 root)用。 */
  delivered(clientMessageId: string): Promise<void>
}

export function createChatOutbox(deps: OutboxDeps): ChatOutbox {
  const timeoutMs = deps.timeoutMs ?? OUTBOX_DELIVER_TIMEOUT_MS
  const backoffMs = deps.backoffMs ?? OUTBOX_RETRY_BACKOFF_MS
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))

  // 内存队列:clientMessageId → record(与持久层同步写)。Map 保持插入序,FIFO。
  const records = new Map<string, OutboxRecord>()
  // 正在跑的车道(chatId)。车道 = 该会话的单在途 FIFO drain。
  const drainingLanes = new Set<string>()
  let disposed = false
  let epoch = 0
  const isActive = (operationEpoch = epoch) => !disposed && operationEpoch === epoch
  // delivered() 的等待者:送达 resolve,终态 failed / 丢弃 reject(供「新建话题 root 必须先落库」类结构性发送)
  const waiters = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()
  function resolveWaiter(id: string): void {
    waiters.get(id)?.resolve()
    waiters.delete(id)
  }
  function rejectWaiter(id: string, reason: string): void {
    waiters.get(id)?.reject(new Error(reason))
    waiters.delete(id)
  }

  async function persist(record: OutboxRecord, state: OutboxRecord['state'], patch: Partial<OutboxRecord> = {}, operationEpoch = epoch): Promise<OutboxRecord> {
    const next: OutboxRecord = { ...record, ...patch, state, updatedAt: new Date(deps.now?.() ?? Date.now()).toISOString() }
    await deps.save(next)
    if (isActive(operationEpoch)) records.set(next.clientMessageId, next)
    return next
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => schedule(resolve, ms))
  }

  async function deliverWithTimeout(record: OutboxRecord): Promise<unknown> {
    return Promise.race([
      deps.deliver(record),
      sleep(timeoutMs).then(() => {
        throw new Error(i18n.t('outbox.deliveryTimeout', { ns: 'messaging', seconds: timeoutMs / 1000 }))
      }),
    ])
  }

  async function settleSent(record: OutboxRecord, delivered: unknown, operationEpoch: number): Promise<void> {
    const acknowledged = deps.ack
      ? await deps.ack(record, delivered, () => isActive(operationEpoch))
      : await deps.remove(record.clientMessageId)
    if (!isActive(operationEpoch)) return
    records.delete(record.clientMessageId)
    finishChatSendTiming(record.clientMessageId, true)
    resolveWaiter(record.clientMessageId)
    // onSent 是无超时的网络副作用(摘要刷新等)——不得 await:网关挂起时会把整个
    // drain 队列静默卡死(后续消息永远「发送中」,连 failed 都到不了)。副作用失败由回调自报。
    void Promise.resolve(deps.onSent(record, acknowledged)).catch((err) => {
      console.error('[chatOutbox] onSent side effects failed', err)
    })
  }

  function settleSentInBackground(record: OutboxRecord, delivered: unknown, operationEpoch: number): void {
    void settleSent(record, delivered, operationEpoch).catch(async (error) => {
      if (!isActive(operationEpoch) || !records.has(record.clientMessageId)) return
      try {
        const failed = await persist(record, 'failed', {
          lastError: error instanceof Error ? error.message : String(error),
        }, operationEpoch)
        if (!isActive(operationEpoch) || !records.has(record.clientMessageId)) return
        deps.onState(failed)
        rejectWaiter(failed.clientMessageId, failed.lastError ?? i18n.t('outbox.sendFailed', { ns: 'messaging' }))
      } catch (persistError) {
        outboxLog.error({ error: persistError }, 'durable ack failure could not be persisted')
      }
    })
  }

  // 按会话分道:车道内单在途 FIFO。同一 record 的退避等待内联在车道里(同会话后续消息不得越过在途重试行)。
  async function drainLane(chatId: string): Promise<void> {
    if (drainingLanes.has(chatId) || disposed) return
    const operationEpoch = epoch
    drainingLanes.add(chatId)
    try {
      for (;;) {
        const next = [...records.values()].find((r) => r.chatId === chatId && r.state === 'pending')
        if (!next || !isActive(operationEpoch)) return
        let record = await persist(next, 'sending', {}, operationEpoch)
        if (!isActive(operationEpoch)) return
        deps.onState(record)
        let delivered = false
        for (let attempt = 1; attempt <= backoffMs.length + 1; attempt += 1) {
          try {
            if (deps.prepare) {
              const prepared = await deps.prepare(record)
              if (!isActive(operationEpoch)) return
              // 前置在途期间被手动丢弃 → 不得 persist 复活
              if (!records.has(record.clientMessageId)) break
              if (prepared !== record) record = await persist(prepared, 'sending', {}, operationEpoch)
              if (!isActive(operationEpoch)) return
            }
            const deliveredRow = await deliverWithTimeout(record)
            const timing = chatSendTimings.get(record.clientMessageId); if (timing) timing.response = performance.now()
            if (!isActive(operationEpoch)) return
            settleSentInBackground(record, deliveredRow, operationEpoch)
            delivered = true
          } catch (err) {
            if (!isActive(operationEpoch)) return
            // 投递在途期间被手动丢弃 → 不得 persist 复活(discard 已删行删库);直接停
            if (!records.has(record.clientMessageId)) break
            record = await persist(record, 'sending', {
              attempts: record.attempts + 1,
              lastError: err instanceof Error ? err.message : String(err),
            }, operationEpoch)
            if (!isActive(operationEpoch)) return
            if (attempt <= backoffMs.length) {
              await sleep(backoffMs[attempt - 1])
              if (!isActive(operationEpoch)) return
              // 退避期间被手动丢弃 → 行已不在,停止重试
              if (!records.has(record.clientMessageId)) break
              continue
            }
          }
          break
        }
        if (!delivered && records.has(record.clientMessageId)) {
          record = await persist(record, 'failed', {}, operationEpoch)
          if (!isActive(operationEpoch)) return
          deps.onState(record)
          rejectWaiter(record.clientMessageId, record.lastError ?? i18n.t('outbox.sendFailed', { ns: 'messaging' }))
        }
      }
    } finally {
      drainingLanes.delete(chatId)
    }
  }

  // 为每个有 pending 行、且车道没在跑的会话起一条车道。
  function kick(): void {
    if (disposed) return
    const chatIds = new Set([...records.values()].filter((r) => r.state === 'pending').map((r) => r.chatId))
    for (const chatId of chatIds) {
      if (drainingLanes.has(chatId)) continue
      void drainLane(chatId).catch((err) => {
        // 车道自身的意外(持久层写失败等)不允许静默:打日志并复位,下次 enqueue/retry 仍可驱动
        outboxLog.error({ error: err, chatId }, 'outbox lane crashed')
      })
    }
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const id of records.keys()) chatSendTimings.delete(id)
      epoch += 1
      records.clear()
      for (const id of waiters.keys()) rejectWaiter(id, 'outbox scope disposed')
    },
    async enqueue(record) {
      if (disposed) throw new Error('outbox scope disposed')
      const operationEpoch = epoch
      const staged: OutboxRecord = { ...record, attempts: 0, state: 'pending', updatedAt: new Date(deps.now?.() ?? Date.now()).toISOString() }
      // enqueue 以落盘为提交点,字面执行「先落盘再可投递」:落盘成功前记录不进内存队列,并发中的
      // drain 看不到它——落盘失败即拒绝且内外皆无残留(否则后续任意 kick 会把这条「失败」的消息
      // 连带补投出去,composer 恢复重试 → 文字翻倍;先 set 后 save 还有 save 期间被 drain 抢投的竞态)。
      await deps.save(staged)
      const timing = chatSendTimings.get(staged.clientMessageId); if (timing) timing.enqueue = performance.now()
      if (!isActive(operationEpoch)) return
      records.set(staged.clientMessageId, staged)
      deps.onState(staged)
      kick()
    },
    async retry(clientMessageId) {
      if (disposed) return
      const operationEpoch = epoch
      const record = records.get(clientMessageId)
      if (!record || record.state !== 'failed') return
      const next = await persist(record, 'pending', { attempts: 0, lastError: null }, operationEpoch)
      if (!isActive(operationEpoch)) return
      deps.onState(next)
      kick()
    },
    async discard(clientMessageId) {
      finishChatSendTiming(clientMessageId)
      if (disposed) return
      const operationEpoch = epoch
      const record = records.get(clientMessageId)
      if (!record) return
      records.delete(clientMessageId)
      await deps.remove(clientMessageId)
      if (!isActive(operationEpoch)) return
      rejectWaiter(clientMessageId, i18n.t('outbox.discarded', { ns: 'messaging' }))
      deps.onDiscarded(record)
    },
    async retryAllFailed() {
      if (disposed) return
      const operationEpoch = epoch
      for (const record of records.values()) {
        if (record.state === 'failed') {
          const next = await persist(record, 'pending', { attempts: 0, lastError: null }, operationEpoch)
          if (!isActive(operationEpoch)) return
          deps.onState(next)
        }
      }
      kick()
    },
    async restore() {
      if (disposed) return []
      const operationEpoch = epoch
      const rows = await deps.load()
      if (!isActive(operationEpoch)) return []
      const restored: OutboxRecord[] = []
      for (const row of rows) {
        // 死在投递中的 'sending' 行视同 pending 重投(幂等键兜底,双发机制性不可能)
        const state = row.state === 'sending' ? 'pending' : row.state
        const record: OutboxRecord = { ...row, state }
        if (state !== row.state) await deps.save(record)
        if (!isActive(operationEpoch)) return []
        records.set(record.clientMessageId, record)
        restored.push(record)
      }
      kick()
      return restored
    },
    pendingFor(chatId, threadRootId) {
      if (disposed) return []
      return [...records.values()].filter(
        (r) => r.chatId === chatId && (r.payload.threadRootId ?? null) === threadRootId,
      )
    },
    delivered(clientMessageId) {
      if (disposed) return Promise.reject(new Error('outbox scope disposed'))
      const record = records.get(clientMessageId)
      if (!record) return Promise.resolve() // 已送达删行(入队方自持 id,不存在=已 settle)
      if (record.state === 'failed') return Promise.reject(new Error(record.lastError ?? i18n.t('outbox.sendFailed', { ns: 'messaging' }))) // 终态已定,别挂等待者
      return new Promise<void>((resolve, reject) => {
        waiters.set(clientMessageId, { resolve, reject })
      })
    },
  }
}
