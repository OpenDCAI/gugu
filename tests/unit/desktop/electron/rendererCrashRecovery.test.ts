import { describe, expect, it } from 'vitest'
import {
  RENDERER_CRASH_LIMIT,
  RENDERER_CRASH_WINDOW_MS,
  createMainRendererGoneHandler,
  decideRendererGone,
  type CrashDialogChoice,
} from '../../../../apps/desktop/electron/renderer-crash-recovery'

// 主窗口渲染进程没了:重新载入;几分钟里连着崩到上限就停下来问人;正常收掉的不算崩溃。
describe('主窗口渲染进程没了以后', () => {
  it('崩一次(内存耗尽、被杀、崩溃)就重新载入,并记下这一次', () => {
    for (const reason of ['oom', 'crashed', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure']) {
      const { decision, recent } = decideRendererGone(reason, [], 1_000)
      expect(decision, reason).toBe('reload')
      expect(recent).toEqual([1_000])
    }
  })

  it('正常收掉(clean-exit)不是崩溃:不重新载入,也不算进次数', () => {
    expect(decideRendererGone('clean-exit', [500], 1_000)).toEqual({ decision: 'ignore', recent: [500] })
  })

  it('几分钟里连着崩到上限:不再自动重新载入(❌ 一启动就崩的页面被无限重载成闪烁)', () => {
    let recent: number[] = []
    const decisions: string[] = []
    for (let i = 0; i < RENDERER_CRASH_LIMIT; i++) {
      const out = decideRendererGone('crashed', recent, 10_000 + i * 1_000)
      decisions.push(out.decision)
      recent = out.recent
    }
    expect(decisions).toEqual([...Array(RENDERER_CRASH_LIMIT - 1).fill('reload'), 'give-up'])
  })

  it('窗口期以外的旧崩溃不算「连着」:照常重新载入,时刻表只留这一次', () => {
    const old = [0, 1_000]
    const { decision, recent } = decideRendererGone('oom', old, RENDERER_CRASH_WINDOW_MS + 1_000)
    expect(decision).toBe('reload')
    expect(recent).toEqual([RENDERER_CRASH_WINDOW_MS + 1_000])
  })
})

// main.ts 只注入动作;什么时候重载、什么时候问、问完怎么办,都在这里判
function rig(answer: CrashDialogChoice = 'reload') {
  const calls: string[] = []
  let quitting = false
  let t = 0
  let release: () => void = () => {}
  const deps = {
    isQuitting: () => quitting,
    now: () => t,
    reload: () => calls.push('reload'),
    ask: (count: number) => {
      calls.push(`ask:${count}`)
      return new Promise<CrashDialogChoice>((resolve) => {
        release = () => resolve(answer)
      })
    },
    quit: () => calls.push('quit'),
    log: { error: () => {}, info: () => {} },
  }
  const onGone = createMainRendererGoneHandler(deps)
  return {
    calls,
    onGone,
    tick: (ms: number) => (t += ms),
    startQuitting: () => (quitting = true),
    answer: async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('主窗口渲染进程没了:main.ts 接上的那一层', () => {
  it('应用正在退出:不重载、不问(❌ 退出途中把页面又拉起来)', async () => {
    const r = rig()
    r.startQuitting()
    await r.onGone('killed', 9)
    expect(r.calls).toEqual([])
  })

  it('正常收掉:什么都不做', async () => {
    const r = rig()
    await r.onGone('clean-exit', 0)
    expect(r.calls).toEqual([])
  })

  it('前两次自动重载,第三次停下来问,并告诉它是第几次', async () => {
    const r = rig()
    await r.onGone('oom', 1)
    r.tick(1_000)
    await r.onGone('crashed', 1)
    r.tick(1_000)
    void r.onGone('killed', 9)
    expect(r.calls).toEqual(['reload', 'reload', 'ask:3'])
  })

  it('问了以后选「重新载入」:重载,并清零 —— 下一次崩照常自动重载,❌ 一崩就又问', async () => {
    const r = rig('reload')
    for (let i = 0; i < RENDERER_CRASH_LIMIT - 1; i++) await r.onGone('crashed', 1)
    void r.onGone('crashed', 1)
    await r.answer()
    expect(r.calls.slice(-2)).toEqual(['ask:3', 'reload'])
    // 重载 / 问 都在第一个 await 之前同步发生;❌ await 它 —— 清零坏了时它会挂在一个没人答的对话框上
    void r.onGone('crashed', 1)
    expect(r.calls.at(-1)).toBe('reload')
  })

  it('选「退出咕咕」:退出', async () => {
    const r = rig('quit')
    for (let i = 0; i < RENDERER_CRASH_LIMIT - 1; i++) await r.onGone('crashed', 1)
    void r.onGone('crashed', 1)
    await r.answer()
    expect(r.calls.at(-1)).toBe('quit')
  })

  it('问的时候别处开始退出了(托盘退出、更新重启):对话框是被退出收掉的,❌ 再 quit 一次,❌ 重载', async () => {
    for (const answer of ['quit', 'reload'] as const) {
      const r = rig(answer)
      for (let i = 0; i < RENDERER_CRASH_LIMIT - 1; i++) await r.onGone('crashed', 1)
      void r.onGone('crashed', 1)
      r.startQuitting()
      await r.answer()
      expect(r.calls.at(-1), answer).toBe('ask:3')
    }
  })

  it('窗口已经没了、问不了:什么都不做', async () => {
    const r = rig('no-window')
    for (let i = 0; i < RENDERER_CRASH_LIMIT - 1; i++) await r.onGone('crashed', 1)
    void r.onGone('crashed', 1)
    await r.answer()
    expect(r.calls.at(-1)).toBe('ask:3')
  })
})

