import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FILE_RETENTIONS, IMAGE_RETENTIONS, type FileStorage } from '@gugu/core/shared/fileStorage'
import { messageForUser } from '@/lib/userFacingError'
import { listMyDeviceProjects } from '../../lib/deviceProjects'
import { readFileStorage, writeFileStorage } from '../../lib/fileStorage'
import { useAuth } from '../../store/auth'
import { useDevicesStore } from '../../store/devicesContext'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'

/**
 * 「文件存储与读取」(owner 10-27):全局设置里唯一的一处,一个人一份。上半是项目群(只管自己名下机器上的项目群;
 * 别人机器上的项目群跟着那台机器主人的这一份走),下半是普通群,放在一起对照。普通群没有可调的,只说明。
 * 名下没有绑了项目群的机器:只给普通群那段,加一句为什么没有上半。
 * 「其他文件」是一个二选一(owner 10-27):留在机器上、有人打开才上传(那份临时副本留多久跟着它) / 全部上传到云端。
 * ❌ 单独的「临时中转」开关:关掉它 = 留在机器上而别人永远读不到。全部上传时图片也不再到期,两个保留期都不给。
 */
export function FileStorageSection() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const { devices } = useDevicesStore()
  const [state, setState] = useState<{ storage: FileStorage; machines: string[] } | null>(null)
  const [loadFailed, setLoadFailed] = useState('')
  const [saveFailed, setSaveFailed] = useState('')
  const userId = user?.id

  const load = useCallback(() => {
    if (!userId) return
    let live = true
    setLoadFailed('')
    Promise.all([readFileStorage(userId), listMyDeviceProjects()])
      .then(([storage, projects]) => {
        const machines = Object.entries(projects).filter(([, rows]) => rows.some((row) => row.chatId)).map(([deviceId]) => deviceId)
        if (live) setState({ storage, machines })
      })
      .catch((cause: unknown) => { if (live) setLoadFailed(messageForUser(cause)) })
    return () => { live = false }
  }, [userId])
  useEffect(load, [load])

  const update = (change: Partial<FileStorage>) => {
    if (!userId || !state) return
    setSaveFailed('')
    writeFileStorage(userId, change)
      .then((storage) => setState((current) => current && { ...current, storage }))
      .catch((cause: unknown) => { setSaveFailed(messageForUser(cause)); load() })
  }

  const ordinary = (
    <SettingsGroup title={t('fileStorage.ordinaryTitle')}>
      <SettingsRow description={t('fileStorage.ordinary')} />
    </SettingsGroup>
  )
  if (loadFailed) {
    return <SettingsPage><SettingsGroup title={t('fileStorage.projectTitle')}>
      <SettingsRow description={loadFailed} control={<Button variant="secondary" size="sm" onClick={load}>{t('fileStorage.retry')}</Button>} />
    </SettingsGroup></SettingsPage>
  }
  if (!state) return <SettingsPage><SettingsNote>{t('fileStorage.loading')}</SettingsNote></SettingsPage>
  if (state.machines.length === 0) return <SettingsPage><SettingsNote>{t('fileStorage.noMachine')}</SettingsNote>{ordinary}</SettingsPage>

  const { storage } = state
  const cloud = storage.proactive_upload
  const labels = state.machines.map((id) => devices.find((device) => device.device_id === id)?.label ?? id.slice(0, 8))
  const select = <K extends 'retention' | 'image_retention'>(key: K, values: readonly FileStorage[K][], id: string) => (
    <select id={id} className="gg-settings-select" value={storage[key]}
      onChange={(event) => update({ [key]: event.target.value } as Partial<FileStorage>)}>
      {values.map((value) => <option key={value} value={value}>{t(`fileStorage.retentions.${value}`)}</option>)}
    </select>
  )
  return (
    <SettingsPage data-testid="settings-file-storage">
      <SettingsNote>{t('fileStorage.intro')}</SettingsNote>
      <SettingsGroup title={t('fileStorage.projectTitle')} note={t('fileStorage.machines', { machines: labels.join('、') })}
        footer={saveFailed ? <SettingsNote tone="danger">{saveFailed}</SettingsNote> : undefined}>
        <SettingsRow title={<label htmlFor="settings-image-retention">{t('fileStorage.images')}</label>}
          description={t(cloud ? 'fileStorage.imagesCloudHint' : 'fileStorage.imagesHint')}
          control={cloud ? undefined : select('image_retention', IMAGE_RETENTIONS, 'settings-image-retention')} />
        <SettingsRow title={<label htmlFor="settings-file-mode">{t('fileStorage.files')}</label>}
          description={t(cloud ? 'fileStorage.filesCloudHint' : 'fileStorage.filesMachineHint')}
          control={(
            <select id="settings-file-mode" className="gg-settings-select" value={cloud ? 'cloud' : 'machine'}
              onChange={(event) => update(event.target.value === 'cloud' ? { proactive_upload: true } : { proactive_upload: false, temporary_transfer: true })}>
              <option value="machine">{t('fileStorage.filesMachine')}</option>
              <option value="cloud">{t('fileStorage.filesCloud')}</option>
            </select>
          )} />
        {!cloud && <SettingsRow title={<label htmlFor="settings-file-retention">{t('fileStorage.temporaryRetention')}</label>}
          control={select('retention', FILE_RETENTIONS, 'settings-file-retention')} />}
      </SettingsGroup>
      {ordinary}
    </SettingsPage>
  )
}
