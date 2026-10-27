// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useReadFailure } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-read-failure'
const native = vi.hoisted(() => ({ matchServerVersion: vi.fn() }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store',() => ({ remoteHostsStore: { device: () => ({ version: 'old' }),matchServerVersion: native.matchServerVersion } }))
vi.mock('react-i18next',async original => ({ ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string,values?: object) => `${key}|${JSON.stringify(values ?? {})}` }) }))
let result: ReturnType<typeof useReadFailure>
const reload = vi.fn()
let harness: ReturnType<typeof createReactHarness>
function Probe({ error }: { error: unknown }) { result = useReadFailure(error,'sleeping-device','cloud',reload); return null }
const show = (error: unknown) => harness.render(createElement(Probe,{ error }))
beforeEach(() => { harness = createReactHarness(); vi.useFakeTimers(); reload.mockReset(); native.matchServerVersion.mockReset() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })
it('recovers an initial read automatically without preparing or updating an execution host', async () => {
  await show(Object.assign(new Error('private transport detail'),{ code: 'transport-failed' }))
  expect(result?.text).toContain('machine.collectionFailed')
  expect(result?.text).not.toContain('private transport detail')
  expect(result?.retry).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(reload).toHaveBeenCalledOnce()
  expect(native.matchServerVersion).not.toHaveBeenCalled()
})
it.each([
  ['unprepared','unprepared','quiet'],['42501','accessFailed','danger'],['stale','stale','danger'],['40001','changed','danger'],
  ['collection-unavailable','collectionFailed','danger'],['application-failed','applicationFailed','danger'],['unknown_method','collectionFailed','danger'],
])('explains %s without displaying a raw service error', async (code,key,tone) => {
  await show(Object.assign(new Error('SQL /private/file'),{ code }))
  expect(result).toMatchObject({ tone,retry: null })
  expect(result?.text).toContain(`machine.${key}`)
  expect(result?.text).not.toContain('SQL')
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(reload).not.toHaveBeenCalled()
})
it('identifies the resource whose committed change was rejected', async () => {
  await show(Object.assign(new Error('EACCES'),{ code: 'application-failed',domain: 'memory',resourceKey: 'note.md' }))
  expect(result?.text).toContain('note.md')
  expect(result?.text).toContain('resourceKinds.memory')
})
it('clears recovery when the read succeeds', async () => {
  await show(new TypeError('network')); await show(null)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(reload).not.toHaveBeenCalled(); expect(result).toBeNull()
})
