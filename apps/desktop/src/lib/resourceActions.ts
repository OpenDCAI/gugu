import { guguLink } from '@gugu/core/shared/ui/guguLink'
import { platform } from '@/platform'
import { i18n } from '@/i18n/runtime'
import { readMobileShell } from '@/hooks/useMobileShell'
import { readCachedDevices } from '@/store/devicesCache'
import { directoryRows, liveDeviceSessions, rowOpens } from '@/session/shared/remote-sessions/session-directory'
import { RESOURCE_ACTIONS, type ResourceContext } from '@/session/shared/resource-actions'
import { APP_COMPOSE_EVENT, APP_SHOW_SESSION_EVENT } from '@/session/shared/extensions/app-runtime-protocol'
import { pickDispatchTarget } from '@/components/chat/dispatchAsk'
import { notify } from './notices'

/** One URL producer and one draft picker for every resource host; nothing is sent here. */
export function resourceMenuItems(resource: ResourceContext) {
  return RESOURCE_ACTIONS.map(({ id, labelKey }) => ({ id, label: i18n.t(labelKey, { ns: 'messaging' }), click: () => runResourceAction(id, resource) }))
}

export async function runResourceAction(id: (typeof RESOURCE_ACTIONS)[number]['id'], resource: ResourceContext) {
  try {
    const url = resource.target.kind === 'chat' || resource.target.kind === 'file' ? guguLink(resource.target)
      : platform.kind === 'electron' ? await (await import('@/session/renderer/lib/ipc')).rpc.extensions.resourceLink(resource.target)
        : guguLink(resource.target, (await import('@/components/appSlot/phoneAppHost')).phoneLinkScheme())
    await navigator.clipboard.writeText(url)
    if (id === 'copy-resource-url') {
      notify({ tier: 'success', title: i18n.t('message.copied', { ns: 'messaging' }) })
      return
    }
    const mobile = readMobileShell()
    const rows = platform.kind === 'electron'
      ? (await (await import('@/session/renderer/lib/ipc')).rpc.sessionTimeline.sessionsList()).sessions.filter(rowOpens).map(session => ({ session }))
      : directoryRows(readCachedDevices(), liveDeviceSessions()).filter(row => rowOpens(row.session))
    const picked = await pickDispatchTarget({ draft: true, offers: ['chat', 'my-agent'], text: url, pills: [], chat: null, preselect: null, visible: false,
      local: rows.flatMap(row => row.session.agent ? [`user:${row.session.agent.userId}`] : []), resource })
    if (!picked) return
    if ('chat' in picked.to) {
      document.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, { detail: { chatId: picked.to.chat, text: picked.text }, bubbles: true }))
    } else if ('agent' in picked.to) {
      const agent = picked.to.agent
      const row = rows.find(row => `user:${row.session.agent?.userId}` === agent)
      if (!row) throw new Error('That agent has no task composer available here')
      if (mobile) window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { ...row, draft: { text: picked.text } } }))
      else {
        const [{ appState }, { getProjectManagerStore }, { composeWhenOpen }, { revealSessionpage }] = await Promise.all([
          import('@/session/renderer/lib/stores/app-state'), import('@/session/renderer/features/projects/stores/project-selectors'),
          import('@/session/renderer/features/extensions/compose-in-session'), import('@/hooks/useSessionpageReveal'),
        ])
        revealSessionpage()
        appState.navigation.navigate('session', { projectId: row.session.projectId, sessionId: row.session.conversationId })
        await composeWhenOpen(() => getProjectManagerStore().projects.get(row.session.projectId)?.mountedProject?.sessionManager.sessions.get(row.session.conversationId)?.viewModel ?? undefined, picked.text)
      }
    }
  } catch (error) { notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }) }
}
