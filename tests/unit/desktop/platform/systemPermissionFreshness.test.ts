// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, deferred } from '../../../support/testHarness'
import type { SystemPermission, SystemPermissionState } from '../../../../apps/desktop/src/platform/types'

const mocks = vi.hoisted(() => ({ check: vi.fn(), foreground: null as (() => void) | null, error: null as (() => void) | null }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  systemPermissions: ['notifications', 'camera'], checkSystemPermission: mocks.check,
  subscribeAppForeground: (foreground: () => void, error: () => void) => {
    mocks.foreground = foreground; mocks.error = error
    return () => { mocks.foreground = null; mocks.error = null }
  },
} }))
import { useSystemPermissionStates } from '../../../../apps/desktop/src/lib/systemPermissions'

function PermissionView({ permissions }: { permissions: SystemPermission[] }) {
  const { states, failed } = useSystemPermissionStates(permissions)
  return createElement('output', null, JSON.stringify({ states, failed }))
}
const active: Array<ReturnType<typeof createReactHarness>> = []
const value = () => JSON.parse(document.querySelector('output')!.textContent!)
async function render(permissions: SystemPermission[]) {
  const harness = createReactHarness(); active.push(harness)
  await harness.render(createElement(PermissionView, { permissions }))
  return harness
}
beforeEach(() => { mocks.check.mockReset(); mocks.foreground = null; mocks.error = null })
afterEach(() => { for (const harness of active.splice(0)) harness.cleanup() })

it('retains the permission returned after settings instead of a late older grant', async () => {
  const oldRead = deferred<SystemPermissionState>()
  mocks.check.mockReturnValueOnce(oldRead.promise).mockResolvedValue('blocked')
  await render(['notifications'])
  await act(async () => { mocks.foreground!() })
  expect(value()).toEqual({ states: { notifications: 'blocked' }, failed: false })
  await act(async () => { oldRead.resolve('granted') })
  expect(value()).toEqual({ states: { notifications: 'blocked' }, failed: false })
})

it('shows reading while refreshing and does not apply failure from the previous permission list', async () => {
  const oldRead = deferred<SystemPermissionState>(), refresh = deferred<SystemPermissionState>()
  mocks.check.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce('granted').mockReturnValueOnce(refresh.promise)
  const harness = await render(['notifications'])
  await harness.render(createElement(PermissionView, { permissions: ['camera'] }))
  expect(value()).toEqual({ states: { camera: 'granted' }, failed: false })
  await act(async () => { oldRead.reject(new Error('old notification read failed')); mocks.foreground!() })
  expect(value()).toEqual({ states: {}, failed: false })
  await act(async () => { refresh.resolve('blocked') })
  expect(value()).toEqual({ states: { camera: 'blocked' }, failed: false })
})

it('does not turn a failed foreground subscription into a granted state when an older check finishes', async () => {
  const read = deferred<SystemPermissionState>()
  mocks.check.mockReturnValue(read.promise)
  await render(['notifications'])
  await act(async () => { mocks.error!() })
  expect(value()).toEqual({ states: {}, failed: true })
  await act(async () => { read.resolve('granted') })
  expect(value()).toEqual({ states: {}, failed: true })
})
