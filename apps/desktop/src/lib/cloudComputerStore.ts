import {
  CloudComputerError,
  CloudComputerWakeError,
  CLOUD_COMPUTER_WAKE_TIMEOUT_MS,
  cloudComputerFailureKind,
  cloudComputerNeedsWake,
  cloudComputerOverdue,
  cloudComputerPresence,
  isCloudComputerNotOpen,
  wakeCloudComputerUntilOnline,
  type CloudComputerFailureKind,
  type CloudComputerProvisionInput,
  type CloudComputerWakeInput,
  type CloudComputerSnapshot,
} from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { rendererCloudComputerClient } from './cloudComputer'
import { rendererLogger } from './log'

/**
 * #7199 这个账号的云电脑此刻怎样 —— 渲染层只有这一份(设置 → 设备、「在哪跑」、会话页、建 agent 都读它)。
 * 管家的 /state 是唯一事实源;库里的在线与否只用来判「醒了的那台 server 上线没有」。
 * 什么时候去问管家由 DevicesProvider 定(登录、设备行变动、切回窗口、开通 / 唤醒途中每 3 秒、有云电脑时每 30 秒),
 * 打开和它上面的 agent 的私聊、打开它上面的会话时各现问一次;这里只放状态与动作。
 */
const log = rendererLogger('cloud-computer')

export type CloudComputerStoreState = {
  /** 拿得到管家地址、且那扇门没说「环境未配置可选云电脑服务」(503 not_open):false ⇒ 这个功能不显示。 */
  available: boolean
  /** 还没问到 = null。 */
  snapshot: CloudComputerSnapshot | null
  /** 最近一次问管家没问到是哪一类(问到了就清掉;原文进日志)。 */
  loadError: CloudComputerFailureKind | null
  /**
   * 叫醒被管家拒了(积分用完 / 会员到期 / 没有这项权益):那台云电脑此刻收回着、却醒不来 —— 它上面的 agent ❌ 当
   * 「收回着、有事自己醒」不画状态,照读数说不在线并说原因(拒了的时候管家的 /state 仍是 asleep,❌ 变成 error)。
   * 它离开 asleep(醒了 / 正在醒 / 关了)或下一次叫醒成功就清掉。
   */
  wakeRefused?: { deviceId: string; kind: CloudComputerFailureKind } | null
}

// 拿不拿得到管家地址在第一次 reset / refresh 时才算(DevicesProvider 挂上就 reset 一次),❌ 在模块加载时读配置。
let state: CloudComputerStoreState = { available: false, snapshot: null, loadError: null, wakeRefused: null }
const listeners = new Set<() => void>()
/** 换账号时作废在途的应答:旧账号的 /state 晚到,❌ 落进新账号。 */
let generation = 0
/**
 * 同一个账号里几路同时在问(3 秒轮询、叫醒途中、设备行变动、切回窗口):只认比已落地的更晚发出的那一次 ——
 * ❌ 让先发后到的旧应答(还说「休眠中」)盖掉新的。
 */
let issued = 0
let applied = 0
/** 换账号时停掉在途的叫醒(❌ 拿新账号的 /state 接着等旧账号的那台)。 */
let wakeAbort = new AbortController()
type ConnectionWake = { promise: Promise<void>; abort: AbortController; users: number; settled: boolean }
const connectionWakes = new Map<string, ConnectionWake>()

/** 管家说出错时那句原因只进日志(界面说「云电脑那边出了问题」);同一句只记一次。 */
let loggedSnapshotError: string | null = null

function set(next: Partial<CloudComputerStoreState>): void {
  state = { ...state, ...next }
  const refused = state.wakeRefused
  if (refused && !(state.snapshot?.state === 'asleep' && state.snapshot.deviceId === refused.deviceId)) state = { ...state, wakeRefused: null }
  const failed = state.snapshot?.state === 'error' ? state.snapshot.error ?? 'error without reason' : null
  if (failed && failed !== loggedSnapshotError) log.warn({ reason: failed, deviceId: state.snapshot?.deviceId ?? null }, 'cloud computer reported an error')
  loggedSnapshotError = failed
  for (const listener of listeners) listener()
}

