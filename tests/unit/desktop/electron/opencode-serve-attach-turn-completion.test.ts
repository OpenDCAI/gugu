// @@@turn-completion-upper-bound falsifiability — proves a STARTED turn whose backend dies without a
// terminal SSE stops being reported in-flight within the completion budget, instead of pinning the
// authority `running` fact forever. This is the completion-side mirror of the turn-start timeout the
// same transport already has: `session.idle` / `session.error` can be lost (backend silently dies,
// gateway 4xx/5xx with no error frame, dropped stream), so completion needs an upper bound too.
// The negative case (no terminal event) is RED against an unguarded `busy`; the two positive controls
// (idle → resolve, error → reject) prove the criterion is not trivially always-red and that healthy
// turns still converge normally.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cachedFixtureExecutable } from '../../../support/cachedFixtureExecutable'
import http from 'node:http'
import os from 'node:os'
import {
  OpencodeServeSession,
  reserveLoopbackPort,
} from '../../../../apps/desktop/electron/sessionpage/opencode-serve-attach-transport'
import type { TurnLifecycleEdge } from '../../../../apps/desktop/electron/sessionpage/turn-lifecycle-relay'

const SESSION_ID = 'ses_faketest0001'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// A fake `opencode` executable: answers `--version` for the preflight, and in `serve` mode just stays
// alive until killed (the real HTTP/SSE surface is served in-process below, on the same port).
const FAKE_CMD_SRC = `#!/usr/bin/env node
if (process.argv.slice(2).includes('--version')) { process.stdout.write('opencode 1.18.28\\n'); process.exit(0); }
const t = setInterval(() => {}, 1 << 30);
const stop = () => { clearInterval(t); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
`

// @@@4918 fixture 可执行文件按内容寻址复用 —— macOS 对「新建可执行文件的首次 execve」
// 要做一次**全机串行**的安全检查(mac1 实测 ~338ms × 并发数),每跑一次现铸一个就得付一次。
// ⚠️ 下面这段正文必须**逐字稳定**:它就是缓存键。要随用例变的东西走 env 或 cwd,别拼进正文。
// 这段正文全静态,不含 mkdtemp/随机名 —— 直接寻址复用。
function writeFakeCommand(): string {
  return cachedFixtureExecutable('fake-opencode-completion.js', FAKE_CMD_SRC)
}

type FakeServe = {
  port: number
  sessionBodies: string[]
  promptBodies: string[]
  setAgent: (agent: string) => void
  pushBusy: () => void
  pushIdle: () => void
  pushError: (message: string, name?: string) => void
  /** A frame the transport hands back through onSessionTitle — used as an in-order barrier on the stream. */
  pushMarker: (title: string) => void
  /** Flip busy-on-prompt between turns: a backend that started one turn but silently drops the next. */
  setEmitBusy: (value: boolean) => void
  setSessionLookup: (value: 'present' | 'missing' | 'different') => void
  close: () => Promise<void>
}

