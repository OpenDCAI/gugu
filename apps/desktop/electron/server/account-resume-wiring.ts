import { listAgents } from '@gugu/core'
import { createLogger } from '../lib/logger'
import { createHostResumeHandler } from './host-resume'
export { watchHostResumeGap, installNativeSleepActivity } from './host-resume'

export function createAccountResumeHandler(deps: {
  kickInbox: (agentUserId: string, trigger: string) => void
  reconnect: () => Promise<void>
  reconcile: () => Promise<void>
  notifyCommands: () => void
}) {
  const log = createLogger('host-resume')
  return createHostResumeHandler({
    ...deps,
    pullUnread: async () => {
      const roster = await listAgents()
      for (const agent of roster) if (agent.gugu_user_id) deps.kickInbox(agent.gugu_user_id, 'host-resume')
    },
    observed: source => log.info({ source, pid: process.pid }, 'retained account resumed'),
    failed: (operation, err) => log.error({ operation, err }, 'resume reconciliation failed'),
  })
}

export function installNativeResumeSource(
  power: { on: (event: 'resume', callback: () => void) => unknown },
  foreground: () => void,
  resume: (source: string) => void,
): void {
  power.on('resume', () => { foreground(); resume('native-power') })
}