export function getCloudComputerState(): CloudComputerStoreState {
  return state
}

export function subscribeCloudComputerState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 换了账号 / 退出登录:上一个账号的云电脑 ❌ 留在界面上。 */
export function resetCloudComputerState(): void {
  generation += 1
  wakeAbort.abort()
  wakeAbort = new AbortController()
  connectionWakes.clear()
  set({ available: rendererCloudComputerClient() !== null, snapshot: null, loadError: null, wakeRefused: null })
}

/** 管家拒绝叫醒的那几类:权益 / 积分的事,再叫也一样,直到人去续费 / 充值。 */
const WAKE_REFUSALS: ReadonlySet<CloudComputerFailureKind> = new Set(['plan_required', 'credits_exhausted', 'membership_expired'])

/** 叫醒没成:是被拒就记下是哪台、为什么(界面据此照实说不在线 + 原因);别的失败不记。原样抛回。 */
function noteWakeFailure(error: unknown): never {
  const kind = cloudComputerFailureKind(error)
  const deviceId = state.snapshot?.deviceId ?? null
  if (WAKE_REFUSALS.has(kind) && deviceId) set({ wakeRefused: { deviceId, kind } })
  throw error
}

function requireClient() {
  const client = rendererCloudComputerClient()
  if (!client) throw new CloudComputerError(0, 'unavailable', 'cloud computer manager URL is not configured')
  return client
}

/** 问一次管家。没配地址 / 环境未配置可选云电脑服务 = null;问不到就记下原因再抛(调用方决定要不要说给人听)。 */
export async function refreshCloudComputer(): Promise<CloudComputerSnapshot | null> {
  const client = rendererCloudComputerClient()
  if (!client) {
    set({ available: false })
    return null
  }
  const asked = generation
  const mine = ++issued
  try {
    const snapshot = await client.state()
    if (asked === generation && mine > applied) {
      applied = mine
      set({ available: true, snapshot, loadError: null })
    }
    return snapshot
  } catch (error) {
    // 门说「环境未配置可选云电脑服务」:整块不显示(❌ 给所有人报「读不到云电脑的状态」);配上以后登录、切回窗口时问到就出现。
    if (isCloudComputerNotOpen(error)) {
      if (asked === generation && mine > applied) {
        applied = mine
        set({ available: false, snapshot: null, loadError: null })
      }
      log.info({ code: 'not_open' }, 'cloud computer manager is not configured on this backend')
      return null
    }
    // 别的没问到(管家连不上、云端函数没部署……)照旧说「读不到」—— 之前门说过「未配置」也一样:门配上了才会回别的。
    if (asked === generation) set({ available: true, loadError: cloudComputerFailureKind(error) })
    log.warn({ err: String((error as Error)?.message ?? error) }, 'cloud computer state failed')
    throw error
  }
}

/** 开一台。202 之后进度靠 /state;这里先问一次,让界面立刻进「正在开通」。 */
export async function provisionCloudComputer(input?: CloudComputerProvisionInput): Promise<void> {
  await requireClient().provision(input)
  await refreshCloudComputer().catch(() => undefined)
}

/**
 * 正在叫的那几次:连着敲字时同一次叫醒不重复发(❌ 每个字一个 POST /wake)。
 * 按用途分开记:搬家读旧家的那一叫(`purpose: 'move_out'`,会员到期也放行)不能被一次普通的叫醒顶掉 —— 到期后普通叫醒会被拒。
 */
const wakeInFlight = new Map<string, Promise<void>>()

