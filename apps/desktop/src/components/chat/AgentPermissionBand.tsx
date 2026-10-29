import { messageForUser } from '@/lib/userFacingError';
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageProvider, PermissionBand } from '@gugu/session-ui/react/components'
import { ThemeProvider as SessionUiThemeProvider } from '@gugu/session-ui/react/primitives'
import { useLocale } from '@/i18n'
import { useTheme } from '../../store/theme'
import { useToast } from '../toastContext'
import { rendererLogger } from '../../lib/log'
import type { SessionpageSessionTimeline } from '../../hooks/useSessionpageSessionTimeline'
import { appInstallAskOf } from '@/session/shared/extensions/host-actions'
import { answerAppInstall, answeredTooLate, appInstallWords } from '@/session/renderer/features/extensions/app-install-approval'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { machineRegistry } from '@/session/renderer/lib/machine-routing'
import { remoteHostsStore } from '@/session/renderer/features/remote-hosts/remote-hosts-store'

const permissionLog = rendererLogger('chat/agent-permission-band')
const KEYS: Record<string, string> = { 'composer.allow': 'agent.taskpage.permission.allow', 'composer.queuePosition': 'agent.taskpage.permission.queuePosition' }

/** 会话页那条 `PermissionBand` 原样用在聊天页;数据与作答都走时间线结算(见 useSessionpageSessionTimeline),三端谁先答谁生效。 */
export function AgentPermissionBand({ sessionId, pending, respond }: {
  /** The session asking: its computer is named when it is not this one (another desktop's session followed here). */
  sessionId: string | null
  pending: NonNullable<SessionpageSessionTimeline['pendingPermission']>
  respond: SessionpageSessionTimeline['respondPermission']
}) {
  const { t } = useTranslation('messaging')
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const { toast } = useToast()
  const translate = useCallback((key: string, values?: Readonly<Record<string, string | number>>) => {
    if (!KEYS[key]) throw new Error(`Missing chat permission band translation: ${resolvedLocale}:${key}`)
    return t(KEYS[key], values)
  }, [resolvedLocale, t])
  // Lost to the host's clock (D-31: the ask was withdrawn first) is 「已经不等了」; lost to another surface, already answered.
  const answered = (result: { accepted: boolean; settlement?: { state?: string } }) => {
    if (!result.accepted) toast(t(answeredTooLate(result) ? 'agent.taskpage.permission.noLongerWaiting' : 'agent.taskpage.permission.alreadyAnswered'), 'info')
  }
  const failed = (error: unknown) => {
    permissionLog.error({ itemId: pending.itemId, error: error instanceof Error ? error.message : String(error) }, 'chat-page permission answer failed')
    toast(t('agent.taskpage.permission.failed'), 'error', messageForUser(error))
  }
  // D-31 An App install the host asks for this agent: this window's own sheet first, then the session (with its places).
  const install = appInstallAskOf(pending.origin)
  const machineId = sessionId ? machineRegistry.machineOf(sessionId) : null
  const machine = machineId ? remoteHostsStore.device(machineId)?.label ?? machineId : undefined
  const words = install ? appInstallWords(install, translateSessionMessage, machine) : null
  const onResolve = (optionId: string) => void (install
    ? answerAppInstall({ itemId: pending.itemId, ask: install, optionId, machine, respond: (answer) => respond(pending.itemId, answer.optionId, answer).then(answered) })
    : respond(pending.itemId, optionId).then(answered)
  ).catch(failed)
  const options = words ? pending.options.map((option) => ({ ...option, label: words.label(option.optionId) })) : pending.options
  return (
    <SessionUiThemeProvider theme={theme} target="documentElement">
      <MessageProvider locale={resolvedLocale} translate={translate}>
        <div data-testid="agent-sessionpage-permission">
          <PermissionBand request={{ requestId: pending.itemId, title: words?.title ?? pending.title, options }} queueCount={pending.queueCount} onResolve={onResolve} />
        </div>
      </MessageProvider>
    </SessionUiThemeProvider>
  )
}
