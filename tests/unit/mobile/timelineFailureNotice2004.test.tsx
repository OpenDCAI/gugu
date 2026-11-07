// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import { useTimelineFailureNotice } from '../../../apps/desktop/src/mobile/agent-watch/useTimelineFailureNotice'
import * as notices from '../../../apps/desktop/src/lib/notices'

let harness: ReturnType<typeof createReactHarness>
const toast = vi.fn()
const retry = vi.fn(async () => undefined)
let notify: MockInstance<typeof notices.notify>
let dismiss: MockInstance<typeof notices.dismissNotice>
type Startup = { error: string | null; busy: boolean; retry: (() => Promise<void>) | null }
function Fixture({ target = 'host/record', readError = null, startup }: { target?: string; readError?: string | null; startup: Startup }) {
  useTimelineFailureNotice(target, readError, startup)
  return null
}
const render = (startup: Startup, readError: string | null = null, target = 'host/record') =>
  renderWithAppProviders(harness, <Fixture target={target} readError={readError} startup={startup} />, { toast })

beforeEach(() => {
  harness = createReactHarness()
  toast.mockReset(); retry.mockClear()
  notify = vi.spyOn(notices, 'notify').mockReturnValue(1)
  dismiss = vi.spyOn(notices, 'dismissNotice').mockImplementation(() => undefined)
})
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

it('reports an exhausted read once without offering to replay a startup operation', async () => {
  const startup = { error: null, busy: false, retry: null }
  await render(startup, 'Read failed')
  await render(startup, 'Read still failed')
  expect(toast).toHaveBeenCalledExactlyOnceWith('Read failed', 'error')
  expect(notify).not.toHaveBeenCalled()
  expect(retry).not.toHaveBeenCalled()
})

it('keeps a failed bootstrap action in one unified notice and waits for an explicit click', async () => {
  const startup = { error: 'Agent bootstrap failed', busy: false, retry }
  await render({ error: null, busy: false, retry: null }, 'Missing record')
  await render(startup, 'Missing record')
  await render(startup, 'Missing record')
  expect(notify).toHaveBeenCalledOnce()
  expect(notify.mock.calls[0]![0]).toMatchObject({ title: 'Agent bootstrap failed', tier: 'error', action: { label: expect.stringMatching(/^(Restart|重新启动)$/) } })
  expect(retry).not.toHaveBeenCalled()
  notify.mock.calls[0]![0].action!.onClick()
  expect(retry).toHaveBeenCalledOnce()
})

it('dismisses the startup notice during a new attempt and can report a new failure once', async () => {
  const failed = { error: 'Agent bootstrap failed', busy: false, retry }
  await render(failed)
  const key = notify.mock.calls[0]![0].key
  expect(key).toEqual(expect.stringMatching(/^timeline-startup:/))
  await render({ error: null, busy: true, retry: null }, 'Missing record')
  expect(dismiss).toHaveBeenCalledWith(key)
  expect(toast).not.toHaveBeenCalled()
  await render(failed)
  expect(notify).toHaveBeenCalledTimes(2)
  expect(retry).not.toHaveBeenCalled()
})

it.each(['switch', 'unmount'] as const)('cannot invoke an old startup action after a target %s', async mode => {
  await render({ error: 'Agent bootstrap failed', busy: false, retry })
  const key = notify.mock.calls[0]![0].key
  const oldAction = notify.mock.calls[0]![0].action!
  if (mode === 'switch') await render({ error: null, busy: false, retry: null }, null, 'host/other')
  else harness.cleanup()
  oldAction.onClick()
  expect(retry).not.toHaveBeenCalled()
  expect(dismiss).toHaveBeenCalledWith(key)
})
