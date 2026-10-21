import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRegistry,
  CodexAppServerSession,
  codexThreadConfigProcessArgs,
  codexTuiPermissionArgs,
  codexTuiThreadSettingsArgs,
  CodexSessionClosedError,
  codexPlainThreadStartedId,
  codexForkStartedEvent,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'

/**
 * @@@6112 新会话改成让 TUI 自己建 thread,于是两件事必须被钉住:
 *   ① 本来挂在 `thread/start` 上的配置,翻成 app-server **进程级** `-c` 时一格都不许丢;
 *   ② 广播里哪一条才是「TUI 刚建的那条」—— 认错了就会把产品会话的活动 thread 顶掉。
 */
describe('@@@6112 线程配置搬去进程级 -c', () => {
  it('developerInstructions 进 developer_instructions,字符串按 TOML 基本串编码', () => {
    const args = codexThreadConfigProcessArgs({ developerInstructions: 'hi "there"\nsecond line' })
    expect(args).toEqual(['-c', 'developer_instructions="hi \\"there\\"\\nsecond line"'])
  })

  it('空白的 developerInstructions 不下发(❌ 不下发一个空串把用户的配置盖掉)', () => {
    expect(codexThreadConfigProcessArgs({ developerInstructions: '   ' })).toEqual([])
    expect(codexThreadConfigProcessArgs({})).toEqual([])
  })

  it('threadConfig 的 dotted-path 原样带过去,数组用 TOML 数组写法', () => {
    const args = codexThreadConfigProcessArgs({
      threadConfig: {
        'mcp_servers.gugu.command': '/usr/bin/node',
        'mcp_servers.gugu.args': ['server.mjs', '--port', '0'],
        'mcp_servers.gugu.enabled': false,
        notify: ['/bin/echo', 'hi'],
      },
    })
    expect(args).toEqual([
      '-c', 'mcp_servers.gugu.command="/usr/bin/node"',
      '-c', 'mcp_servers.gugu.args=["server.mjs","--port","0"]',
      '-c', 'mcp_servers.gugu.enabled=false',
      '-c', 'notify=["/bin/echo","hi"]',
    ])
  })

  it('null / undefined 的值整格跳过', () => {
    expect(codexThreadConfigProcessArgs({
      threadConfig: { a: null, b: undefined, c: 'kept' },
    })).toEqual(['-c', 'c="kept"'])
  })

  /**
   * TUI **新建**的 thread 不吃进程级那份(实测落成 on-request + workspaceWrite,full-access 被悄悄换掉),
   * 权限由建 thread 的 TUI 带 —— 见 codexTuiPermissionArgs。
   */
  it('权限映到 TUI 自己的 -a / -s', () => {
    expect(codexTuiPermissionArgs({ approvalPolicy: 'never', sandbox: 'danger-full-access' }))
      .toEqual(['-a', 'never', '-s', 'danger-full-access'])
    expect(codexTuiPermissionArgs({ approvalPolicy: 'on-request', sandbox: undefined }))
      .toEqual(['-a', 'on-request'])
    expect(codexTuiPermissionArgs(undefined)).toEqual([])
  })

  /**
   * 这条是本文件存在的理由:`-c` 的右半边**解析不成 TOML 就当裸字符串收下**,所以一个 JSON
   * 对象写法(`{"a":1}`,不是 TOML 内联表 `{a = 1}`)会被静默收成一个字符串字面量 ——
   * 不报错、不生效,和「没配」长得一模一样。必须在翻译这一步就炸。
   */
  it('嵌套对象 THROW —— ❌ 不许静默降级成字符串字面量', () => {
    expect(() => codexThreadConfigProcessArgs({
      threadConfig: { 'mcp_servers.gugu': { command: 'node' } },
    })).toThrow(/只支持标量与标量数组/)
    expect(() => codexThreadConfigProcessArgs({
      threadConfig: { 'mcp_servers.gugu.args': [{ nested: true }] },
    })).toThrow(/只支持标量与标量数组/)
  })

  /** resume 载入的 thread:sandbox 不随 thread 落盘,换进程载入时取进程级默认 ⇒ 这一份必须在。 */
  it('权限也进进程级 -c(管 TUI resume 载入的 thread)', () => {
    expect(codexThreadConfigProcessArgs({
      threadStart: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
    })).toEqual([
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
    ])
    expect(() => codexThreadConfigProcessArgs({ threadStart: { somethingNew: 'x' } }))
      .toThrow(/没有对应的进程级配置键/)
  })

  it('认不出的权限参数、或非字符串值 THROW —— 丢掉它等于悄悄换掉这条会话的权限档', () => {
    expect(() => codexTuiPermissionArgs({ somethingNew: 'x' })).toThrow(/没有对应的 TUI 启动参数/)
    expect(() => codexTuiPermissionArgs({ sandbox: { type: 'readOnly' } })).toThrow(/不是非空字符串/)
  })
})

