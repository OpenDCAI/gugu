import { expect, onTestFailed, TestRunner } from 'vitest'

const getCurrentTest = () => TestRunner.getCurrentTest()

/**
 * 等**事实**,不等墙钟 —— 浏览器用例的那一半(#4357 的延伸,#6331;node 侧的子进程等待见 awaitFact.ts)。
 *
 * `expect.poll` / `vi.waitFor` 自带一个毫秒上限(不写就是 1s)。那个上限与被测行为无关:同一步在
 * 并发浏览器负载下要多久由机器决定,于是「挂载一行」「一次过渡落定」在 CI 上 1.1s 就被判红,单跑永远绿
 * (#6325 的读数:session-chat-ui-browser 与 session-browser 并发时,红在哪一条都不固定)。
 *
 * 所以 `until` 自己**没有 deadline**:条件成立就 resolve。那么事实永远不来(真回归)时谁判红?
 * **这条用例自己的 testTimeout**(浏览器 project 在 vitest.config.ts 里给了一个远高于任何负载的值)——
 * 唯一的上限在最外层,而且红的时候说得清卡在哪:
 * - 用例因超时(或任何原因)失败时还有一次 `until` 没等到,就往失败原因里补一条
 *   `[awaiting-fact] <这一步> — last observed: <最后一次读到的值>`,❌ 只剩一句「Test timed out」;
 * - 等待超过 {@link HEARTBEAT_MS} 仍未结束,往控制台报一行进度(只报告,不判定)。
 *
 * ❌ 别在这里加「最多等 N 秒」的参数。❌ 别用「sleep 一段时间再断言没发生」证明一件事没发生 ——
 * 去等那个能证明它的事实(比如用假时钟把延时推过去,再看它是否发生)。
 *
 * 轮询与计时用模块加载时捕获的**真** setTimeout / Date.now:用例里 `vi.useFakeTimers()` 之后,等待本身不会被冻住。
 */

/** 等待多久之后开始报「还在等」。只影响日志,不影响判定。 */
export const HEARTBEAT_MS = 60_000

const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const realNow = Date.now.bind(Date)
const POLL_MS = 16

/**
 * 连续卡死保护(#6346):同一步骤连续 {@link STREAK_LIMIT} 条用例都等到上限没等到,下一条再等这一步就**当场**红,
 * 点名这一步 —— ❌ 一条条等满上限。一个 project 上百条用例 × 每条 60s 远超 CI job 的 25 分钟,整片卡死
 * (比如依赖预构建半途重载成两份 React,#6325 的读数)会以 job cancelled 收场,说不出是哪一步。
 * 记在 sessionStorage:浏览器模式下各测试文件是同源 iframe、同一个标签页,跨文件共享;下一次运行是新标签页,自然清零。
 */
export const STREAK_LIMIT = 3
const STREAK_KEY = 'gugu:awaiting-fact-streak'
type Streak = { step: string; count: number }

function readStreak(): Streak | null {
  if (typeof sessionStorage === 'undefined') return null
  const raw = sessionStorage.getItem(STREAK_KEY)
  return raw ? (JSON.parse(raw) as Streak) : null
}

function writeStreak(streak: Streak | null): void {
  if (typeof sessionStorage === 'undefined') return
  if (streak) sessionStorage.setItem(STREAK_KEY, JSON.stringify(streak))
  else sessionStorage.removeItem(STREAK_KEY)
}

/** 每条用例正在等的那一步与它最后一次读到的值;用例失败时拿来说明卡在哪。按用例记,❌ 串到下一条。 */
type Test = NonNullable<ReturnType<typeof getCurrentTest>>
const pending = new WeakMap<Test, { step: string; last: unknown }>()
const reported = new WeakSet<Test>()

function currentTestName(): string {
  try {
    return expect.getState().currentTestName ?? '(outside a test)'
  } catch {
    return '(outside a test)'
  }
}

