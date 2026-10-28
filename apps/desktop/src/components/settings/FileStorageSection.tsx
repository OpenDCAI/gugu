import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FILE_RETENTIONS, IMAGE_RETENTIONS, type FileStorage } from '@gugu/core/shared/fileStorage'
import { messageForUser } from '@/lib/userFacingError'
import { listMyDeviceProjects } from '../../lib/deviceProjects'
import { readFileStorage, writeFileStorage } from '../../lib/fileStorage'
import { useAuth } from '../../store/auth'
import { useDevicesStore } from '../../store/devicesContext'
import { Button } from '../ui/Button'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { FileStorageDashboard } from './FileStorageDashboard'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'

/**
 * 「文件存储与读取」(owner 10-27):全局设置里唯一的一处,一个人一份。owner 10-28 批的设计稿:上面是仪表盘
 * (FileStorageDashboard,只算自己上传的),下面一组设置,最后是普通群的说明。
 * 项目群那两行只给名下有绑了项目群的机器的人(别人机器上的项目群跟着那台机器主人的这一份走):
 * 「其他文件」二选一(owner 10-27):留在机器上、有人打开才临时传一份到云端(那份留多久跟着它) / 全部上传到云端。
 * ❌ 单独的「临时中转」开关:关掉它 = 留在机器上而别人永远读不到。全部上传时图片也不再到期,两个保留期都不给。
 * 「图片和标了临时的文件」:数据层图片与临时文件各一格(image_retention / temporary_retention),设置上一个控件,
 * 改一次写两格(owner 10-28)。临时文件在普通群里也生效,所以这一行人人都有。
 */
export function FileStorageSection({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('settings')
  useSettingsDetail('file-storage', t('fileStorage.title'), onBack)
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

  const { storage } = state
  const cloud = storage.proactive_upload
  const bound = state.machines.length > 0
  const labels = state.machines.map((id) => devices.find((device) => device.device_id === id)?.label ?? id.slice(0, 8))
  // One group of settings under the dashboard (owner 10-28 design): the project rows only for someone with a bound machine.
  const settings = (
    <SettingsGroup title={t('fileStorage.settingsTitle')}
      footer={<>
        {storage.image_retention !== storage.temporary_retention && <SettingsNote>{t('fileStorage.keptDiffer', {
          images: t(`fileStorage.retentions.${storage.image_retention}`), temporary: t(`fileStorage.retentions.${storage.temporary_retention}`) })}</SettingsNote>}
        {saveFailed && <SettingsNote tone="danger">{saveFailed}</SettingsNote>}
      </>}>
      {bound && <SettingsRow title={<label htmlFor="settings-file-mode">{t('fileStorage.files')}</label>}
        description={`${t(cloud ? 'fileStorage.filesCloudHint' : 'fileStorage.filesMachineHint')} ${t('fileStorage.machines', { machines: labels.join('、') })}`}
        control={(
          <select id="settings-file-mode" className="gg-settings-select" value={cloud ? 'cloud' : 'machine'}
            onChange={(event) => update(event.target.value === 'cloud' ? { proactive_upload: true } : { proactive_upload: false, temporary_transfer: true })}>
            <option value="machine">{t('fileStorage.filesMachine')}</option>
            <option value="cloud">{t('fileStorage.filesCloud')}</option>
          </select>
        )} />}
      {bound && !cloud && <SettingsRow title={<label htmlFor="settings-file-retention">{t('fileStorage.temporaryRetention')}</label>}
        description={t('fileStorage.temporaryRetentionHint')}
        control={(
          <select id="settings-file-retention" className="gg-settings-select" value={storage.retention}
            onChange={(event) => update({ retention: event.target.value as FileStorage['retention'] })}>
            {FILE_RETENTIONS.map((value) => <option key={value} value={value}>{t(`fileStorage.retentions.${value}`)}</option>)}
          </select>
        )} />}
      <SettingsRow title={<label htmlFor="settings-kept-retention">{t('fileStorage.kept')}</label>} description={t('fileStorage.keptHint')}
        control={(
          <select id="settings-kept-retention" className="gg-settings-select" value={storage.image_retention}
            onChange={(event) => { const value = event.target.value as FileStorage['image_retention']; update({ image_retention: value, temporary_retention: value }) }}>
            {IMAGE_RETENTIONS.map((value) => <option key={value} value={value}>{t(`fileStorage.retentions.${value}`)}</option>)}
          </select>
        )} />
    </SettingsGroup>
  )
  return (
    <SettingsPage data-testid="settings-file-storage">
      <FileStorageDashboard />
      {settings}
      {!bound && <SettingsNote>{t('fileStorage.noMachine')}</SettingsNote>}
      {ordinary}
    </SettingsPage>
  )
}