describe('@@@6112 认领 TUI 建出来的那条 thread', () => {
  const started = (thread: Record<string, unknown>) => ({
    method: 'thread/started',
    params: { thread },
  })

  it('两个血缘字段都空 = TUI 刚建的那条', () => {
    expect(codexPlainThreadStartedId(started({ id: 'tid-1' }))).toBe('tid-1')
    expect(codexPlainThreadStartedId(started({
      id: 'tid-1', forkedFromId: null, parentThreadId: null,
    }))).toBe('tid-1')
  })

  it('rewind 派生出来的分支不算(那条归 codexForkStartedEvent 管)', () => {
    const fork = started({ id: 'child', forkedFromId: 'parent' })
    expect(codexPlainThreadStartedId(fork)).toBeNull()
    expect(codexForkStartedEvent(fork)?.threadId).toBe('child')
  })

  it('subagent 不算 —— 它的 parentThreadId 是归属边,永远不许顶替活动 thread', () => {
    expect(codexPlainThreadStartedId(started({ id: 'sub', parentThreadId: 'owner' }))).toBeNull()
    expect(codexPlainThreadStartedId(started({ id: 'sub', parent_thread_id: 'owner' }))).toBeNull()
  })

  it('不是 thread/started、或没有 id 的,一律不认', () => {
    expect(codexPlainThreadStartedId({ method: 'turn/started', params: { thread: { id: 'x' } } })).toBeNull()
    expect(codexPlainThreadStartedId(started({}))).toBeNull()
    expect(codexPlainThreadStartedId({ method: 'thread/started', params: {} })).toBeNull()
  })
})