function describeValue(value: unknown): string {
  // node 环境的 project 没有 Element:直接写 `instanceof Element` 会在报读数那一刻抛 ReferenceError。
  if (typeof Element !== 'undefined' && value instanceof Element) return `<${value.tagName.toLowerCase()}>`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 每条用例挂一次:它失败时若还有一次 `until` 没等到,把「等的是哪一步、最后读到什么」补进失败原因。 */
function reportPendingOnFailure(test: Test | undefined): void {
  if (!test || reported.has(test)) return
  reported.add(test)
  onTestFailed(({ task }) => {
    const waiting = pending.get(test)
    if (!waiting) return
    const streak = readStreak()
    writeStreak({ step: waiting.step, count: streak?.step === waiting.step ? streak.count + 1 : 1 })
    const reason = new Error(`[awaiting-fact] ${waiting.step} — last observed: ${describeValue(waiting.last)}`)
    task.result?.errors?.push({ name: reason.name, message: reason.message, stack: reason.stack })
    console.error(reason.message)
  })
}

/**
 * 等到事实成立。两种写法:
 * - `until(step, () => 条件)`;
 * - `until(step, () => 读数, (读数) => 条件)` —— 失败时报出最后一次的读数,比 `false` 有用。
 * 没有上限;超时由这条用例的 testTimeout 判红,并在失败原因里点名这一步。
 */
export async function until(step: string, holds: () => boolean): Promise<void>
export async function until<T>(step: string, read: () => T, ok: (value: T) => boolean): Promise<void>
export async function until<T>(step: string, read: () => T, ok?: (value: T) => boolean): Promise<void> {
  const check = ok ?? ((value: T) => value === true)
  const streak = readStreak()
  if (streak && streak.step === step && streak.count >= STREAK_LIMIT) {
    throw new Error(
      `[awaiting-fact] ${step}: ${streak.count} consecutive tests already hit their cap waiting for this step — failing fast instead of waiting out another cap`,
    )
  }
  const test = getCurrentTest()
  reportPendingOnFailure(test)
  const testName = currentTestName()
  const startedAt = realNow()
  let nextBeat = startedAt + HEARTBEAT_MS
  let value = read()
  if (test) pending.set(test, { step, last: value })
  while (!check(value)) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, POLL_MS))
    // 用例已经结束(超时判红了),别让这圈轮询在后面的用例里继续跑。
    if (test?.result?.state && test.result.state !== 'run') throw new Error(`[awaiting-fact] ${step}: test ended while waiting`)
    value = read()
    if (test) pending.set(test, { step, last: value })
    const now = realNow()
    if (now >= nextBeat) {
      console.warn(`[awaiting-fact] ${testName} — ${step}: still pending after ${Math.round((now - startedAt) / 1000)}s, last observed: ${describeValue(value)}`)
      nextBeat = now + HEARTBEAT_MS
    }
  }
  if (test) pending.delete(test)
  if (readStreak()?.step === step) writeStreak(null)
}

/**
 * 读数在**连续 `frames` 个动画帧**里都不变,才算落定。用于没有完成信号的布局收敛(虚拟列表量高、spring 动画)。
 * 按帧不按毫秒:机器越忙帧越慢,按帧只会更保守,不会因为负载误判。一帧里多次轮询只算一次。
 * 有完成事实可等的(回调、DOM 出现、字体)先等那个事实,这里只收尾「几何不再动」。
 */
export async function untilStable<T>(step: string, read: () => T, frames = 5): Promise<void> {
  let frame = 0
  let counting = true
  const tick = () => {
    frame += 1
    if (counting) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  let previousFrame = -1
  let previous = ''
  let stable = 0
  try {
    await until(step, () => {
      if (frame === previousFrame) return false
      previousFrame = frame
      const current = JSON.stringify(read())
      stable = current === previous ? stable + 1 : 0
      previous = current
      return stable >= frames
    })
  } finally {
    counting = false
  }
}
