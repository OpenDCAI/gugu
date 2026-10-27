import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Server } from '@/lib/icons'
import { UI_EVENTS } from '../../lib/uiEvents'
import { fileMetadata } from '../../lib/fileAccess'
import { rendererLogger } from '../../lib/log'
import { useAvatarIdentity } from '../../lib/avatarIdentity'
import { useAuth } from '../../store/auth'
import { useDevicesStore } from '../../store/devicesContext'
import { Hint } from '../ui/Tooltip'
import { Button } from '../ui/Button'

const log = rendererLogger('appSlot/file-stored-on')

/**
 * 预览头部那一行(owner 10-27):项目群里留在机器上、有人打开才上传的文件,说是哪台机器(任务上那枚机器标记),
 * 悬停说规矩和按谁的设置,一处「文件存储设置」去设置页那一格。只是说明:读不到就不画,❌ 挡住预览。
 */
export function FileStoredOn({ itemId }: { itemId: string }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { devices } = useDevicesStore()
  const [host, setHost] = useState<{ device: string; account: string } | null>(null)
  useEffect(() => {
    let live = true
    setHost(null)
    Promise.resolve().then(() => fileMetadata(itemId)).then((file) => {
      if (live && file.status === 'ready' && file.revision.source === 'local' && file.revision.host_device_id && file.revision.host_account_id) {
        setHost({ device: file.revision.host_device_id, account: file.revision.host_account_id })
      }
    }).catch((error: unknown) => log.warn({ itemId, error: String(error) }, 'where the file is kept is unknown'))
    return () => { live = false }
  }, [itemId])
  const owner = useAvatarIdentity(host?.account ?? '')?.display_name ?? host?.account.slice(0, 8) ?? ''
  if (!host) return null
  const mine = host.account === user?.id
  const machine = (mine ? devices.find((device) => device.device_id === host.device)?.label : null) ?? t('fileStoredOn.machineOf', { owner })
  const rule = mine ? t('fileStoredOn.mine', { machine }) : t('fileStoredOn.other', { owner })
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] !px-3 !py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]" data-testid="file-stored-on" data-device={host.device}>
      <Hint label={rule} side="bottom">
        <span className="flex min-w-0 items-center gap-1" aria-label={rule}><Server className="size-3 shrink-0" /><span className="truncate">{machine}</span></span>
      </Hint>
      <Button variant="ghost" size="sm" onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'files' } }))}>
        {t('fileStoredOn.settings')}
      </Button>
    </div>
  )
}