export function wakeCloudComputer(input?: CloudComputerWakeInput): Promise<void> {
  const key = input?.purpose ?? ''
  const existing = wakeInFlight.get(key)
  if (existing) return existing
  const run = (async () => {
    await requireClient().wake(input).catch(noteWakeFailure)
    if (state.wakeRefused) set({ wakeRefused: null })
    await refreshCloudComputer().catch(() => undefined)
  })()
  const tracked = run.finally(() => {
    wakeInFlight.delete(key)
  })
  wakeInFlight.set(key, tracked)
  return tracked
}

/** 关掉:管家删干净设备行、上面的智能体、沙盒与存的数据(DELETE 成功即已删)。 */
export async function destroyCloudComputer(): Promise<void> {
  const asked = generation
  await requireClient().destroy()
  // 管家删干净才回成功:当场就是「没有」,「开一台云电脑」立刻回来(❌ 等下一次问到;那一次问不到时页面上什么都没有)。
  if (asked === generation) {
    applied = ++issued
    set({ snapshot: { state: 'none', deviceId: null, error: null, since: new Date().toISOString() }, loadError: null })
  }
  await refreshCloudComputer().catch(() => undefined)
}

/**
 * 设备列表补上云电脑那一行此刻的样子(`cloud_computer`);别的行原样。叫醒被拒的那一台(`refusedDeviceId`)不补:
 * 它醒不来,❌ 算「收回着、有事自己醒」,照库里的离线说。
 */
export function withCloudComputerPresence(
  devices: Device[],
  snapshot: CloudComputerSnapshot | null,
  now: number = Date.now(),
  refusedDeviceId: string | null = null,
): Device[] {
  if (!snapshot?.deviceId) return devices
  let changed = false
  const next = devices.map((device) => {
    const presence = device.device_id === refusedDeviceId ? null : cloudComputerPresence(device, snapshot, now)
    if ((device.cloud_computer ?? null) === presence) return device
    changed = true
    const { cloud_computer: _drop, ...rest } = device
    return presence ? { ...rest, cloud_computer: presence } : rest
  })
  return changed ? next : devices
}

/** 开通 / 唤醒途中多久问一次管家;不在途中 = null(那时由 cloudComputerWatchMs 慢慢问)。 */
export const CLOUD_COMPUTER_FAST_POLL_MS = 3_000

/**
 * 有一台云电脑、不在开通 / 唤醒途中时多久问一次管家。它睡下、被别处叫醒(私聊、已安排到点),库里那一行的在线与否
 * 要等心跳超时(实测约 2 分钟)才翻 —— 在不在以管家为准,❌ 等那一行。没有云电脑 = null(❌ 白问)。
 */
export const CLOUD_COMPUTER_WATCH_MS = 30_000

export function cloudComputerWatchMs(snapshot: CloudComputerSnapshot | null): number | null {
  if (!snapshot?.deviceId) return null
  return snapshot.state === 'awake' || snapshot.state === 'asleep' ? CLOUD_COMPUTER_WATCH_MS : null
}

export function cloudComputerPollMs(snapshot: CloudComputerSnapshot | null, devices: readonly Device[], now: number = Date.now()): number | null {
  if (!snapshot) return null
  if (snapshot.state === 'provisioning') return CLOUD_COMPUTER_FAST_POLL_MS
  // 正在醒:管家自己会在时限内翻成醒了或出错;它卡在这一格太久就不再每 3 秒问(登录、设备行变动、切回窗口照样问)。
  if (snapshot.state === 'waking') return cloudComputerOverdue(snapshot, now, 2 * CLOUD_COMPUTER_WAKE_TIMEOUT_MS) ? null : CLOUD_COMPUTER_FAST_POLL_MS
  if (snapshot.state === 'awake') {
    const device = snapshot.deviceId ? devices.find((d) => d.device_id === snapshot.deviceId) : undefined
    // 管家说醒了、那台 server 还没在库里上线:接着看,直到它上线;过了叫醒时限就不等了(那一行照离线说)。
    if (!device?.is_online && !cloudComputerOverdue(snapshot, now)) return CLOUD_COMPUTER_FAST_POLL_MS
  }
  return null
}

