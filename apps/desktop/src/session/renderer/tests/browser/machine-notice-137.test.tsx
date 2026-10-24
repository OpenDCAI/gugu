import { act, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ToastProvider } from '@/components/Toast'
import { useToast } from '@/components/toastContext'
import { useMachineNotice, type MachineNoticeSpec } from '@renderer/features/remote-hosts/machine-notice'
import '@/styles/tokens.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))

// 真 sonner、真提示条:这两件只在真的那一份上才会错(收是排到下一帧的、提示条只认挂上之后发的提示)。
const offline: MachineNoticeSpec = { title: 'Mac 1 is offline', tier: 'info', waiting: false, delayed: false }
const failed: MachineNoticeSpec = { title: 'Could not wake Mac 1', tier: 'error', waiting: false, delayed: false }
const translate = ((key: string) => key) as never
function Composer({ name, spec }: { name: string; spec: MachineNoticeSpec | null }) {
  useMachineNotice('mac-1', 'Mac 1', spec, translate)
  return <span>{name}</span>
}
let showPage: (page: 'none' | 'new-session' | 'project') => void = () => {}
let setSpec: (spec: MachineNoticeSpec | null) => void = () => {}
function Pages() {
  const [page, setPage] = useState<'none' | 'new-session' | 'project'>('none')
  const [spec, setSpecState] = useState<MachineNoticeSpec | null>(offline)
  showPage = setPage
  setSpec = setSpecState
  if (page === 'new-session') return <Composer key="new-session" name="new-session" spec={spec} />
  if (page === 'project') return <Composer key="project" name="project" spec={spec} />
  return null
}
function EmitOnMount() {
  const { toast } = useToast()
  useEffect(() => toast('sent while the app mounts', 'error'), [toast])
  return null
}

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())
const notices = () => [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')].map((element) => element.textContent ?? '')
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the machine notice across page changes (#137)', () => {
  it('leaving the new-session page for the project page a moment later keeps the offline notice, and it can still be closed by the user', async () => {
    harness = createReactHarness()
    await renderWithAppProviders(harness, <ToastProvider><Pages /></ToastProvider>)
    await act(async () => showPage('new-session'))
    await until('the offline notice appears', () => notices().some((text) => text.includes('Mac 1 is offline')))
    // 先卸载一个输入框、隔一拍再挂上另一个(换页就是这样,不在同一次提交里)
    await act(async () => showPage('none'))
    await pause(0)
    await act(async () => showPage('project'))
    await pause(1_000)
    expect(notices().filter((text) => text.includes('Mac 1 is offline'))).toHaveLength(1)
    const close = document.querySelector<HTMLButtonElement>('[data-sonner-toast] [data-close-button]')!
    await act(async () => { await userEvent.click(close) })
    await until('the user closed it', () => notices().length === 0)
  })

  it('after that page change the notice still follows the machine: it changes in place and turns into "connected" when the machine is back', async () => {
    harness = createReactHarness()
    await renderWithAppProviders(harness, <ToastProvider><Pages /></ToastProvider>)
    await act(async () => showPage('new-session'))
    await until('the offline notice appears', () => notices().some((text) => text.includes('Mac 1 is offline')))
    await act(async () => showPage('none'))
    await pause(0)
    await act(async () => showPage('project'))
    // 旧的那条被收掉之后 sonner 晚一帧才回调它的 onDismiss:那不是用户关的,❌ 让这台机器从此不再提示
    await pause(1_000)
    await act(async () => setSpec(failed))
    await until('the notice changed in place', () => notices().length === 1 && notices()[0].includes('Could not wake Mac 1'))
    await act(async () => setSpec(null))
    await until('it says the machine is connected', () => notices().length === 1 && notices()[0].includes('remoteHost.status.connected'))
  })

  it('a notice raised while the app itself mounts is shown, not lost before the notification surface subscribes', async () => {
    harness = createReactHarness()
    await renderWithAppProviders(harness, <ToastProvider><EmitOnMount /></ToastProvider>)
    await until('the notice raised during mount appears', () => notices().some((text) => text.includes('sent while the app mounts')))
  })
})
