import { useMemo, type ReactNode } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useAgentDisplayStatuses } from '@/hooks/useAgentDisplayStatus'
import { useDevicesStore } from '@/store/devicesContext'
import { partnerProjects } from './partnersModel'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'

/** 消息中的项目群沿用项目封面;提醒仅占头像一角,不进伙伴通讯录。 */
export function PhoneProjectChatAvatar({ chat, mobile, children }: { chat: ChatItem; mobile: boolean; children: ReactNode }) {
  return mobile ? <ProjectChatAvatar chat={chat}>{children}</ProjectChatAvatar> : children
}
function ProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  const { devices } = useDevicesStore()
  const project = useMemo(() => partnerProjects(devices).find((row) => row.chatId === chat.id), [devices, chat.id])
  const statuses = useAgentDisplayStatuses(chat.member_user_ids ?? [])
  if (!project) return children
  const running = Object.values(statuses).filter((status) => status === 'working').length
  const waiting = Object.values(statuses).some((status) => status === 'needs_user' || status === 'error')
  return <span className="gg-phone-project-avatar"><ProjectFolderAvatar coverId={project.coverId} running={running} size={48} />{waiting ? <span className="gg-phone-project-attention" data-testid="phone-project-waiting" aria-hidden /> : null}</span>
}
