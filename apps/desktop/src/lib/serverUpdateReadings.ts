import { useSyncExternalStore } from 'react'
import { SERVER_TRANSITION_HEALTH_RPC } from '@gugu/core/cloud/serverTransition'
import { SERVER_SSH_MACHINES_CHANNELS, type ServerUpdateReading } from './serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'
import { callDeviceRpc } from './deviceRpc'

export type ServerUpdateView = ServerUpdateReading & { connected?: boolean }
let readings: ReadonlyMap<string, ServerUpdateView> = new Map()
const listeners = new Set<() => void>()
let unwire: (() => void) | null = null
let generation = 0
const verifying = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const notify = () => { for (const listener of listeners) listener() }

function verify(id: string): void {
  const transition = readings.get(id)?.transition
  if (!transition || transition.phase !== 'ready' || !transition.pid) return
  const key = `${transition.request}:${transition.pid}`
  if (verifying.get(id) === key) return
  verifying.set(id, key)
  const ownGeneration = generation
  const attempt = async () => {
    if (ownGeneration !== generation || verifying.get(id) !== key) return
    try {
      const reply = await callDeviceRpc<{ pid: number; version: string }>(id, SERVER_TRANSITION_HEALTH_RPC, {}, { timeoutMs: 8_000 })
      if (ownGeneration !== generation || verifying.get(id) !== key) return
      if (!reply.error && reply.result?.pid === transition.pid && reply.result?.version === transition.target) {
        readings = new Map(readings).set(id, { ...readings.get(id)!, connected: true }); notify(); return
      }
    } catch { /* The server may be ready before its transport; keep showing Connecting. */ }
    if (ownGeneration === generation && verifying.get(id) === key) timers.set(id, setTimeout(() => void attempt(), 5_000))
  }
  void attempt()
}

function apply(id: string, reading: ServerUpdateReading): void {
  const previous = readings.get(id)
  if ((reading.revision ?? 0) < (previous?.revision ?? 0)) return
  const same = previous?.transition?.request === reading.transition?.request && previous?.transition?.pid === reading.transition?.pid
  readings = new Map(readings).set(id, { ...reading, connected: same ? previous?.connected : false })
  if (!same) {
    verifying.delete(id)
    const timer = timers.get(id); if (timer) clearTimeout(timer)
  }
  notify()
  verify(id)
}

function wire(): void {
  if (unwire) return
  const ipc = desktopIpc()
  if (!ipc) return
  unwire = ipc.eventOn(SERVER_SSH_MACHINES_CHANNELS.updateChanged, value => {
    const event = value as { deviceId?: string; reading?: ServerUpdateReading } | null
    if (event?.deviceId && event.reading) apply(event.deviceId, event.reading)
  })
}

export async function readServerUpdate(deviceId: string, options: { force?: boolean; pending?: boolean } = {}): Promise<void> {
  wire()
  const value = await desktopIpc()?.invoke(SERVER_SSH_MACHINES_CHANNELS.updateRead, { deviceId, ...options })
  if (value) apply(deviceId, value as ServerUpdateReading)
}

export function clearServerUpdateReadings(): void {
  generation++
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear(); verifying.clear()
  unwire?.(); unwire = null
  readings = new Map(); notify()
}

export function useServerUpdateReadings(): ReadonlyMap<string, ServerUpdateView> {
  return useSyncExternalStore(listener => { wire(); listeners.add(listener); return () => { listeners.delete(listener) } }, () => readings)
}
