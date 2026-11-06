import { useEffect, useRef, useState } from 'react'
import { UI_EVENTS } from './uiEvents'
import { fileMetadata, fileReader } from './fileAccess'
import { rendererLogger } from './log'
import type { ManagedRealtimeChannel } from './realtimeChannel'
import { i18n } from '../i18n'

const log = rendererLogger('file-host')

export type FileHost = { device: string; account: string }
/** The machine a failed read waits for: its name (`''` when it has none), and whose it is (null: the reader's own). */
export type OfflineHolder = { machine: string; person: string | null; deviceId: string }

/**
 * A project chat's file kept on the machine that sent this version (uploaded only when someone opens it): which machine
 * and whose account.
 * Null for every other file, and while unknown: it only says where the file is, so a failed read draws nothing.
 */
export function useFileHost(itemId: string | null): FileHost | null {
  const [host, setHost] = useState<FileHost | null>(null)
  useEffect(() => {
    setHost(null)
    if (!itemId) return undefined
    let live = true
    Promise.resolve().then(() => fileMetadata(itemId)).then((file) => {
      if (live && file.status === 'ready' && file.revision.source === 'local' && file.revision.host_device_id && file.revision.host_account_id) {
        setHost({ device: file.revision.host_device_id, account: file.revision.host_account_id })
      }
    }).catch((error: unknown) => log.warn({ itemId, error: String(error) }, 'where the file is kept is unknown'))
    return () => { live = false }
  }, [itemId])
  return host
}

/**
 * After a read failed: whether it is because the machine that keeps this version is offline right now, read afresh from
 * the resolver (never a state remembered from earlier). That machine or null.
 */
export async function offlineHolder(itemId: string, version?: number): Promise<OfflineHolder | null> {
  const file = await fileMetadata(itemId, version).catch(() => null)
  if (file?.status !== 'ready' || file.revision.source !== 'local' || file.revision.host_online !== false || !file.revision.host_device_id) return null
  const account = file.revision.host_account_id
  const others = account && account !== fileReader().accountId
    ? await import('./identityReadAdapter').then(({ readDisplayIdentities }) => readDisplayIdentities([account])).catch(() => []) : []
  return { machine: file.revision.host_label?.trim() ?? '', person: others[0]?.display_name?.trim() || null, deviceId: file.revision.host_device_id }
}

/** What a reader is told about that machine, wherever the file was opened from. */
export function holderOfflineText({ machine, person }: OfflineHolder): string {
  const say = (key: string, options: Record<string, string>) => i18n.t(`attachmentView.${key}`, { ns: 'messaging', ...options })
  return person && machine ? say('holderOfflineOf', { person, machine }) : say('holderOffline', { machine: machine || say('holderMachine', {}) })
}

type HolderListener = { back(): void; subscribed(): void }
const holderTopics = new Map<string, { channel: Promise<ManagedRealtimeChannel>; listeners: Set<HolderListener> }>()
const leavingTopics = new Map<string, Promise<void>>()

/** One subscription per machine, held only while a reader is waiting on it; a topic left is left before it is joined again. */
export function listenForHolder(deviceId: string, listener: HolderListener) {
  let topic = holderTopics.get(deviceId)
  if (!topic) {
    const listeners = new Set<HolderListener>()
    topic = { listeners, channel: (leavingTopics.get(deviceId) ?? Promise.resolve()).then(async () => {
      const [{ subscribeAuthenticatedRealtimeChannel }, { dataClient }] = await Promise.all([import('./realtimeChannel'), import('./supabase')])
      return subscribeAuthenticatedRealtimeChannel(() => dataClient.channel(`gugu:holder:${deviceId}`, { config: { private: true, broadcast: { self: false, ack: true } } })
        .on('broadcast', { event: 'holder_online' }, () => listeners.forEach((each) => each.back())),
      `file-holder:${deviceId}`,
      // It is silent by nature, so silence is not a bad line. Each join reads the truth again for what was missed.
      { reconnectWhenIdle: false, shouldSubscribe: () => holderTopics.get(deviceId)?.listeners === listeners, onSubscribed: () => listeners.forEach((each) => each.subscribed()) })
    }) }
    holderTopics.set(deviceId, topic)
  }
  const { listeners, channel } = topic
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    holderTopics.delete(deviceId)
    const leaving = Promise.all([channel, import('./realtimeChannel')]).then(([joined, { unsubscribeAuthenticatedRealtimeChannel }]) => unsubscribeAuthenticatedRealtimeChannel(joined)).catch((error: unknown) => log.warn({ deviceId, error: String(error) }, 'leaving a holder topic failed'))
      .finally(() => { if (leavingTopics.get(deviceId) === leaving) leavingTopics.delete(deviceId) })
    leavingTopics.set(deviceId, leaving)
  }
}

/**
 * Calls `onBack` when that machine is back. `stillOffline` reads the truth after a join, for a return missed before it;
 * without it (a file beside a document, read through its page) only the machine's own announcement counts.
 */
export function useHolderBack(deviceId: string | null, onBack: () => void, stillOffline?: () => Promise<boolean>) {
  const latest = useRef({ onBack, stillOffline })
  latest.current = { onBack, stillOffline }
  useEffect(() => {
    if (!deviceId) return undefined
    let live = true
    const check = () => {
      const { onBack, stillOffline } = latest.current
      if (!stillOffline) return onBack()
      void stillOffline().then((offline) => { if (live && !offline) latest.current.onBack() })
    }
    const stop = listenForHolder(deviceId, { back: check, subscribed: () => { if (latest.current.stillOffline) check() } })
    return () => { live = false; stop() }
  }, [deviceId])
}

export const openFileStorageSettings = () => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'files' } }))