describe('@@@6112 咕咕按序接入 TUI 建的 thread', () => {
  type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>
  const thread = (turns: Array<{ id: string; status: string }>) => ({ thread: { id: 'tid-6112', turns, model: 'glm-5.3' } })
  const awaiting = (rpc: Rpc, onTurnLifecycle?: (l: unknown) => void) => {
    const session = new CodexAppServerSession('agent-6112', '/unused/codex', onTurnLifecycle as never)
    Object.assign(session as unknown as Record<string, unknown>, { client: { rpc }, awaitingTuiThread: true, cwd: '/w' })
    const adopt = () => (session as unknown as { adoptTuiThread(m: unknown): boolean })
      .adoptTuiThread({ method: 'thread/started', params: { thread: { id: 'tid-6112' } } })
    return { session, adopt }
  }
  const deferred = () => {
    let resolve!: (v: unknown) => void
    const promise = new Promise<unknown>((r) => { resolve = r })
    return { promise, resolve }
  }

  /** 顺序本身就是保证:resume 只认磁盘,section/move 在返回前写盘 —— 反过来 resume 必然 no rollout found。 */
  it('先 section/move(null) 写盘,它返回之后才 resume;两步都返回了才放行等待方', async () => {
    const calls: Array<[string, unknown]> = []
    const move = deferred()
    const { session, adopt } = awaiting(async (method, params) => {
      calls.push([method, params])
      if (method === 'thread/section/move') return move.promise
      return thread([])
    })
    const ready = session.waitForTuiThread()
    let resolved = false
    void ready.then(() => { resolved = true })
    expect(adopt()).toBe(true)
    await Promise.resolve()
    expect(calls).toEqual([['thread/section/move', { threadId: 'tid-6112', sectionId: null }]])
    expect(resolved).toBe(false)
    move.resolve({})
    await expect(ready).resolves.toBe('tid-6112')
    // ❌ resume 不带任何 config:带 override 的 resume 对空闲线程会走「关停 + 冷启」
    expect(calls).toEqual([
      ['thread/section/move', { threadId: 'tid-6112', sectionId: null }],
      ['thread/resume', { threadId: 'tid-6112' }],
      // 日后重拉 TUI(resume)要钉住的模型,读 thread 自己存的那份
      ['thread/read', { threadId: 'tid-6112', includeTurns: false }],
    ])
  })

  /** 官方给外部程序往会话送消息的路是 codex 队列:服务端在 thread 空闲时起轮,❌ 咕咕不 turn/start。 */
  it('接入完成之前的投递直接进 codex 队列(不读、不起轮);接入之后空闲也进队列', async () => {
    const calls: string[] = []
    let queued = 0
    const resume = deferred()
    const { session, adopt } = awaiting(async (method) => {
      calls.push(method)
      if (method === 'thread/resume') return resume.promise
      if (method === 'thread/queue/add') return { queuedSubmission: { id: `q-${++queued}` } }
      if (method === 'thread/read') return thread([])
      return {}
    })
    adopt()
    // 接入与这条早到的投递是并发的,只断言要守的:接入前 ❌ 读、❌ 起轮。
    await expect(session.deliver('early')).resolves.toMatchObject({ turnId: 'q-1', queued: true })
    expect(calls).not.toContain('thread/read')
    resume.resolve(thread([]))
    await session.waitForTuiThread()
    const before = calls.length
    await expect(session.deliver('later')).resolves.toMatchObject({ turnId: 'q-2', queued: true })
    // 接入之后:入队后显式起咕咕自己这一条(上一轮若被中断,队列不会自己续跑)
    expect(calls.slice(before)).toEqual(['thread/read', 'thread/queue/add', 'thread/queue/start'])
    expect(calls).not.toContain('turn/start')
  })

  it('接入之后若有轮在跑 → turn/steer 插进去(owner #85),❌ 不排队', async () => {
    const calls: Array<[string, unknown]> = []
    const { session, adopt } = awaiting(async (method, params) => {
      calls.push([method, params])
      if (method === 'thread/read') return thread([{ id: 'turn-live', status: 'inProgress' }])
      return method === 'thread/resume' ? thread([]) : {}
    })
    const ready = session.waitForTuiThread()
    adopt()
    await ready
    await expect(session.deliver('mid-turn')).resolves.toEqual({ turnId: 'turn-live' })
    expect(calls.at(-1)?.[0]).toBe('turn/steer')
    expect(calls.map(([m]) => m)).not.toContain('thread/queue/add')
  })

  it('任何一步失败 → 等待方与投递都 fail-loud,❌ 不降级成「没接入也照投」', async () => {
    const { session, adopt } = awaiting(async (method) => {
      if (method === 'thread/section/move') throw new Error('move refused')
      return {}
    })
    const ready = session.waitForTuiThread()
    adopt()
    await expect(ready).rejects.toThrow('move refused')
    await expect(session.deliver('hi')).rejects.toThrow('move refused')
  })

  it('resume 的返回显示已有回合在跑(用户在 TUI 里抢先敲了一句)→ 记一次 start', async () => {
    const lifecycle: unknown[] = []
    const { session, adopt } = awaiting(
      async (method) => (method === 'thread/resume'
        ? thread([{ id: 'turn-tui', status: 'inProgress' }])
        : method === 'thread/read' ? thread([]) : {}),
      (l) => lifecycle.push(l),
    )
    const ready = session.waitForTuiThread()
    adopt()
    await ready
    const tracker = (session as unknown as { turnCompletions: { activeTurnIdsSnapshot(): string[] } }).turnCompletions
    expect(tracker.activeTurnIdsSnapshot()).toEqual(['turn-tui'])
    expect(lifecycle).toEqual([{ type: 'start' }])
  })
})

