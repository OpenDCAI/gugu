import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useDevicesStore } from '@/store/devicesContext'
import { ProjectFolderAvatar } from '../partners/ProjectFolderAvatar'
import { startPhoneNewTask } from './PhoneNewTask'
import { taskFoldersOfChat } from './phoneTaskFolders'

/** 已有真实文件夹和群、尚未派第一件任务的项目。 */
export function PhoneProjectEmpty({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { devices } = useDevicesStore()
  const project = useMemo(() => taskFoldersOfChat(devices, chatId), [devices, chatId])
  if (!project) return t('chatArea.noMessages')
  return <div className="gg-phone-project-empty" data-testid="phone-project-empty">
    <ProjectFolderAvatar coverId={project.rowId} size={64} />
    <span>{project.name}</span>
    <Button variant="secondary" size="sm" className="gg-phone-project-empty-start" onClick={() => startPhoneNewTask(chatId)}>{t('composer.phoneTask.action')}</Button>
  </div>
}
