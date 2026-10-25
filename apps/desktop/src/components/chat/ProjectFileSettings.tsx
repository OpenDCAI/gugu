import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { chatDb } from '../../lib/supabase'
import { listMyDeviceProjects } from '../../lib/deviceProjects'
import { projectGroupsStore } from '../../session/renderer/features/projects/stores/project-groups-store'
import { useAuth } from '../../store/auth'
import { attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { SettingsToggleRow } from './groupSettingsUi'
import { settingsRowStyle, settingsSelectStyle, settingsRowTitleStyle, settingsMutedTextStyle } from './groupSettingsStyles'
import { Button } from '../ui/Button'

type Policy = { host_device_id: string; host_project_id: string; proactive_upload: boolean; temporary_transfer: boolean; retention: 'read-once' | '1d' | '7d' | '30d' }
const retentions = ['read-once', '1d', '7d', '30d'] as const
/** Metadata only. The server checks the administrator and the actual device/project owner on every save. */
export function ProjectFileSettings({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging'), { user } = useAuth()
  const queryKey = ['project-file-policy', user?.id, chatId]
  const policy = useQuery({ queryKey, enabled: !!user, queryFn: async () => {
    const { data, error } = await chatDb.rpc('file_project_policy_for', { p_chat: chatId, p_as: user!.id })
    if (error) throw new Error(error.message)
    if (data) return data as Policy
    const projectId = projectGroupsStore.projectOfChat(chatId), projects = await listMyDeviceProjects()
    const binding = Object.entries(projects).flatMap(([device, rows]) => rows.map(row => ({ device, ...row }))).find(row => row.chatId === chatId && row.localProjectId === projectId)
    if (!binding) throw new Error('Project binding is unavailable')
    return { host_device_id: binding.device, host_project_id: binding.localProjectId, proactive_upload: false, temporary_transfer: true, retention: '7d' } satisfies Policy
  } }, attachmentQueryClient)
  const save = useMutation({ mutationFn: async (next: Policy) => {
    const { data, error } = await chatDb.rpc('file_project_policy_as', { p_chat: chatId, p_device: next.host_device_id, p_project: next.host_project_id,
      p_upload: next.proactive_upload, p_temporary: next.temporary_transfer, p_retention: next.retention })
    if (error) throw new Error(error.message)
    return data as Policy
  }, onSuccess: data => attachmentQueryClient.setQueryData(queryKey, data) }, attachmentQueryClient)
  if (policy.isError) return <div role="alert">{t('group.settings.filePolicyLoadFailed')} <Button variant="ghost" size="sm" onClick={() => void policy.refetch()}>{t('attachmentView.retry')}</Button></div>
  if (!policy.data) return <p style={settingsMutedTextStyle}>{t('common.loading')}</p>
  const current = policy.data
  const update = (change: Partial<Policy>) => save.mutate({ ...current, ...change })
  return <fieldset disabled={save.isPending} className="m-0 min-w-0 border-0 p-0">
    <SettingsToggleRow title={t('group.settings.fileCloudUpload')} description={t('group.settings.fileCloudUploadHint')}
      ariaLabel={t('group.settings.fileCloudUpload')} checked={current.proactive_upload} onChange={next => update({ proactive_upload: next })} />
    <details><summary style={settingsRowTitleStyle}>{t('group.settings.fileAdvanced')}</summary>
      <p style={settingsMutedTextStyle}>{t('group.settings.fileLocalSsh')}</p>
      <SettingsToggleRow title={t('group.settings.fileTemporary')} description={t('group.settings.fileStrictHint')}
        ariaLabel={t('group.settings.fileTemporary')} checked={current.temporary_transfer} onChange={next => update({ temporary_transfer: next })} />
      <label style={settingsRowStyle}><span style={settingsRowTitleStyle}>{t('group.settings.fileRetention')}</span>
        <select style={settingsSelectStyle} aria-label={t('group.settings.fileRetention')} value={current.retention} onChange={event => update({ retention: event.target.value as Policy['retention'] })}>
          {retentions.map(value => <option key={value} value={value}>{t(`group.settings.fileRetentions.${value}`)}</option>)}
        </select>
      </label>
    </details>
    {save.isError && <p role="alert">{t('group.settings.saveFailed')}</p>}
  </fieldset>
}