describe('@@@6112 重新打开:由 TUI resume 载入,咕咕等官方载入广播再接入', () => {
  const resumed = (rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
    const session = new CodexAppServerSession('agent-reopen', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      client: { rpc }, threadId: 'tid-old', adoptedFromTui: true, awaitingTuiLoad: true,
      threadMaterialization: 'materialized', cwd: '/w',
    })
    const broadcast = (message: unknown) =>
      (session as unknown as { observeTuiLoadedThread(m: unknown): void }).observeTuiLoadedThread(message)
    return { session, broadcast }
  }

  it('载入广播之前的投递进队列(服务端在 TUI 载入后才起轮);❌ 咕咕不先 resume', async () => {
    const calls: string[] = []
    const { session } = resumed(async (method) => {
      calls.push(method)
      return method === 'thread/queue/add' ? { queuedSubmission: { id: 'q-1' } } : {}
    })
    await expect(session.deliver('before load')).resolves.toMatchObject({ turnId: 'q-1', queued: true })
    expect(calls).toEqual(['thread/queue/add'])
  })

  it('只认本 thread 的 thread/status/changed;接入 = resume(❌ 不再 section/move,它本就在盘上)', async () => {
    const calls: Array<[string, unknown]> = []
    const { session, broadcast } = resumed(async (method, params) => {
      calls.push([method, params])
      return { thread: { id: 'tid-old', turns: [] } }
    })
    broadcast({ method: 'thread/status/changed', params: { threadId: 'other', status: { type: 'idle' } } })
    broadcast({ method: 'turn/started', params: { threadId: 'tid-old' } })
    expect(calls).toEqual([])
    broadcast({ method: 'thread/status/changed', params: { threadId: 'tid-old', status: { type: 'idle' } } })
    await session.waitForTuiThread()
    expect(calls).toEqual([['thread/resume', { threadId: 'tid-old' }]])
  })
})

