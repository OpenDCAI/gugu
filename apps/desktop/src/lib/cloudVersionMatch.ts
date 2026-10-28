import { useSyncExternalStore } from 'react'
import { CloudComputerError, type CloudVersionMatchState } from '@gugu/core/cloud/cloudComputer'
import { rendererCloudComputerClient } from './cloudComputer'
import { getRendererSession, observeRendererSession } from './sessionPublication'

const states = new Map<string, CloudVersionMatchState>()
const running = new Map<string, AbortController>()
const listeners = new Set<() => void>()
let owner = getRendererSession()?.user.id ?? null
const keyFor = (deviceId: string) => `${owner}:${deviceId}`
const publish = (key: string, value: CloudVersionMatchState) => { states.set(key, value); for (const listener of listeners) listener() }
observeRendererSession(() => {
  const next = getRendererSession()?.user.id ?? null
  if (next === owner) return
  owner = next
  for (const controller of running.values()) controller.abort()
  running.clear(); states.clear()
  for (const listener of listeners) listener()
})

export function useCloudVersionMatch(deviceId: string | null) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) },
    () => deviceId ? states.get(keyFor(deviceId)) : undefined)
}

/** Called only for a verified version mismatch, never for a connection failure. */
export async function requestCloudVersionMatch(deviceId: string, retry = false): Promise<boolean> {
  const { getCloudComputerState } = await import('./cloudComputerStore')
  if (getCloudComputerState().snapshot?.deviceId !== deviceId) return false
  const key = keyFor(deviceId)
  if (running.has(key)) return true
  if (!retry && states.has(key)) return states.get(key)?.status !== 'failed'
  const client = rendererCloudComputerClient()
  if (!owner || !client?.matchVersion) return false
  const controller = new AbortController()
  running.set(key, controller)
  const assertCurrent = () => { if (key !== keyFor(deviceId)) throw new Error('Account changed'); controller.signal.throwIfAborted() }
  try {
    const initial = await client.matchVersion(deviceId, true, controller.signal)
    assertCurrent()
    publish(key, initial)
    const monitor = async () => {
      const until = Date.now() + 10 * 60_000
      let state = initial
      while (state.status === 'updating') {
        if (Date.now() >= until) throw new CloudComputerError(0, 'version_match_failed', '云端咕咕升级一直没有完成，请重试')
        await new Promise(resolve => setTimeout(resolve, 2_000))
        assertCurrent()
        state = await client.matchVersion!(deviceId, false, controller.signal)
        assertCurrent()
        publish(key, state)
      }
      if (state.status === 'ready') window.dispatchEvent(new CustomEvent('gugu:cloud-version-matched', { detail: { deviceId } }))
    }
    void monitor().catch(error => {
      if (!controller.signal.aborted) publish(key, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { if (running.get(key) === controller) running.delete(key) })
    return initial.status !== 'failed'
  } catch (error) {
    if (!controller.signal.aborted) publish(key, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    running.delete(key)
    return false
  }
}
