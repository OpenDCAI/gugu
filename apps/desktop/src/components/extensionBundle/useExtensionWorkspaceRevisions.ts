import { useEffect } from 'react'
import { readMemberRosterRevision, readWorkspaceChanges } from '../../lib/accountRevisionCoordinator'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { useChatStore } from '../../store/chatContext'
import { rpc } from '../../session/renderer/lib/ipc'

const log = rendererLogger('chat/extension-workspace-revisions')

/**
 * App pages drawn for a group hear that the group's files changed (`gugu.files.onChanged`,
 * 真源 §2.4 评审). The account revision bus already carries `workspace_changed` into this
 * window; this passes on WHICH files of which groups it named (#7257), and main reads them and
 * tells the pages bound to them how those files are now.
 *
 * A listener on the bus that is already open — ❌ a channel of its own: App traffic stays off
 * the chat realtime quota (原则 9). Not awaited: the bus settles every listener of a batch before
 * the next, and a read of files is not the chat's to wait for (main merges what comes meanwhile).
 */
export function useExtensionWorkspaceRevisions(): void {
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  useEffect(() => {
    if (!platform.capabilities.agentRuntime) return undefined
    const workspace = subscribeAccountRevision('workspace_changed', (operations) => {
      const changes = readWorkspaceChanges(operations.map((operation) => operation.payload))
      if (changes.length === 0) return
      void rpc.extensions.groupWorkspaceChanged({ changes }).catch((error: unknown) => {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages their group workspace changed failed')
      })
    })
    // 摩擦单 F36: who is in the chat is part of an App page's context; the same bus says when a member row changed, and
    // who and whether they left — main reads the members again only when that moved who is there (`rosterMoved`).
    const members = subscribeAccountRevision('chat_members_changed', (operations) => {
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
}