describe('@@@6112 TUI resume 载入时钉住 thread 自己的模型(❌ 被 TUI 配置里的默认模型顶掉)', () => {
  it('thread/read 的模型 / 推理强度翻成 TUI 的 -c', () => {
    expect(codexTuiThreadSettingsArgs({ model: 'glm-5.3', reasoningEffort: 'xhigh' }))
      .toEqual(['-c', 'model="glm-5.3"', '-c', 'model_reasoning_effort="xhigh"'])
    expect(codexTuiThreadSettingsArgs({ model: 'glm-5.3', reasoningEffort: null })).toEqual(['-c', 'model="glm-5.3"'])
  })

  it('会话记录指定了模型(换模型重开 / 咕咕模型)→ 钉指定的,❌ 不钉 thread 里存的旧模型', () => {
    // 2026-09-23 实测:自己的 gpt-5.6-luna → 咕咕 GLM 5.3 Flash,钉旧模型的 TUI 下一轮 stream disconnected。
    expect(codexTuiThreadSettingsArgs(
      { model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      { model: 'glm-5.3-flash', reasoningEffort: null },
    )).toEqual(['-c', 'model="glm-5.3-flash"'])
    expect(codexTuiThreadSettingsArgs(
      { model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      { model: 'glm-5.3-flash', reasoningEffort: 'low' },
    )).toEqual(['-c', 'model="glm-5.3-flash"', '-c', 'model_reasoning_effort="low"'])
    // 指定为空 = 没指定,仍钉 thread 自己的
    expect(codexTuiThreadSettingsArgs({ model: 'glm-5.3' }, { model: '  ' })).toEqual(['-c', 'model="glm-5.3"'])
    // 指定了模型时 thread 读不到模型也不必 THROW —— 钉的是指定的那个
    expect(codexTuiThreadSettingsArgs({}, { model: 'glm-5.3-flash' })).toEqual(['-c', 'model="glm-5.3-flash"'])
  })

  it('顶栏换「思考」档位重开 → 钉记录里的档位;记录里清掉了 = 回默认,❌ 不拿 thread 的旧档位补', () => {
    // 记录没有模型(harness 默认)时模型仍钉 thread 的,档位听记录
    expect(codexTuiThreadSettingsArgs({ model: 'gpt-5.6', reasoningEffort: 'low' }, { reasoningEffort: 'high' }))
      .toEqual(['-c', 'model="gpt-5.6"', '-c', 'model_reasoning_effort="high"'])
    // 记录指定了模型、档位复位 ⇒ 不钉档位,由 harness 默认
    expect(codexTuiThreadSettingsArgs({ model: 'gpt-5.6', reasoningEffort: 'high' }, { model: 'gpt-5.6', reasoningEffort: null }))
      .toEqual(['-c', 'model="gpt-5.6"'])
  })

  it('读不到模型 THROW —— 缺了它 TUI 会把会话换到用户的默认模型', () => {
    expect(() => codexTuiThreadSettingsArgs({})).toThrow(/模型/)
    expect(() => codexTuiThreadSettingsArgs({ model: ' ' })).toThrow(/模型/)
  })

  it('resume 的 TUI argv 带上这份 -c,在 thread id 之前', () => {
    const session = new CodexAppServerSession('agent-resume', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      threadId: 'tid-old',
      endpoint: { kind: 'unix', address: 'unix:///tmp/x.sock', socketPath: '/tmp/x.sock' },
      tuiResumeArgs: codexTuiThreadSettingsArgs({ model: 'glm-5.3' }),
    })
    const args = session.remoteTuiArgs()
    expect(args.slice(args.indexOf('resume'))).toEqual(['resume', '-c', 'model="glm-5.3"', 'tid-old', '-c', 'check_for_update_on_startup=false'])
  })
})

describe('@@@6112 等 TUI 建会话:❌ 不计时,只认客观信号', () => {
  const awaiting = () => {
    const session = new CodexAppServerSession('agent-trust', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, { awaitingTuiThread: true })
    return session
  }

  it('用户迟迟不答「信任目录」也不判失败(实测 Windows 新目录:60 秒超时把首轮判死、还拆了 app-server)', async () => {
    vi.useFakeTimers()
    try {
      const session = awaiting()
      let settled = false
      session.waitForTuiThread().then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(settled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('会话被关掉 → 等待方 fail-loud', async () => {
    const session = awaiting()
    const waiting = session.waitForTuiThread()
    void session.dispose().catch(() => undefined)
    await expect(waiting).rejects.toBeInstanceOf(CodexSessionClosedError)
  })
})

describe('@@@6112 排队投递:成败跟到它真正起成的那一轮(PR #6294 review)', () => {
  type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>
  const attached = (rpc: Rpc) => {
    const session = new CodexAppServerSession('agent-q', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      client: { rpc }, threadId: 'tid-q', threadMaterialization: 'materialized', cwd: '/w',
    })
    const internals = session as unknown as {
      observeQueuedDispatch(m: unknown): void
      resumeQueuedDeliveriesAfterInterrupt(): void
    }
    return { session, internals }
  }
  const idle = { thread: { id: 'tid-q', turns: [] } }

  it('起轮以 item/started 的 userMessage.clientId 认领 —— 认到的是 codex 真正起的那一轮', async () => {
    let clientUserMessageId = ''
    const { session, internals } = attached(async (method, params) => {
      if (method === 'thread/read') return idle
      if (method === 'thread/queue/add') {
        clientUserMessageId = String(params?.clientUserMessageId)
        return { queuedSubmission: { id: 'sub-1' } }
      }
      return {}
    })
    const ref = await session.deliver('from another agent')
    expect(ref).toMatchObject({ turnId: 'sub-1', queued: true })
    let dispatchedTurn: string | undefined
    void ref.dispatched!.then((turnId) => { dispatchedTurn = turnId })
    // 别人的 userMessage 不认
    internals.observeQueuedDispatch({ method: 'item/started', params: { threadId: 'tid-q', turnId: 'turn-other', item: { type: 'userMessage', clientId: 'someone-else' } } })
    await Promise.resolve()
    expect(dispatchedTurn).toBeUndefined()
    internals.observeQueuedDispatch({ method: 'item/started', params: { threadId: 'tid-q', turnId: 'turn-mine', item: { type: 'userMessage', clientId: clientUserMessageId } } })
    await expect(ref.dispatched).resolves.toBe('turn-mine')
  })

  it('上一轮被中断 → 队列停住;咕咕只把自己那一条起起来(thread/queue/start)', async () => {
    const starts: unknown[] = []
    let firstStart = true
    const { session, internals } = attached(async (method, params) => {
      if (method === 'thread/read') return idle
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'sub-2' } }
      if (method === 'thread/queue/start') {
        starts.push(params?.queuedSubmissionId)
        if (firstStart) { firstStart = false; throw new Error('thread already has an active or pending turn') }
        return { turn: { id: 'turn-resumed' } }
      }
      // 那一刻它还在队列里 —— 排在正在跑的那一轮之后
      if (method === 'thread/queue/list') return { data: [{ id: 'sub-2' }] }
      return {}
    })
    await session.deliver('queued behind a user turn')
    expect(starts).toEqual(['sub-2'])
    internals.resumeQueuedDeliveriesAfterInterrupt()
    await Promise.resolve(); await Promise.resolve()
    expect(starts).toEqual(['sub-2', 'sub-2'])
  })

  it('起不起来且它还在队列里、又不是「已有轮」的拒绝 → THROW', async () => {
    const { session } = attached(async (method) => {
      if (method === 'thread/read') return idle
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'sub-3' } }
      if (method === 'thread/queue/start') throw new Error('queue is on fire')
      if (method === 'thread/queue/list') return { data: [{ id: 'sub-3' }] }
      return {}
    })
    await expect(session.deliver('x')).rejects.toThrow('queue is on fire')
  })

  it('会话关闭 → 还没起轮的排队条目 reject(CodexSessionClosedError)', async () => {
    const { session } = attached(async (method) => {
      if (method === 'thread/read') return idle
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'sub-4' } }
      return {}
    })
    const ref = await session.deliver('never dispatched')
    void session.dispose().catch(() => undefined)
    await expect(ref.dispatched).rejects.toBeInstanceOf(CodexSessionClosedError)
  })
})

