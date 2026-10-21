import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import { useTranslation } from 'react-i18next'
import type { AssistantHomePlace } from '../../lib/assistantHome'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { requestAssistantClose } from '../../lib/assistantClose'
import { SettingsGroup, SettingsPage, SettingsRow } from '../settings/SettingsPrimitives'
import { quickChatShortcutLabel, useQuickChatState } from './useQuickChatState'
import { AssistantMoveGroup, type AssistantMoveGroupProps } from './AssistantMoveGroup'

/** 快速聊天(全局快捷键叫出的小窗)那一组:住云上 / 住电脑两种家的齿轮页都有,只在桌面版。 */
export function QuickChatSettingsGroup({ assistantName }: { assistantName: string }) {
  const { t } = useTranslation('assistant')
  const quick = useQuickChatState()
  if (!quick.state?.supported) return null
  return (
    <SettingsGroup title={t('quickChat.settingsTitle')}>
      <SettingsRow
        title={t('quickChat.settingsRow')}
        description={
          !quick.state.enabled
            ? t('quickChat.off', { shortcut: quickChatShortcutLabel(quick.state) })
            : quick.state.registered
              ? t('quickChat.on', { shortcut: quickChatShortcutLabel(quick.state), name: assistantName })
              : t('quickChat.taken', { shortcut: quickChatShortcutLabel(quick.state) })
        }
        control={<Switch checked={quick.state.enabled} onCheckedChange={quick.setEnabled} aria-label={t('quickChat.settingsRow')} data-testid="assistant-settings-quick-chat" />}
        data-testid="assistant-settings-quick-chat-row"
      />
    </SettingsGroup>
  )
}

/**
 * 它住在人自己的电脑上时的齿轮页(owner 10-16:非会员住自己的电脑,不能保证 24 小时在线,如实说):
 * 它住哪台、那台此刻开没开。没有「叫醒」「醒着多久」「花了多少积分」—— 那是云上那台的事。
 */
export function ComputerHomeGroups({
  home,
  assistantName,
  move,
}: {
  home: Extract<AssistantHomePlace, { kind: 'computer' }>
  assistantName: string
  move: AssistantMoveGroupProps | null
}) {
  const { t } = useTranslation('assistant')
  const where = home.thisDevice ? t('home.thisComputer') : home.label ?? t('home.thatComputer')
  return (
    <>
      <SettingsGroup title={t('home.group')}>
        <SettingsRow
          title={t('home.livesAt', { name: assistantName, device: where })}
          description={home.thisDevice || home.online ? t('home.online', { name: assistantName }) : home.known ? t('home.off', { name: assistantName, device: where }) : t('home.gone', { name: assistantName })}
          data-testid="assistant-settings-home"
        />
        <SettingsRow title={t('home.alwaysOnTitle')} description={t(cloudComputerEnabled() ? 'home.alwaysOnNote' : 'home.alwaysOnLocalNote')} />
      </SettingsGroup>
      {move ? <AssistantMoveGroup {...move} /> : null}
      <QuickChatSettingsGroup assistantName={assistantName} />
      {/* #7350 住电脑上也有「关闭咕咕」,和住云上同一个入口、同一份确认(AssistantCloseHost);住别的电脑上时那份确认会说去那台关。 */}
      <SettingsGroup title={t('settings.danger')}>
        <SettingsRow
          title={t('settings.close')}
          description={t('settings.closeNoteComputer')}
          control={
            <Button size="sm" variant="danger" onClick={requestAssistantClose} data-testid="assistant-settings-close">
              {t('settings.closeAction')}
            </Button>
          }
        />
      </SettingsGroup>
    </>
  )
}

/** 整页版(没有别的组时用)。设置里「咕咕」那一组是 AssistantSection,它直接嵌 ComputerHomeGroups。 */
export function ComputerHomeSettings(props: Parameters<typeof ComputerHomeGroups>[0]) {
  return (
    <SettingsPage data-testid="assistant-settings-computer">
      <ComputerHomeGroups {...props} />
    </SettingsPage>
  )
}
