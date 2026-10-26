// @vitest-environment jsdom
// #5610 §2.5 埋雷之二:环形缓冲劫持 console.error 时 push() 排在 original() 之前。componentDidCatch 正是经
// console.error 报错的 —— push 一抛,抛的是错误边界,React 卸载整棵树。顺序与隔离两件事一起钉。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installErrorRingBuffer, recentErrors } from '../../../../apps/desktop/src/lib/errorRingBuffer'

// install 是幂等的(模块级 installed 标志),所以钩子只能装一次;原始出口做成可换的 sink。
const sink = vi.fn()
console.error = (...args: unknown[]) => sink(...args)
installErrorRingBuffer()

describe('errorRingBuffer console.error hook', () => {
  beforeEach(() => sink.mockReset())

  it('hands the call to the original console.error first, then records it', () => {
    const lengthWhenOriginalRan: number[] = []
    sink.mockImplementation(() => { lengthWhenOriginalRan.push(recentErrors().length) })
    const before = recentErrors().length
    console.error('plain failure')
    expect(sink).toHaveBeenCalledWith('plain failure')
    expect(lengthWhenOriginalRan).toEqual([before])
    expect(recentErrors().at(-1)?.message).toBe('plain failure')
  })

  it('never lets a recording failure escape to the caller — the original output already went out', () => {
    const poison = { toJSON() { throw new Error('no json') }, toString() { throw new Error('no string') } }
    expect(() => console.error('boundary report', poison)).not.toThrow()
    expect(sink).toHaveBeenCalledWith('boundary report', poison)
  })

  it('records an unhandled native-theme rejection and forwards its cause to the main log', () => {
    const previous = window.electronAPI
    const invoke = vi.fn().mockResolvedValue(undefined)
    window.electronAPI = { ...previous, invoke } as typeof window.electronAPI
    const reason = new Error('Error invoking remote method: native appearance denied')
    try {
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }))
      expect(recentErrors().at(-1)).toMatchObject({
        kind: 'unhandledrejection', message: `Error: ${reason.message}`,
      })
      expect(invoke).toHaveBeenCalledWith('log:write', expect.objectContaining({
        scope: 'error-ring', level: 'error', msg: `Error: ${reason.message}`,
        fields: expect.objectContaining({ kind: 'unhandledrejection', stack: reason.stack }),
      }))
    } finally {
      window.electronAPI = previous
    }
  })
})