describe('@@@6112 TUI 建的会话日后重拉 TUI 也钉住模型(PR #6294 review)', () => {
  it('接入时读出的 thread 模型进 resume 的 TUI argv', async () => {
    const session = new CodexAppServerSession('agent-respawn', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      client: { rpc: async (method: string) => (method === 'thread/read' ? { thread: { id: 'tid-r', model: 'glm-5.3' } } : { thread: { id: 'tid-r', turns: [] } }) },
      awaitingTuiThread: true,
      cwd: '/w',
      endpoint: { kind: 'unix', address: 'unix:///tmp/x.sock', socketPath: '/tmp/x.sock' },
    })
    ;(session as unknown as { adoptTuiThread(m: unknown): boolean })
      .adoptTuiThread({ method: 'thread/started', params: { thread: { id: 'tid-r' } } })
    await session.waitForTuiThread()
    const args = session.remoteTuiArgs()
    expect(args.slice(args.indexOf('resume'))).toEqual(['resume', '-c', 'model="glm-5.3"', 'tid-r', '-c', 'check_for_update_on_startup=false'])
  })

  it('TUI 还没建出会话 → isAwaitingTuiThread(重拉 TUI 复用这台 app-server 的判据)', () => {
    const session = new CodexAppServerSession('agent-wait', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      client: { rpc: async () => ({}) }, awaitingTuiThread: true, liveAwaitsAttach: true, proc: { exitCode: null },
    })
    expect(session.isAwaitingTuiThread()).toBe(true)
    Object.assign(session as unknown as Record<string, unknown>, { proc: { exitCode: 1 } })
    expect(session.isAwaitingTuiThread()).toBe(false)
  })
})