/**
 * 在它上面开会话 / 打开它上面的会话这类要一条活连接的动作之前:叫醒它,等到它真的在线(每问到一次 /state 都更新界面)。
 * 原因见 CloudComputerWakeError;不是这个账号的云电脑也当失败说(调用方只对云电脑那一行调它)。
 */
export function wakeAndWaitOnline(deviceId: string, deps: { isOnline: (deviceId: string) => Promise<boolean>; signal?: AbortSignal }): Promise<void> {
  deps.signal?.throwIfAborted()
  let entry = connectionWakes.get(deviceId)
  if (!entry) {
    const asked = generation
    const abort = new AbortController()
    const signal = AbortSignal.any([wakeAbort.signal, abort.signal])
    // Explicit operations own resume; background pipe retries stay read-only.
    const pending = wakeCloudComputerUntilOnline({
      client: requireClient(), deviceId, isOnline: deps.isOnline, signal,
      onSnapshot: snapshot => {
        if (asked !== generation || signal.aborted) return
        applied = ++issued
        set({ available: true, snapshot, loadError: null })
      },
    }).catch(error => { if (signal.aborted) throw error; return noteWakeFailure(error) }).then(outcome => {
      if (outcome === 'not-cloud') throw new CloudComputerWakeError('failed', `device ${deviceId} is not this account's cloud computer`)
    }).finally(() => {
      created.settled = true
      if (connectionWakes.get(deviceId) === created) connectionWakes.delete(deviceId)
    })
    const created: ConnectionWake = { promise: pending, abort, users: 0, settled: false }
    entry = created
    connectionWakes.set(deviceId, entry)
  }
  entry.users++
  if (!deps.signal) return entry.promise
  const shared = entry
  return new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (action: () => void) => {
      if (finished) return
      finished = true
      deps.signal!.removeEventListener('abort', onAbort)
      shared.users--
      if (!shared.users && !shared.settled) {
        shared.abort.abort()
        if (connectionWakes.get(deviceId) === shared) connectionWakes.delete(deviceId)
      }
      action()
    }
    const onAbort = () => finish(() => reject(deps.signal!.reason))
    // Cancelling one consumer leaves another explicit operation's wake alive.
    deps.signal!.addEventListener('abort', onAbort, { once: true })
    shared.promise.then(() => finish(resolve), error => finish(() => reject(error)))
    if (deps.signal!.aborted) onAbort()
  })
}

/** 这一行是不是要先叫醒的云电脑(睡着 / 正在醒)。 */
export function deviceNeedsWake(device: Pick<Device, 'cloud_computer'> | null | undefined): boolean {
  return cloudComputerNeedsWake(device?.cloud_computer ?? null)
}

export type CloudComputerStepStatus = 'pending' | 'running' | 'done'

/**
 * 开通三步,每步按看得到的事实打勾(管家 10-15 说明的顺序:登录 → 设备行出现 → 上线 → 建个人助理 → awake):
 * ① 开机并登录你的账号 = /state 带上 deviceId;② 等它上线 = 设备行在线;③ 建好个人助理 = state 变 awake。
 */
export function cloudComputerProvisionSteps(
  snapshot: CloudComputerSnapshot,
  device: Pick<Device, 'is_online'> | null,
): Array<{ id: 'machine' | 'online' | 'assistant'; status: CloudComputerStepStatus }> {
  const signedIn = snapshot.deviceId !== null
  const online = signedIn && device?.is_online === true
  const ready = snapshot.state === 'awake' && online
  const machine: CloudComputerStepStatus = signedIn ? 'done' : 'running'
  const onlineStep: CloudComputerStepStatus = online ? 'done' : signedIn ? 'running' : 'pending'
  const assistant: CloudComputerStepStatus = ready ? 'done' : online ? 'running' : 'pending'
  return [
    { id: 'machine', status: machine },
    { id: 'online', status: onlineStep },
    { id: 'assistant', status: assistant },
  ]
}
