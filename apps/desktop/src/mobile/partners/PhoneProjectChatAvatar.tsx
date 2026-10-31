import { useMemo, type ReactNode } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { mostUrgentAttention } from '@gugu/core/shared/agentStatus'
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
  // 角标颜色按要人处理的是哪一种:需要你 = 黄、出错 = 红,与桌面同一组色(--agent-tone-*)。
  const attention = mostUrgentAttention(Object.values(statuses))
  return <span className="gg-phone-project-avatar"><ProjectFolderAvatar coverId={project.coverId} running={running} size={48} />{attention ? <span className="gg-phone-project-attention" data-testid="phone-project-waiting" data-attention={attention} aria-hidden /> : null}</span>
}
