import { useTranslation } from 'react-i18next'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { InlineAction } from './InlineAction'

// #6264 机器上限:平时不披露(没有「3/3」计数、没有角标),只在这一次添加会超出时说 ——
// 哪条上限、已经连了几台,句尾两段强调色文字:「升级会员」去「设置 → 会员与额度」,「移除一台机器」回到设备列表。

function machineLimitText(t: (key: string, values?: Record<string, unknown>) => string, refusal: MachineLimitRefusal | null): string {
  if (!refusal) return t('devices.addServer.machineLimit.unknown')
  return t(`devices.addServer.machineLimit.${refusal.limit}`, { used: refusal.used, max: refusal.max })
}

export function MachineLimitNotice({
  refusal,
  onUpgrade,
  onRemoveMachine,
}: {
  refusal: MachineLimitRefusal | null
  onUpgrade?: () => void
  onRemoveMachine?: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <span data-testid="add-server-machine-limit">
      {machineLimitText(t, refusal)}
      {(onUpgrade || onRemoveMachine) && (
        <>
          {' '}
          {onUpgrade && (
            <InlineAction onClick={onUpgrade} testId="add-server-machine-limit-upgrade">
              {t('devices.addServer.machineLimit.upgrade')}
            </InlineAction>
          )}
          {onUpgrade && onRemoveMachine && t('devices.addServer.machineLimit.or')}
          {onRemoveMachine && (
            <InlineAction onClick={onRemoveMachine} testId="add-server-machine-limit-remove">
              {t('devices.addServer.machineLimit.remove')}
            </InlineAction>
          )}
          {t('devices.addServer.machineLimit.end')}
        </>
      )}
    </span>
  )
}
