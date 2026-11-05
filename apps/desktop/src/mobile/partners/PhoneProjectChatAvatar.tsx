import { useMemo, type ReactNode } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useAgentDisplayStatuses } from '@/hooks/useAgentDisplayStatus'
import { useDevicesStore } from '@/store/devicesContext'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { needsYouCount } from '@/session/renderer/features/sidebar/session-groups'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { partnerProjects } from './partnersModel'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'
import { PhoneMessageAvatar } from '../chat/PhoneMessageAvatar'

/** 消息中的项目群沿用项目封面;提醒仅占头像一角,不进伙伴通讯录。 */
export function PhoneProjectChatAvatar({ chat, mobile, children }: { chat: ChatItem; mobile: boolean; children: ReactNode }) {
  return mobile ? <ProjectChatAvatar chat={chat}>{children}</ProjectChatAvatar> : children
}
function ProjectChatAvatar({ chat, children }: { chat: ChatItem; children: ReactNode }) {
  const { devices } = useDevicesStore()
  const directory = useLiveDeviceSessions()
  const project = useMemo(() => partnerProjects(devices).find((row) => row.chatId === chat.id), [devices, chat.id])
  const statuses = useAgentDisplayStatuses(chat.member_user_ids ?? [])
  if (!project) return <PhoneMessageAvatar>{children}</PhoneMessageAvatar>
  const running = Object.values(statuses).filter((status) => status === 'working').length
  // 角标与桌面项目行的「需要你」点是同一条计数(needsYouCount):那台机器上这个项目的会话,等你操作或失败还没看过的。
  const needsYou = needsYouCount(project.members.flatMap(({ deviceId, localProjectId }) => {
    const device = devices.find((row) => row.device_id === deviceId)
    if (!device) return []
    const listed = deviceSessionsOf(device, directory)
    return listed.sessions.filter((session) => session.projectId === localProjectId).map((session) => ({
      presentation: sessionPresentation(session, listed.hostOnline === true && !listed.cached),
      unseen: session.unseen === true,
      hostOnline: listed.hostOnline,
    }))
  }))
  return <PhoneMessageAvatar badge={needsYou > 0 ? <span className="gg-phone-project-attention bg-foreground-warning" data-testid="phone-project-waiting" aria-hidden /> : null}>
    <ProjectFolderAvatar coverId={project.coverId} running={running} size={48} />
  </PhoneMessageAvatar>
}