// A real HTTP/SSE server speaking exactly the opencode-serve surface the transport drives:
// GET /global/health (readiness), POST /session (createSession), GET /event (SSE, held open),
// POST /session/{id}/prompt_async (204). Frames are pushed on command for deterministic control.
async function startFakeServe(port: number, opts: { busyOnPrompt: boolean }): Promise<FakeServe> {
  let sse: http.ServerResponse | null = null
  let emitBusy = opts.busyOnPrompt
  let currentAgent = 'build'
  const sessionBodies: string[] = []
  const promptBodies: string[] = []
  let sessionLookup: 'present' | 'missing' | 'different' = 'present'
  // Frames scheduled before the SSE stream has connected are buffered and flushed on connect, not
  // dropped: connectEventStream() is fire-and-forget, so a +10ms pushBusy can race ahead of the GET
  // /event handler assigning `sse`. Buffering makes frame delivery order-independent (deterministic).
  const pending: string[] = []
  const write = (obj: unknown) => {
    const frame = `data: ${JSON.stringify(obj)}\n\n`
    if (sse) sse.write(frame)
    else pending.push(frame)
  }
  const pushBusy = () =>
    write({ type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'busy' } } })
  const pushIdle = () => write({ type: 'session.idle', properties: { sessionID: SESSION_ID } })
  const pushError = (message: string, name?: string) =>
    write({ type: 'session.error', properties: { sessionID: SESSION_ID, error: { ...(name ? { name } : {}), data: { message } } } })
  const pushMarker = (title: string) => write({ type: 'session.updated', properties: { info: { id: SESSION_ID, title } } })

  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/global/health') { res.statusCode = 200; res.end('ok'); return }
    if (req.method === 'POST' && url === '/session') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        sessionBodies.push(body)
        const parsed = JSON.parse(body) as { agent?: unknown }
        currentAgent = parsed.agent === 'plan' ? 'plan' : 'build'
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: SESSION_ID }))
      })
      return
    }
    if (req.method === 'GET' && url === `/session/${SESSION_ID}`) {
      res.statusCode = sessionLookup === 'missing' ? 404 : 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: sessionLookup === 'different' ? 'ses_other' : SESSION_ID,
        ...(currentAgent === 'build' ? {} : { agent: currentAgent }),
      }))
      return
    }
    if (req.method === 'GET' && url === '/event') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.flushHeaders?.()
      sse = res
      res.write(`data: ${JSON.stringify({ type: 'server.connected' })}\n\n`)
      for (const frame of pending.splice(0)) res.write(frame) // flush anything pushed before connect
      return // keep the stream open
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/prompt_async`) {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        promptBodies.push(body)
        const parsed = JSON.parse(body) as { agent?: unknown }
        if (typeof parsed.agent === 'string' && parsed.agent) currentAgent = parsed.agent
        res.statusCode = 204
        res.end()
        // Turn starts (busy) then — in the RED case — the backend goes silent: no idle, no error, ever.
        if (emitBusy) setTimeout(pushBusy, 10)
      })
      return
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/abort`) { res.statusCode = 200; res.end('{}'); return }
    res.statusCode = 404; res.end()
  })
  // 等 listening 或 error:端口在 reserve 之后被别人占了,listen 只发 EADDRINUSE、回调不来(testTimeout 是 0 ⇒ 无限等)。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    port,
    sessionBodies,
    promptBodies,
    setAgent: (agent: string) => { currentAgent = agent },
    pushBusy,
    pushIdle,
    pushError,
    pushMarker,
    setEmitBusy: (value: boolean) => { emitBusy = value },
    setSessionLookup: (value) => { sessionLookup = value },
    close: () => new Promise<void>((resolve) => {
      try { sse?.end() } catch { /* already closed */ }
      server.close(() => resolve())
    }),
  }
}

