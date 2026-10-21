// #7199 电脑控制的「正在操作 · 停止」小条与人接管 —— 按 App 算(owner 10-15:「不接管电脑,只接管这个 App」):
// agent 动哪个 App,小条就写哪个 App;没指定 App 的动作是「查看这台电脑」,不把亮着的 App 盖掉;做完半分钟收起。
// 「停止」只停小条上那个 App:它在途的一下被撤、之后再动它一律拒,直到「让它继续」;别的 App 照常。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_STOPPED, appStopped, createComputerControl } from '../../../../apps/desktop/electron/device-actions/computer-control'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-15T08:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const views: string[] = []
  const view = {
    show: vi.fn((v: { state: string; callerName?: string; app?: { name?: string } }) => {
      views.push(`${v.state}:${v.callerName ?? ''}:${v.app ? (v.app.name ?? '?') : '-'}`)
    }),
    hide: vi.fn(() => { views.push('hide') }),
  }
  const control = createComputerControl({ view, lingerMs: 30_000 })
  return { control, views }
}

const calc = { callerName: '云端助理', pid: 77, appName: '计算器' }
const notes = { callerName: '云端助理', pid: 88, appName: '备忘录' }
const look = { callerName: '云端助理' }

function begun(handle: ReturnType<ReturnType<typeof createComputerControl>['begin']>) {
  if ('refused' in handle) throw new Error(`refused: ${handle.refused}`)
  return handle
}

describe('小条', () => {
  it('写 agent 正在操作的那个 App;只是查看电脑(没指定 App)不把它盖掉;做完半分钟没有下一个才收起', () => {
    const { control, views } = setup()
    begun(control.begin(look)).end()
    expect(views).toEqual(['driving:云端助理:-'])
    const a = begun(control.begin(calc))
    expect(views.at(-1)).toBe('driving:云端助理:计算器')
    const b = begun(control.begin(look))
    expect(views.at(-1)).toBe('driving:云端助理:计算器')
    a.end()
    b.end()
    vi.advanceTimersByTime(29_000)
    expect(views.at(-1)).toBe('driving:云端助理:计算器')
    vi.advanceTimersByTime(2_000)
    expect(views.at(-1)).toBe('hide')
  })

  it('认不出名字的 App 也照样单独算(小条上写「某个 App」由窗口那层决定)', () => {
    const { control, views } = setup()
    begun(control.begin({ pid: 99 })).end()
    expect(views.at(-1)).toBe('driving::?')
  })
})

describe('停止只停这个 App', () => {
  it('在途的那一下被撤(reason 是给 agent 的话);之后再动它一律拒;别的 App 照常;「让它继续」后恢复', () => {
    const { control, views } = setup()
    const inCalc = begun(control.begin(calc))
    control.stop()
    expect(inCalc.signal.aborted).toBe(true)
    expect(inCalc.signal.reason).toBe(appStopped('计算器'))
    expect(views.at(-1)).toBe('paused:云端助理:计算器')
    inCalc.end()

    expect(control.begin(calc)).toEqual({ refused: appStopped('计算器') })
    // 只看计算器也不行:人把它接过去了。
    expect(control.begin({ pid: 77 })).toEqual({ refused: appStopped('计算器') })
    // 别的 App、只是查看电脑:照常。
    const inNotes = begun(control.begin(notes))
    expect(inNotes.signal.aborted).toBe(false)
    expect(views.at(-1)).toBe('driving:云端助理:备忘录')
    inNotes.end()
    begun(control.begin(look)).end()
    expect(views.at(-1)).toBe('driving:云端助理:备忘录')

    // agent 又去动计算器:暂停的小条重新亮出来,人点「让它继续」。
    expect('refused' in control.begin(calc)).toBe(true)
    expect(views.at(-1)).toBe('paused:云端助理:计算器')
    control.resume()
    expect(views.at(-1)).toBe('hide')
    begun(control.begin(calc)).end()
  })

  it('停下之后 agent 接着只是查看电脑:暂停的条留着(「让它继续」点得到),❌ 换成「正在查看这台电脑 · 停止」', () => {
    const { control, views } = setup()
    begun(control.begin(calc))
    control.stop()
    begun(control.begin(look)).end()
    expect(views.at(-1)).toBe('paused:云端助理:计算器')
    control.resume()
    begun(control.begin(calc)).end()
  })

  it('停计算器不撤备忘录上在途的动作', () => {
    const { control } = setup()
    const inNotes = begun(control.begin(notes))
    const inCalc = begun(control.begin(calc))
    control.stop()
    expect(inCalc.signal.aborted).toBe(true)
    expect(inNotes.signal.aborted).toBe(false)
  })

  it('小条上是「查看这台电脑」时按停止 = 整个电脑控制停下,直到「让它继续」', () => {
    const { control, views } = setup()
    const looking = begun(control.begin(look))
    control.stop()
    expect(looking.signal.reason).toBe(COMPUTER_STOPPED)
    expect(views.at(-1)).toBe('paused:云端助理:-')
    expect(control.begin(calc)).toEqual({ refused: COMPUTER_STOPPED })
    expect(control.begin(look)).toEqual({ refused: COMPUTER_STOPPED })
    control.resume()
    begun(control.begin(calc)).end()
  })

  it('暂停的小条两分钟后收起;agent 再来动那个 App 时重新亮出来', () => {
    const { control, views } = setup()
    begun(control.begin(calc))
    control.stop()
    vi.advanceTimersByTime(2 * 60_000 + 1)
    expect(views.at(-1)).toBe('hide')
    expect(control.begin(calc)).toEqual({ refused: appStopped('计算器') })
    expect(views.at(-1)).toBe('paused:云端助理:计算器')
  })

  it('人照常用电脑不打断它:没有人按停止,多个 App 来回操作都放行', () => {
    const { control } = setup()
    for (let i = 0; i < 20; i++) {
      const h = begun(control.begin(i % 2 ? calc : notes))
      expect(h.signal.aborted).toBe(false)
      h.end()
    }
  })
})
