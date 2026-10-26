import { afterEach, expect, it, vi } from 'vitest'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { isAssistantPanelReadRetryable, retryAssistantPanelRead, withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { deferred } from '../support/testHarness'

afterEach(() => vi.useRealTimers())
it.each(['unprepared','preparation-timeout','collection-unavailable','application-failed','stale','signed-out','42501','invalid-response','22023','54000'])('never retries fixed state %s', code => {
  expect(isAssistantPanelReadRetryable(new AssistantPanelError(code,'private detail'))).toBe(false)
})
it.each([new TypeError('fetch failed'),new AssistantPanelError('read-timeout','timeout'),new AssistantPanelError('PGRST003','pool unavailable')])('bounds retries for a transport failure', error => {
  expect(retryAssistantPanelRead(0,error)).toBe(true)
  expect(retryAssistantPanelRead(2,error)).toBe(false)
})
it.each([new SyntaxError('invalid stored metadata'),new TypeError('panel.collection is not a function'),new Error('invalid configuration')])('does not retry non-transport failures', error => {
  expect(isAssistantPanelReadRetryable(error)).toBe(false)
})
it('cancels a stalled read at the common deadline and ignores its late response', async () => {
  vi.useFakeTimers()
  const pending = deferred<string>()
  let signal: AbortSignal | undefined
  const result = withAssistantPanelReadDeadline(current => { signal = current; return pending.promise })
  const failure = expect(result).rejects.toMatchObject({ code: 'read-timeout' })
  await vi.advanceTimersByTimeAsync(15_000)
  await failure
  expect(signal?.aborted).toBe(true)
  pending.resolve('late response')
  await expect(result).rejects.toMatchObject({ code: 'read-timeout' })
  expect(vi.getTimerCount()).toBe(0)
})
