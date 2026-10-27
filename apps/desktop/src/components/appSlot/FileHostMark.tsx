import { useTranslation } from 'react-i18next'
import { HostMark } from '@renderer/features/sidebar/remote-host-chip'
import type { FileHost } from '../../lib/fileHost'
import { useAvatarIdentity } from '../../lib/avatarIdentity'
import { useAuth } from '../../store/auth'
import { useDevicesStore } from '../../store/devicesContext'

/** Beside the file's title (owner 10-27): the machine mark tasks use; which machine, the rule and whose setting on hover. */
export function FileHostMark({ host }: { host: FileHost }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { devices } = useDevicesStore()
  const owner = useAvatarIdentity(host.account)?.display_name ?? host.account.slice(0, 8)
  const mine = host.account === user?.id
  const machine = (mine ? devices.find((device) => device.device_id === host.device)?.label : null) ?? t('fileStoredOn.machineOf', { owner })
  return <HostMark long label={mine ? t('fileStoredOn.mine', { machine }) : t('fileStoredOn.other', { owner })} data-file-host={host.device} />
}