describe('@@@6112 新会话的权限由建 thread 的 TUI 带', () => {
  it('create 模式的 TUI argv 带 -a / -s,且在 --remote 之前(TUI 的根级参数)', () => {
    const session = new CodexAppServerSession('agent-perm', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      awaitingTuiThread: true,
      cwd: '/w',
      endpoint: { kind: 'unix', address: 'unix:///tmp/x.sock', socketPath: '/tmp/x.sock' },
      tuiPermissionArgs: codexTuiPermissionArgs({ approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    })
    const args = session.remoteTuiArgs()
    expect(args).toEqual(expect.arrayContaining(['-a', 'never', '-s', 'danger-full-access']))
    expect(args.indexOf('-a')).toBeLessThan(args.indexOf('--remote'))
    expect(args).not.toContain('resume')
  })
})

describe('@@@6112 session-live 的产地:threadId 到位的那一刻(registry 自己发)', () => {
  const makeSession = (fields: Record<string, unknown>) => {
    const session = new CodexAppServerSession('agent-live', '/unused/codex', undefined, { sessionId: 'conv-live' })
    Object.assign(session as unknown as Record<string, unknown>, {
      client: { rpc: async () => ({ thread: { id: 'tid-live', turns: [], model: 'glm-5.3' } }) },
      ...fields,
    })
    return session
  }

  it('登记时 threadId 已在(重新打开 / 分叉)→ 立即 onLive', () => {
    const registry = new CodexAppServerRegistry()
    const live: unknown[] = []
    registry.setLiveHooks({ onLive: (reg) => live.push(reg) })
    registry.register('agent-live', makeSession({ threadId: 'tid-live' }), 'codex')
    expect(live).toEqual([{ guguAgentUserId: 'agent-live', sessionId: 'conv-live' }])
  })

  /** 实测:就绪信号若早于 threadId 到位,那一脚空拉后不再重来,session_spawn 的首句一直躺在收件箱。 */
  it('新会话登记时还没有 threadId → 不发;TUI 建出 thread、咕咕接入完成才发', async () => {
    const registry = new CodexAppServerRegistry()
    const live: unknown[] = []
    registry.setLiveHooks({ onLive: (reg) => live.push(reg) })
    const session = makeSession({ awaitingTuiThread: true })
    registry.register('agent-live', session, 'codex')
    expect(live).toEqual([])
    // #6531 认领从登记起就在(否则本机有一段无属主窗口);可投递另看 sessionIdForConversation
    expect(registry.liveSessionIdByAgent('agent-live')).toBe('conv-live')
    expect(registry.deliveryKeyForSession('conv-live')).toBeNull()
    ;(session as unknown as { adoptTuiThread(m: unknown): boolean })
      .adoptTuiThread({ method: 'thread/started', params: { thread: { id: 'tid-live' } } })
    // 认领了、还没接入完:❌ 不发 —— 否则收件箱的消息会排到用户第一句前面
    expect(live).toEqual([])
    await session.waitForTuiThread()
    expect(registry.liveSessionIdByAgent('agent-live')).toBe('conv-live')
    expect(live).toEqual([{ guguAgentUserId: 'agent-live', sessionId: 'conv-live' }])
  })

  it('登记已被替换 → 旧会话的 threadId 到位不再发', () => {
    const registry = new CodexAppServerRegistry()
    const live: unknown[] = []
    registry.setLiveHooks({ onLive: (reg) => live.push(reg) })
    const stale = makeSession({ awaitingTuiThread: true })
    registry.register('agent-live', stale, 'codex')
    registry.register('agent-live', makeSession({ threadId: 'tid-new' }), 'codex')
    live.length = 0
    ;(stale as unknown as { adoptTuiThread(m: unknown): boolean })
      .adoptTuiThread({ method: 'thread/started', params: { thread: { id: 'tid-stale' } } })
    expect(live).toEqual([])
  })
})
