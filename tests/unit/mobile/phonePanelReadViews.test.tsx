// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach,afterEach,expect,it,vi } from 'vitest'
import { createReactHarness } from '../../support/testHarness'
import { ReadFailed,ReadView } from '../../../apps/desktop/src/mobile/assistant/PhoneMachineView'
import { usePhonePersona } from '../../../apps/desktop/src/mobile/assistant/usePhoneProfileData'
import type { PhoneMachineState } from '../../../apps/desktop/src/mobile/assistant/phoneMachine'
const read = vi.hoisted(() => vi.fn())
vi.mock('@/i18n',async original => ({ ...await original<object>(),useLocale: () => ({ resolvedLocale: 'zh-CN' }) }))
vi.mock('react-i18next',async original => ({ ...await original<object>(),useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core',() => ({ readText: read }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.useFakeTimers();h=createReactHarness();read.mockReset() })
afterEach(() => { h.cleanup();vi.useRealTimers() })
it('keeps unprepared quiet and never schedules recovery in a display component',async () => {
  const reload = vi.fn(),error = Object.assign(new Error('snapshot'),{ code: 'unprepared' })
  await h.render(<ReadView read={{ state: 'error',error,reload }} failedTitle="read">{() => null}</ReadView>)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(h.container.querySelector('[role="alert"]')).toBeNull()
  expect(h.container.querySelector('[role="status"]')?.textContent).toContain('unprepared')
  await h.render(<ReadFailed title="read" error={new TypeError('network')} onRetry={reload} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(reload).not.toHaveBeenCalled()
})
it('bounds persona reads and retains the error while reloading',async () => {
  read.mockImplementation(() => new Promise(() => {}))
  let result: ReturnType<typeof usePhonePersona> | undefined
  const machine = { state: 'ready',machine: { deviceId: 'd',projectId: 'p',workspaceId: 'w',paths: { memoryDir: '记忆',instructions: '性格约定' } } } as PhoneMachineState
  function Probe() { result=usePhonePersona(machine);return null }
  await h.render(<Probe />)
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
  expect(result).toMatchObject({ loading: false,error: { code: 'read-timeout' } })
  await act(async () => { result!.reload() })
  expect(result).toMatchObject({ loading: false,error: { code: 'read-timeout' } })
})
