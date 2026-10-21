/**
 * 本机状态的**进程内**互斥：按 key 串行化（key 沿用原先的锁路径，粒度一字不变）。
 *
 * 为什么锁不再落到磁盘上（#3885 P0）：磁盘锁在进程猝死时会留下残留，而残留没有任何
 * 自然力量能清除 —— 一次 SIGKILL / OOM / 断电，锁目录就永远留在盘上，之后每次拿锁都
 * 只能等到超时报错，那个 profile 就此报废，用户还无从自救。互斥量只活在进程堆内存里
 * 就没有这个问题：进程一死，内核连同它的地址空间一起回收，锁必然随之消失。这不是探测
 * 出来的结论，是内核对进程资源的无条件保证 —— 所以「锁残留」这一整类故障在结构上不
 * 存在，不需要 TTL、不需要持有者探活、不需要启动清扫。
 *
 * ❌ 别把这里改回任何形式的磁盘锁（含「带 PID 和时间戳的锁文件」）：那只是把「永久卡死」
 * 换成「有窗口的卡死 + 误判活锁的新风险」，#3885 明确排除。
 *
 * 只需覆盖进程内的 async 交错：host tick / IPC handler / sessionpage provisioning 会在 await
 * 点交错，而 messages 的序号分配、tasks 的 highwatermark 是真正的 read-modify-write，不
 * 串行会丢更新。读路径本来就不拿锁（一致性靠 atomicWriteText 的 tmp + rename 原子性）。
 *
 * 跨进程互斥不再需要，因为这几处状态的**活写者只剩 Electron main 一个进程**：
 *   - 旧终端栈时代由 agent CLI 直写状态的那条路已随 #1021 删除，capability package 声明 hooks: 'none'；
 *   - guest 注册/激活簇是历史上真正的跨进程写者，#1914 park，全仓零活调用；
 *   - MCP 子进程只写自有文件（唯一文件名 + O_EXCL + rename），从不碰这几个共享 JSON；
 *   - GUGU_HOME 默认在 userData 下，而 main 有 requestSingleInstanceLock，一个 userData
 *     只可能有一个实例。
 * ⚠️ 若哪天要恢复「另一个 OS 进程也写这几个文件」，不能退回磁盘锁，而应让那个进程走
 * host IPC / 邮箱 —— 仓库既有协议就是这么定的（outbox、command-context 全是「子进程只
 * 写自有文件」的单写者设计）。
 */

/** key → 该 key 上最后一个排队者的完成 promise。空 Map = 全部空闲。 */
const chains = new Map<string, Promise<void>>()

/**
 * 等锁的上限。它**不**用来对付「持有者死了」——那种情况在本实现里不可能留下锁；它只兜
 * 「持有者忘了 release」这一类进程内编码错误，让它当场响亮失败而不是无声挂起。沿用原
 * 磁盘锁同量级（~2s）与同样的报错文案，调用方（如 guestRegistration 的超时兜底分支）
 * 的既有语义不变。
 */
const WAIT_TIMEOUT_MS = 2_000

export async function acquireStateLock(
  lockKey: string,
  label: string
): Promise<() => Promise<void>> {
  const previous = chains.get(lockKey) ?? Promise.resolve()
  let releaseHeld!: () => void
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  const chained = previous.then(() => held)
  chains.set(lockKey, chained)
  // 队尾自清：轮到我且身后无人时把 key 收掉，否则 Map 会随路径数量单向增长。
  void chained.then(
    () => {
      if (chains.get(lockKey) === chained) chains.delete(lockKey)
    },
    () => {
      if (chains.get(lockKey) === chained) chains.delete(lockKey)
    }
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} lock`)), WAIT_TIMEOUT_MS)
      })
    ])
  } catch (error) {
    // 没等到就走人：立刻让出自己这一格，否则排在我身后的人会被我这个永不兑现的占位堵死
    // —— 那就等于在进程内重造了一个死锁。
    releaseHeld()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    releaseHeld()
  }
}
