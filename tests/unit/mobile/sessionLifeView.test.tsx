// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { LifeView } from '@/session/shared/core/sessions/session-life'
import { useSessionLifeView } from '@/mobile/agent-watch/useSessionLifeView'
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = vi.hoisted(() => ({
  reads: [] as Array<{ sessionId: string; resolve: (view: LifeView) => void; reject: (error: unknown) => void }>,
  events: new Set<(view: LifeView) => void>(), links: new Set<(open: boolean) => void>(),
}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessions: { lifeView: (sessionId: string) => new Promise<LifeView>((resolve, reject) => host.reads.push({ sessionId, resolve, reject })) } }),
  onMachineEvent: (_device: string, _event: unknown, fn: (view: LifeView) => void) => { host.events.add(fn); return () => host.events.delete(fn) },
  onLinkChange: (_device: string, fn: (open: boolean) => void) => { host.links.add(fn); return () => host.links.delete(fn) },
}))
vi.mock('@renderer/lib/ipc', () => ({ onMachineEvent: (_device: unknown, _event: unknown, fn: (view: LifeView) => void) => { host.events.add(fn); return () => host.events.delete(fn) } }))
const view = (sessionId: string, version: number): LifeView => ({ sessionId, version, kind: 'ready', stage: null, hold: null, failure: null, lastExit: null, nativeSession: null, pending: { count: 0, items: [] } })
const container = document.createElement('div')
let root: ReturnType<typeof createRoot>
let latest: ReturnType<typeof useSessionLifeView>
function Reader({ device = 'device', session = 'a', local = false, enabled = true }) {
  latest = useSessionLifeView(device, session, local, enabled)
  return null
}
afterEach(async () => { await act(async () => root?.unmount()); host.reads = []; host.events.clear(); host.links.clear() })

it('subscribes before reading, keeps push ordering, rejects stale navigation results and unsubscribes', async () => {
  root = createRoot(container)
  await act(async () => { root.render(<Reader />) })
  expect(host.events.size).toBe(1)
  expect(host.links.size).toBe(1)
  await act(async () => { for (const cb of host.events) cb(view('a', 5)); host.reads[0]!.resolve(view('a', 1)) })
  expect(latest.view?.version).toBe(5)
  await act(async () => { root.render(<Reader session="b" />) })
  expect(latest.view).toBeNull()
  expect(host.events.size).toBe(1)
  expect(host.links.size).toBe(1)
  await act(async () => { for (const cb of host.events) cb(view('a', 99)); host.reads[1]!.resolve(view('b', 1)) })
  expect(latest.view?.sessionId).toBe('b')
  await act(async () => { root.render(<Reader enabled={false} />) })
  expect(host.events.size).toBe(0)
  expect(host.links.size).toBe(0)
})

it('reports read failure, refreshes after reconnection, and accepts the restarted host version', async () => {
  root = createRoot(container)
  await act(async () => { root.render(<Reader />) })
  await act(async () => { host.reads[0]!.reject(new Error('Host disconnected')) })
  expect(latest.error).toContain('Host disconnected')
  await act(async () => { for (const cb of host.events) cb(view('a', 9)) })
  expect(latest.error).toBeNull()
  await act(async () => { for (const cb of host.links) cb(true); host.reads[1]!.resolve(view('a', 1)) })
  expect(latest.view?.version).toBe(1)
})

it('does not add a read on a normal open, and reads once when a real pending input appears', async () => {
  function Pending({ pending }: { pending: boolean }) {
    latest = useSessionLifeView('device', 'a', false, true, pending)
    return null
  }
  root = createRoot(container)
  await act(async () => { root.render(<Pending pending={false} />) })
  expect(host.events.size).toBe(1)
  expect(host.reads).toHaveLength(0)
  await act(async () => { root.render(<Pending pending />) })
  expect(host.reads).toHaveLength(1)
  await act(async () => { host.reads[0]!.resolve(view('a', 3)); root.render(<Pending pending={false} />) })
  await act(async () => { for (const cb of host.events) cb(view('a', 2)) })
  expect(latest.view?.version).toBe(3)
  expect(host.reads).toHaveLength(1)
})

it('invalidates old ready on disconnect and throughout a reconnect read, rejecting the previous epoch', async () => {
  root = createRoot(container)
  await act(async () => { root.render(<Reader />) })
  await act(async () => { host.reads[0]!.resolve(view('a', 9)) })
  const priorCurrent = latest.current
  expect(priorCurrent()?.version).toBe(9)
  await act(async () => {
    for (const cb of host.links) cb(false)
    expect(priorCurrent()).toBeNull()
  })
  expect(latest.view).toBeNull()
  await act(async () => { for (const cb of host.links) cb(true) })
  expect(latest.view).toBeNull()
  expect(latest.current()).toBeNull()
  await act(async () => { host.reads[1]!.resolve({ ...view('a', 1), hold: 'user-stop' }) })
  expect(latest.current()?.hold).toBe('user-stop')
  expect(latest.view?.hold).toBe('user-stop')
})

it('does not restore an old ready value after a reconnect read fails', async () => {
  root = createRoot(container)
  await act(async () => { root.render(<Reader />) })
  await act(async () => { host.reads[0]!.resolve(view('a', 4)) })
  await act(async () => { for (const cb of host.links) cb(true) })
  await act(async () => { host.reads[1]!.reject(new Error('new epoch read failed')) })
  expect(latest.view).toBeNull()
  expect(latest.current()).toBeNull()
  expect(latest.error).toContain('new epoch read failed')
})