describe.skipIf(process.platform === 'win32')('opencode serve turn-completion upper bound', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) { try { await c() } catch { /* best effort */ } }
  })

  async function makeSession(
    completionTimeoutMs: number,
    busyOnPrompt = true,
    onTurnLifecycle?: (lifecycle: TurnLifecycleEdge) => void,
  ) {
    const port = await reserveLoopbackPort()
    const fake = await startFakeServe(port, { busyOnPrompt })
    cleanups.push(() => fake.close())
    const cmd = writeFakeCommand()
    const markers = new Map<string, () => void>()
    const session = new OpencodeServeSession(port, {
      providerId: 'opencode',
      command: cmd,
      cwd: os.tmpdir(),
      env: process.env,
      readyTimeoutMs: 3_000,
      turnStartTimeoutMs: 2_000,
      completionTimeoutMs,
      onTurnLifecycle,
      onSessionTitle: (title) => markers.get(title)?.(),
    })
    cleanups.push(() => session.dispose())
    await session.start(null)
    // The transport consumes /event frames strictly in order. Push a marker frame and wait for the
    // transport to hand it back: every frame pushed before it has then been consumed. This is the
    // fact to wait for before judging "nothing more happened" — ❌ a fixed sleep.
    let markerSeq = 0
    const drain = () => new Promise<void>((resolve) => {
      const title = `drain-marker-${++markerSeq}`
      markers.set(title, resolve)
      fake.pushMarker(title)
    })
    return { session, fake, drain }
  }

  it('admits only the exact native session returned by its real HTTP API', async () => {
    const { session } = await makeSession(300)
    await expect(session.waitUntilReady(SESSION_ID)).resolves.toBeUndefined()
    await expect(session.waitUntilReady('ses_other')).rejects.toThrow('does not match the registered owner')
  })

  it.each(['missing', 'different'] as const)('rejects a healthy serve whose native session is %s', async (lookup) => {
    const { session, fake } = await makeSession(300)
    fake.setSessionLookup(lookup)
    await expect(session.waitUntilReady(SESSION_ID)).rejects.toThrow(
      lookup === 'missing' ? 'lookup returned 404' : 'lookup returned a different session',
    )
  })

  it('settles a started-but-never-terminated turn as errored within the completion budget', async () => {
    const { session } = await makeSession(300)
    const receipt = await session.injectPrompt('hi') // turn starts (busy), then backend goes silent
    expect(session.isTurnInFlight()).toBe(true)
    let rejected: unknown = null
    receipt.completion.catch((e) => { rejected = e })
    await delay(700) // well past the 300ms completion budget
    expect(session.isTurnInFlight()).toBe(false) // in-flight fact MUST have fallen back
    // ⚠️ DO NOT insert an `await` between these two lines. This pair is what makes the WATCHDOG
    // falsifiable: with the timer removed, the line above still reds because the lazy settle in
    // isTurnInFlight() rejects the waiter in a MICROTASK, which the synchronous line below has not
    // yet observed — so `rejected` is still null and this assertion reds too. An await here would
    // flush that microtask, both lines would pass without the watchdog, and a harmless tidy-up would
    // silently delete this coverage.
    expect(rejected).toBeInstanceOf(Error) // and the turn's completion settled as errored
  })

  it('passes provider-native session-create fields to POST /session', async () => {
    const { session, fake } = await makeSession(10_000)
    expect(fake.sessionBodies).toEqual(['{}'])
    session.disposeSync()

    const port = await reserveLoopbackPort()
    const secondFake = await startFakeServe(port, { busyOnPrompt: true })
    cleanups.push(() => secondFake.close())
    const cmd = writeFakeCommand()
    const patched = new OpencodeServeSession(port, {
      providerId: 'opencode',
      command: cmd,
      cwd: os.tmpdir(),
      env: process.env,
      readyTimeoutMs: 3_000,
      turnStartTimeoutMs: 2_000,
      completionTimeoutMs: 10_000,
      sessionCreatePatch: { agent: 'plan' },
    })
    cleanups.push(() => patched.dispose())
    await patched.start(null)
    expect(secondFake.sessionBodies).toEqual([JSON.stringify({ agent: 'plan' })])
    await patched.injectPrompt('hello')
    secondFake.setAgent('build')
    await patched.injectPrompt('after-live-edit')
    expect(secondFake.promptBodies).toEqual([
      JSON.stringify({ agent: 'plan', parts: [{ type: 'text', text: 'hello' }] }),
      JSON.stringify({ agent: 'build', parts: [{ type: 'text', text: 'after-live-edit' }] }),
    ])
    secondFake.setAgent('custom-reviewer')
    await patched.injectPrompt('with-custom-agent')
    expect(secondFake.promptBodies.at(-1)).toBe(
      JSON.stringify({ agent: 'custom-reviewer', parts: [{ type: 'text', text: 'with-custom-agent' }] }),
    )

    // The gate must use the current engine value even when creation had no mode patch. Otherwise
    // an Edit-created session that changes to Plan would omit `agent` and OpenCode would reset it
    // to its default `build` mode on the next prompt.
    const editPort = await reserveLoopbackPort()
    const editFake = await startFakeServe(editPort, { busyOnPrompt: true })
    cleanups.push(() => editFake.close())
    const editSession = new OpencodeServeSession(editPort, {
      providerId: 'opencode',
      command: cmd,
      cwd: os.tmpdir(),
      env: process.env,
      readyTimeoutMs: 3_000,
      turnStartTimeoutMs: 2_000,
      completionTimeoutMs: 10_000,
    })
    cleanups.push(() => editSession.dispose())
    await editSession.start(null)
    editFake.setAgent('plan')
    await editSession.injectPrompt('after-live-plan')
    expect(editFake.promptBodies).toEqual([
      JSON.stringify({ agent: 'plan', parts: [{ type: 'text', text: 'after-live-plan' }] }),
    ])
  })

  it('a mid-turn busy heartbeat does NOT extend the budget (bound is turn-duration, not inter-heartbeat)', async () => {
    // Falsifiability for the record-once fix: the budget is measured from turn START, once. A backend
    // that is alive-but-stuck and keeps re-emitting `session.status busy` must still expire at
    // start+budget — otherwise a refreshed-per-busy bound would never fire for exactly that failure.
    // The session's clock is set by the test, not waited out: how late a real re-busy lands under load
    // would otherwise decide whether the check falls inside the discriminating window. The 60s budget
    // keeps the real watchdog out of this test, so the verdict is the bounded read's own.
    const { session, fake, drain } = await makeSession(60_000)
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const receipt = await session.injectPrompt('hi') // turn starts (busy) at T, budget measured from T
      receipt.completion.catch(() => {})
      now += 30_000      // T+30s, still within budget
      fake.pushBusy()    // a repeated busy on the SAME live turn — must NOT reset busySince
      await drain()      // ...and the transport has consumed it
      now += 30_000      // T+60s, past the budget measured from turn start
      // record-once: over budget at T+60s. refresh-per-busy: busySince reset to T+30s, so only 30s
      // have passed and this still reads in-flight → this assertion goes RED against the refresh behaviour.
      expect(session.isTurnInFlight()).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  it('an over-budget PRIOR turn must not reject the NEW turn\'s completion (waiter-registration order)', async () => {
    // isTurnInFlight() is a SETTLING read: over budget it runs settleOverBudgetTurn() -> markError(),
    // which CLEARS `turnWaiters` and rejects every one of them. So that read has to happen BEFORE this
    // turn registers its own waiter — otherwise the waiter just pushed for the NEW turn is rejected
    // carrying the PREVIOUS turn's error, and the genuinely live turn is left with no waiter at all:
    // `session.idle` arrives and nobody is listening. That is this PR's own defect, taking another route.
    // Wall clock is advanced past the budget while timers do NOT run, which is the device-sleep /
    // starved-event-loop case the lazy settle path in isTurnInFlight() exists for in the first place.
    const { session } = await makeSession(60_000) // real watchdog cannot fire within this test
    const first = await session.injectPrompt('one')
    first.completion.catch(() => {})

    const realNow = Date.now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 61_000)
    let secondRejected: unknown = null
    try {
      const second = await session.injectPrompt('two')
      second.completion.catch((error) => { secondRejected = error })
      await delay(20)
    } finally {
      clock.mockRestore()
    }

    expect(session.isTurnInFlight()).toBe(true) // the new turn is genuinely alive
    expect(secondRejected).toBeNull() // ...so its completion must not already carry the old turn's error
  })

  it('an over-budget prior turn must not let a NEW prompt skip its own turn-start confirmation', async () => {
    // Falsifiability for the third fix in this PR: injectPrompt consults the BOUNDED in-flight fact,
    // not raw `this.busy`. With raw `busy`, a prior turn that is dead-but-still-busy makes wasBusy true,
    // so the new prompt skips awaitBusy() — and a prompt the backend silently dropped gets a SUCCESS
    // receipt, routing around the turn-start guard this transport already had.
    // Setup: turn one starts, wall clock passes the budget while timers do not run, and the backend
    // then stops emitting busy at all. The new prompt must be reported as never started.
    const { session, fake } = await makeSession(60_000)
    const first = await session.injectPrompt('one')
    first.completion.catch(() => {})

    fake.setEmitBusy(false) // backend silently drops the next prompt
    const realNow = Date.now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 61_000)
    try {
      // bounded read settles the dead turn -> wasBusy false -> awaitBusy runs -> honest timeout.
      // raw `this.busy` would read true and resolve with a receipt for a prompt that never started.
      await expect(session.injectPrompt('two')).rejects.toThrow(/no turn started within/)
    } finally {
      clock.mockRestore()
    }
  })

  it('a disposed serve is not in flight — a crash mid-turn must not strand the fact for the whole budget', async () => {
    // Falsifiability for the settleBusy() inside failAllWaiters(). Without it, a serve that has exited
    // leaves `busy` true with `busySince` still inside the budget, so isTurnInFlight() keeps reporting
    // true for a process that no longer exists — up to the full 15 minutes in production, and the sweep
    // projects `running` the whole time. "Spins forever" becoming "spins for fifteen minutes" is the same
    // disease at a different magnitude, not a cure.
    const { session } = await makeSession(60_000)
    const receipt = await session.injectPrompt('hi')
    receipt.completion.catch(() => {})
    expect(session.isTurnInFlight()).toBe(true)

    session.disposeSync() // serve crash / teardown mid-turn

    expect(session.isTurnInFlight()).toBe(false)
  })

  it('a healthy turn emitting session.idle converges immediately (positive control)', async () => {
    const { session, fake } = await makeSession(10_000)
    const receipt = await session.injectPrompt('hi')
    expect(session.isTurnInFlight()).toBe(true)
    fake.pushIdle()
    await receipt.completion // resolves, no timeout
    expect(session.isTurnInFlight()).toBe(false)
  })

  it('a session.error turn settles well before the budget (positive control)', async () => {
    const { session, fake } = await makeSession(10_000)
    const receipt = await session.injectPrompt('hi')
    fake.pushError('backend 502')
    await expect(receipt.completion).rejects.toThrow(/502|error/i)
    expect(session.isTurnInFlight()).toBe(false)
  })

  // #6391 用户 Esc×2 打断:opencode 实测发 `session.error{name:'MessageAbortedError'}` 再发两条 idle。
  // 停下不是失败 ⇒ 对外只发一条 stop,且是被打断的 stop(#6448:不写做完未读);收据仍按被打断 reject。
  it('a user abort publishes a cancelled stop, not error, exactly once', async () => {
    const lifecycles: TurnLifecycleEdge[] = []
    const { session, fake, drain } = await makeSession(10_000, true, (l) => lifecycles.push(l))
    const receipt = await session.injectPrompt('hi')
    fake.pushError('Aborted', 'MessageAbortedError')
    fake.pushIdle()
    fake.pushIdle()
    await expect(receipt.completion).rejects.toThrow(/Aborted/)
    await drain() // both trailing idles consumed: "exactly once" is judged after them
    expect(lifecycles).toEqual([{ type: 'start' }, { type: 'stop', outcome: 'cancelled' }])
    expect(session.isTurnInFlight()).toBe(false)
  })

  it('a genuine turn failure still publishes error (negative control for the abort mapping)', async () => {
    const lifecycles: TurnLifecycleEdge[] = []
    const { session, fake, drain } = await makeSession(10_000, true, (l) => lifecycles.push(l))
    const receipt = await session.injectPrompt('hi')
    fake.pushError('backend 502', 'APIError')
    fake.pushIdle()
    await expect(receipt.completion).rejects.toThrow(/502/)
    await drain() // the trailing idle consumed too
    expect(lifecycles).toEqual([{ type: 'start' }, { type: 'error' }])
  })
})
