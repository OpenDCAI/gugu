import { afterEach, expect, it, vi } from 'vitest'
import { AssistantPanelError, createAssistantPanelClient } from '@gugu/core/cloud/assistantPanel'
import { isAssistantPanelReadRetryable, retryAssistantPanelRead, withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { deferred } from '../support/testHarness'

afterEach(() => vi.useRealTimers())
it.each([[0,'ENOTFOUND'],[0,'ECONNRESET'],[503,'gateway_unavailable']] as const)('preserves RPC transport status %s with SDK code %s', async (status,code) => {
  const client = createAssistantPanelClient(async () => ({ data: null,error: { code,message: 'private transport diagnosis' },status }),() => 'owner')
  const error = await client.snapshot('assistant').catch(error => error)
  expect(error).toMatchObject({ code,status })
  expect(isAssistantPanelReadRetryable(error)).toBe(true)
})
it.each(['unprepared','collection-unavailable','application-failed','stale','54000'])('does not retry snapshot fact %s even with a server status', code => {
  expect(isAssistantPanelReadRetryable(Object.assign(new AssistantPanelError(code,'fixed fact'),{ status: 500 }))).toBe(false)
})
it.each(['unprepared','preparation-timeout','collection-unavailable','application-failed','stale','signed-out','42501','invalid-response','22023','54000'])('never retries fixed state %s', code => {
  expect(isAssistantPanelReadRetryable(new AssistantPanelError(code,'private detail'))).toBe(false)
})
it.each([new TypeError('fetch failed'),new AssistantPanelError('read-timeout','timeout'),new AssistantPanelError('PGRST003','pool unavailable')])('bounds retries for a transport failure', error => {
  expect(retryAssistantPanelRead(0,error)).toBe(true)
  expect(retryAssistantPanelRead(2,error)).toBe(false)
})
it.each(['500','502','503','504'])('recovers a server HTTP error carried as code %s', code => {
  expect(retryAssistantPanelRead(0,new AssistantPanelError(code,'private server detail'))).toBe(true)
  expect(retryAssistantPanelRead(2,new AssistantPanelError(code,'private server detail'))).toBe(false)
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
