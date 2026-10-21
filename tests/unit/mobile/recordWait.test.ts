import { describe, expect, it } from 'vitest'
import { LOAD_RETRY_DELAYS_MS, RECORD_WAIT_RETRY_MS, RECORD_WAIT_WINDOW_MS, loadRetryDelay } from '../../../apps/desktop/src/mobile/agent-watch/record-wait'

// 读时间线的重试判据(record-wait.ts):会自己好的自己再试,不会好的立刻报。
describe('loadRetryDelay', () => {
  it('记录还没写出来:窗口内慢慢等,过了窗口才报', () => {
    expect(loadRetryDelay({ code: 'record_not_found', attempt: 9, elapsedMs: 1_000 })).toBe(RECORD_WAIT_RETRY_MS)
    expect(loadRetryDelay({ code: 'record_not_found', attempt: 1, elapsedMs: RECORD_WAIT_WINDOW_MS })).toBeNull()
  })

  it('传输层失败(没有业务码)按退避再试,试完才报', () => {
    for (const code of [null]) {
      expect(LOAD_RETRY_DELAYS_MS.map((_, i) => loadRetryDelay({ code, attempt: i + 1, elapsedMs: 0 }))).toEqual(LOAD_RETRY_DELAYS_MS)
      expect(loadRetryDelay({ code, attempt: LOAD_RETRY_DELAYS_MS.length + 1, elapsedMs: 0 })).toBeNull()
    }
  })

  it('不会自己好的立刻报', () => {
    expect(loadRetryDelay({ code: 'session_not_found', attempt: 1, elapsedMs: 0 })).toBeNull()
  })
})
