import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { Avatar } from '@/components/Avatar'
import { PaneBackButton } from '@/components/contacts/ContactDetail'
import { rowKeyActivate } from '@/components/contacts/contactsPanelStyles'
import { HeaderSearch } from '@/components/ui/HeaderSearch'
import { ListRow } from '@/components/ui/ListRow'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { Hash } from '@/lib/icons'
import { isMyAssistant } from '@/lib/myAssistant'
import { useAuth } from '@/store/auth'
import { useChatStore } from '@/store/chatContext'
import { useContactsStore } from '@/store/contactsContext'
import { agentName, matchesQuery, projectAgents, projectTopics, type PartnerProject } from './partnersModel'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'
import { useProjectTaskTopics } from './useProjectTaskTopics'

/**
 * 项目通讯录(「伙伴」里点一个项目推进来):页头 返回 · 项目头像 · 项目名;「群」= 项目的群聊 + 不属于哪件任务的话题,
 * 「Agent」= 我在这个项目里的 agent,副标题是它在这里最近那件事。项目群不进人:没有邀请链接,也没有「人」这一组。
 * 没有状态、没有提醒(那归「消息」)。
 */
export function PhoneProjectContacts({
  project,
  running,
  sessions,
  active,
  onBack,
  onOpenGroup,
}: {
  project: PartnerProject
  running: number
  sessions: readonly { deviceId: string; session: SessionpageSessionSummary }[]
  active: boolean
  onBack: () => void
  /** 打开项目群(给了 tabChatId = 落在那一枚页签:话题 / 任务)。 */
  onOpenGroup: (tabChatId?: string) => void
}) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const myId = user?.id ?? null
  const { chats } = useChatStore('chats')
  const { contacts, groupChats } = useContactsStore()
  const [query, setQuery] = useState('')
  const taskTopics = useProjectTaskTopics(project.chatId)

  const myAgents = useMemo(
    () => new Map(contacts.filter((contact) => contact.type === 'agent' && contact.owner_user_id === myId).map((contact) => [contact.id, contact])),
    [contacts, myId],
  )
  const group = project.chatId ? groupChats.find((candidate) => candidate.id === project.chatId) ?? null : null
  const topics = useMemo(() => taskTopics.loading || taskTopics.error ? [] : projectTopics(project.chatId, chats, taskTopics.taskIds), [project.chatId, chats, taskTopics.loading, taskTopics.error, taskTopics.taskIds])
  const agents = useMemo(() => projectAgents(group, myAgents, sessions), [group, myAgents, sessions])

  const groupLabel = t('partners.groupChat')
  const rooms = [
    ...(matchesQuery(groupLabel, query) || matchesQuery(project.name, query)
      ? [{ key: 'group', title: groupLabel, lead: <ProjectFolderAvatar coverId={project.coverId} running={running} />, tab: undefined }]
      : []),
    ...topics.filter((topic) => matchesQuery(topic.name, query)).map((topic) => ({
      key: topic.id,
      title: topic.name,
      lead: <span className="gg-partners-topic-icon"><Hash size={20} /></span>,
      tab: topic.id,
    })),
  ]
  const shownAgents = agents.filter((agent) => matchesQuery(agentName(agent), query) || matchesQuery(agent.work ?? '', query))

  return (
    <Pane paneRole="detail" mobile className="gg-partners" data-testid="phone-project-contacts">
      <HeaderSearch mobile active={active} value={query} onChange={setQuery} placeholder={t('partners.search')}>
        {(searchButton) => (
          <PaneHeader
            mobile
            leading={<PaneBackButton label={t('shell.back')} onBack={onBack} />}
            title={<h2 className="gg-pane-title gg-partners-head-title"><ProjectFolderAvatar coverId={project.coverId} running={running} size={32} /><span>{project.name}</span></h2>}
            actions={searchButton}
          />
        )}
      </HeaderSearch>
      <div className="gg-partners-scroll">
        <div className="gg-partners-list">
          {rooms.length ? <SectionLabel>{t('partners.rooms', { count: rooms.length })}</SectionLabel> : null}
          {rooms.map((room) => (
            <ListRow key={room.key} mobile role="button" tabIndex={0} leading={room.lead} title={room.title} onClick={() => onOpenGroup(room.tab)} onKeyDown={rowKeyActivate(() => onOpenGroup(room.tab))} />
          ))}
          {shownAgents.length ? <SectionLabel>{t('partners.agents', { count: shownAgents.length })}</SectionLabel> : null}
          {shownAgents.map((agent) => {
            const name = agentName(agent)
            return (
              <ListRow
                key={agent.id}
                mobile
                role="button"
                tabIndex={0}
                leading={<Avatar name={name} avatarUrl={agent.contact?.avatar} seed={agent.id} size="md" isAgent harnessBadge={false} />}
                title={name}
                subtitle={isMyAssistant(myId, agent.id) ? t('partners.assistant') : taskTopics.byAgent.get(agent.id)?.title ?? agent.work ?? undefined}
                onClick={() => onOpenGroup(taskTopics.byAgent.get(agent.id)?.topic.chat_id)}
                onKeyDown={rowKeyActivate(() => onOpenGroup(taskTopics.byAgent.get(agent.id)?.topic.chat_id))}
              />
            )
          })}
          {taskTopics.error ? <p role="alert" className="gg-partners-error">{t('partners.groupUnavailable')}</p> : null}
          {query.trim() && !rooms.length && !shownAgents.length ? <div className="gg-partners-empty">{t('partners.noResults')}</div> : null}
        </div>
      </div>
    </Pane>
  )
}
