// @vitest-environment jsdom
// #7199 读失败的横幅「没能读到最新的聊天记录」:这条线别的读(重连补洞、往新翻)成了、窗口到了最新,横幅就清掉;
// 比那一读早发出、还在路上的读晚到的失败 ❌ 把横幅挂回来。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const { useMessageReadFailures } = await import('../../../../apps/desktop/src/store/chatMessageReads')

let reads: ReturnType<typeof useMessageReadFailures>
function Probe() {
  reads = useMessageReadFailures()
  return null
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  harness = createReactHarness()
  await harness.render(createElement(Probe))
})
afterEach(() => harness.cleanup())

function later<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

describe('useMessageReadFailures.noteFreshRead', () => {
  it('打开时那一读失败了;之后补洞成了:横幅清掉', async () => {
    await act(async () => { await reads.track('chat-a', Promise.reject(new Error('column does not exist'))).catch(() => {}) })
    expect(reads.failureOf('chat-a')?.message).toBe('column does not exist')
    await act(async () => { reads.noteFreshRead('chat-a') })
    expect(reads.failureOf('chat-a')).toBeNull()
  })

  it('补洞成了之后,比它早发出的那一读晚到的失败 ❌ 把横幅挂回来', async () => {
    const older = later<string[]>()
    let settled: Promise<unknown> = Promise.resolve()
    await act(async () => { settled = reads.track('chat-a', older.promise).catch(() => {}) })
    await act(async () => { reads.noteFreshRead('chat-a') })
    await act(async () => { older.reject(new Error('late failure')); await settled })
    expect(reads.failureOf('chat-a')).toBeNull()
  })

  it('对照:没有补洞时,那一读的失败照常挂上;别的会话不受影响', async () => {
    const older = later<string[]>()
    let settled: Promise<unknown> = Promise.resolve()
    await act(async () => { settled = reads.track('chat-a', older.promise).catch(() => {}) })
    await act(async () => { reads.noteFreshRead('chat-b') })
    await act(async () => { older.reject(new Error('late failure')); await settled })
    expect(reads.failureOf('chat-a')?.message).toBe('late failure')
  })
})
