import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import type { AssistantHomePlace } from '../../lib/assistantHome'
import { getMembership } from '../../lib/billing/membership'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { getMoveState, startMove, startPreview, subscribeMove } from '@renderer/features/assistant/assistant-move-controller'
import { pendingMove, type MoveEnv } from '@renderer/features/assistant/assistant-move-wire'
import '../../i18n/registerAssistantCatalog'

const log = rendererLogger('assistant/move')

export type AssistantMoveGroupProps = {
  ownerUserId: string
  assistantId: string
  assistantName: string
  home: AssistantHomePlace
  /** 这台电脑的设备 id;网页 / 手机 = null(搬不回来:没有「这台电脑」可住)。 */
  localDeviceId: string | null
  /** 管家那扇门开着吗(没开放 / 没配 = 搬上云不可用)。 */
  cloudAvailable: boolean
}

function openMembership() {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'usage' } }))
}

/**
 * #7199 搬家(owner 10-16:会员升降级 = 搬家;到期保留云上的家,续费或一键搬回自己的电脑)。
 * 云上的家 → 「搬回这台电脑」;这台电脑上的家 → 会员「搬到云上」、非会员指向会员。搬之前先列清会带走什么,点了才搬。
 * 这里只有设置里的那几行;弹窗是 AssistantMoveDialog(挂在壳上,状态在 assistant-move-controller),
 * 编排与测试在 features/assistant/assistant-move.ts。
 */
export function AssistantMoveGroup({ ownerUserId, assistantId, assistantName, home, localDeviceId, cloudAvailable }: AssistantMoveGroupProps) {
  const { t, i18n } = useTranslation('assistant')
  const [member, setMember] = useState<boolean | null>(null)
  const [membershipFailed, setMembershipFailed] = useState<string | null>(null)
  const [membershipAttempt, setMembershipAttempt] = useState(0)
  // 一次搬的状态是模块级的:搬着时这一组被换位置重挂,照样读得到;每次状态变都重渲染、重读日志
  // (搬完 / 搬断了「接着搬」那一行才跟着变;读日志只是一次 localStorage)。
  const move = useSyncExternalStore(subscribeMove, getMoveState)
  const busy = move.phase.kind === 'preparing' || move.phase.kind === 'moving'
  const pending = pendingMove(ownerUserId, assistantId)

  useEffect(() => {
    let cancelled = false
    setMembershipFailed(null)
    if (!cloudAvailable) { setMember(null); return }
    getMembership()
      .then((m) => !cancelled && setMember(!!m && m.tier !== 'free'))
      .catch((error: unknown) => {
        log.error({ error: String(error) }, 'read membership failed')
        if (!cancelled) setMembershipFailed(messageForUser(error))
      })
    return () => {
      cancelled = true
    }
  }, [ownerUserId, membershipAttempt, cloudAvailable])

  const env = useMemo<MoveEnv | null>(
    () => (localDeviceId ? { ownerUserId, assistantId, assistantName, localDeviceId, home } : null),
    [ownerUserId, assistantId, assistantName, localDeviceId, home]
  )

  const onComputerHere = home.kind === 'computer' && home.thisDevice
  return (
    <SettingsGroup title={t('move.group')} data-testid="assistant-move-group">
      {membershipFailed ? <SettingsRow title={t('setup.membershipUnreadable')} description={membershipFailed} control={<Button size="sm" onClick={() => setMembershipAttempt((attempt) => attempt + 1)}>{t('setup.retry')}</Button>} /> : null}
      {pending && env ? (
        <SettingsRow
          title={t('move.resumeTitle')}
          description={t('move.resumeBody')}
          control={
            <Button size="sm" disabled={busy} onClick={() => void startMove(env, pending.direction, new Map(), i18n.language)} data-testid="assistant-move-resume">
              {t('move.resumeAction')}
            </Button>
          }
          data-testid="assistant-move-resume-row"
        />
      ) : null}
      {home.kind === 'cloud' && member === false ? (
        <SettingsRow
          title={t('move.expiredTitle', { name: assistantName })}
          description={t('move.expiredBody')}
          control={
            <Button size="sm" onClick={openMembership} data-testid="assistant-move-renew">
              {t('move.renew')}
            </Button>
          }
          data-testid="assistant-move-expired"
        />
      ) : null}
      {home.kind === 'cloud' && env ? (
        <SettingsRow
          title={t('move.toComputerTitle')}
          description={t('move.toComputerBody')}
          control={
            <Button size="sm" disabled={busy} onClick={() => void startPreview(env, 'to-computer', i18n.language)} data-testid="assistant-move-to-computer">
              {t('move.toComputerAction')}
            </Button>
          }
          data-testid="assistant-move-to-computer-row"
        />
      ) : null}
      {onComputerHere && env ? (
        <SettingsRow
          title={t('move.toCloudTitle')}
          description={member === false ? t('move.toCloudNeedsMember') : !cloudAvailable ? t('move.cloudUnavailable') : t('move.toCloudBody')}
          control={
            member === false ? (
              <Button size="sm" onClick={openMembership} data-testid="assistant-move-member">
                {t('move.memberLink')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || member === null || !cloudAvailable}
                onClick={() => void startPreview(env, 'to-cloud', i18n.language)}
                data-testid="assistant-move-to-cloud"
              >
                {t('move.toCloudAction')}
              </Button>
            )
          }
          data-testid="assistant-move-to-cloud-row"
        />
      ) : null}
    </SettingsGroup>
  )
}
