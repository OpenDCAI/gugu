import { useCallback, useMemo } from 'react'
import { useOwnerConnectionStore } from '@/lib/connectionBridge'
import type { Device } from '@gugu/core/shared/types/chat'
import { LOCAL_LIBRARY_HOST,createRemoteLibraryHost,type LibraryHost } from '@/session/renderer/features/library/library-host'
import { remoteHostsStore } from '@/session/renderer/features/remote-hosts/remote-hosts-store'
import { wakeAndWaitOnline } from '@/lib/cloudComputerStore'
import { listDevicesOnceIdentified } from '@/lib/listDevicesOnceIdentified'
import { connectionLibraryHost } from './connection-library-host'
import { ownerConnectionActions } from './owner-connection-actions'

/** Reading the directory or saved accounts never starts a host or assistant. */
export function useOwnerLibraryHost(device: Device | null): LibraryHost {
  const deviceId = device?.device_id ?? null
  const local = device?.is_current_device === true
  const label = device?.label || device?.hostname || ''
  const online = device?.is_online ?? false,hostKind = device?.capabilities.host_kind
  const base = useMemo(() => !deviceId || local ? LOCAL_LIBRARY_HOST : createRemoteLibraryHost({ deviceId,deviceLabel: label,online,
    lastSeenAt: device?.last_seen_at ?? null,hostKind: hostKind === 'server' ? 'server' : 'desktop' }),[deviceId,local,label,online,device?.last_seen_at,hostKind])
  const store = useOwnerConnectionStore(deviceId)
  const cloud = device?.cloud_computer
  const prepare = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!deviceId) throw new Error('CONNECTION_DEVICE_REQUIRED')
    if (local) return
    remoteHostsStore.start()
    if (cloud) await wakeAndWaitOnline(deviceId,{ signal,isOnline: async id => (await listDevicesOnceIdentified()).some(row => row.device_id === id && row.is_online) })
    signal?.throwIfAborted()
    remoteHostsStore.reconnect(deviceId)
  },[deviceId,local,cloud])
  return useMemo(() => {
    const host = connectionLibraryHost(base,store,prepare)
    return store ? ownerConnectionActions(base,host,deviceId) : host
  },[base,store,prepare,deviceId])
}
