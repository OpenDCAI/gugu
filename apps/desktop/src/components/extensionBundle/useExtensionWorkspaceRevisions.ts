import { useEffect, useRef } from 'react'
import { isDeviceOnline } from '@gugu/core/shared/enums/deviceModels'
import { fetchInChunks } from '@gugu/core/shared/inChunks'
import { readMemberRosterRevision, readWorkspaceChanges } from '../../lib/accountRevisionCoordinator'
import { listenForHolder } from '../../lib/fileHost'
import { rendererLogger } from '../../lib/log'
import { chatDb } from '../../lib/supabase'
import { platform } from '../../platform'
import { useChatStore } from '../../store/chatContext'
import { useDevicesStore } from '../../store/devicesContext'
import { events, rpc } from '../../session/renderer/lib/ipc'
import { fileHoldersOfflineChannel } from '../../session/shared/events/appEvents'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { openFileIds, updateFileNames } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'

const log = rendererLogger('chat/extension-workspace-revisions')

/**
 * App pages drawn for a group hear that the group's files changed (`gugu.files.onChanged`,
 * 真源 §2.4 评审). The account revision bus already carries `workspace_changed` into this
 * window; this passes on WHICH files of which groups it named (#7257), and main reads them and
 * tells the pages bound to them how those files are now.
 *
 * A listener on the bus that is already open — ❌ a channel of its own: App traffic stays off
 * the chat realtime quota (原则 9). Main merges App reads independently. Only names of already-open
 * files are awaited here, so an older revision cannot overwrite a later rename in the tab strip.
 */
export function useExtensionWorkspaceRevisions(): void {
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  useEffect(() => {
    const workspace = subscribeAccountRevision('workspace_changed', async (operations) => {
      const changes = readWorkspaceChanges(operations.map((operation) => operation.payload))
      if (changes.length === 0) return
      if (platform.capabilities.agentRuntime) void rpc.extensions.groupWorkspaceChanged({ changes }).catch((error: unknown) => {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages their group workspace changed failed')
      })
      const open = openFileIds()
      await Promise.all(changes.map(async ({ chatId, itemIds }) => {
        const ids = itemIds.filter((id) => open.has(id))
        if (ids.length === 0) return
        const files = await fetchInChunks(ids, async (batch) => {
          const { data, error } = await chatDb.from('workspace_items').select('id,filename,content_type').eq('chat_id', chatId).in('id', batch)
          if (error) throw error
          return data
        })
        updateFileNames(files, installedExtensionsStore.manifests)
      }))
    })
    // 摩擦单 F36: who is in the chat is part of an App page's context; the same bus says when a member row changed, and
    // who and whether they left — main reads the members again only when that moved who is there (`rosterMoved`).
    const members = subscribeAccountRevision('chat_members_changed', (operations) => {
      if (!platform.capabilities.agentRuntime) return
      const changes = operations.map((operation) => readMemberRosterRevision(operation.payload))
      if (changes.length === 0) return
      void rpc.extensions.chatMembersChanged({ changes }).catch((error: unknown) => {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages their chat members changed failed')
      })
    })
    return () => {
      workspace()
      members()
    }
  }, [subscribeAccountRevision])
  // Where a project file is kept is shown with whether that machine is on: the device list's own facts say when one went
  // on or off (not every heartbeat), and the folders on screen read their files again.
  const { devices } = useDevicesStore()
  const online = useRef<Map<string, boolean> | null>(null)
  useEffect(() => {
    const now = new Map(devices.map((device) => [device.device_id, isDeviceOnline(device.status)]))
    const before = online.current
    online.current = now
    if (!before || !platform.capabilities.agentRuntime || ![...now].some(([id, on]) => before.has(id) && before.get(id) !== on)) return
    void rpc.extensions.devicesOnlineChanged().catch((error: unknown) => {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages a device went on or off failed')
    })
  }, [devices])
  // Another account's machine is not in that list: while a folder on screen shows one as off, hear its return the way a
  // reader waiting on one does. The folders read their files again, and name only the machines still off.
  useEffect(() => {
    if (!platform.capabilities.agentRuntime) return undefined
    const waiting = new Map<string, () => void>()
    const readAgain = () => void rpc.extensions.devicesOnlineChanged().catch((error: unknown) => {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages a machine came back failed')
    })
    const leave = (deviceId: string) => { waiting.get(deviceId)?.(); waiting.delete(deviceId) }
    const off = events.on(fileHoldersOfflineChannel, ({ deviceIds, replace }) => {
      if (replace) for (const deviceId of [...waiting.keys()]) leave(deviceId)
      for (const deviceId of deviceIds) {
        if (!waiting.has(deviceId)) waiting.set(deviceId, listenForHolder(deviceId, { back: () => { leave(deviceId); readAgain() }, subscribed: readAgain }))
      }
    })
    return () => { off(); for (const deviceId of [...waiting.keys()]) leave(deviceId) }
  }, [])
}
