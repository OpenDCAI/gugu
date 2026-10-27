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
import { isMyAssistant } from '@/lib/myAssistant'
import { useAuth } from '@/store/auth'
import { useContactsStore } from '@/store/contactsContext'
import { APP_SHOW_SESSION_EVENT, type AppShowSessionDetail } from '@/session/shared/extensions/app-runtime-protocol'
import { agentName, matchesQuery, projectAgents, type PartnerProject, type ProjectAgent } from './partnersModel'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'

/**
 * 项目通讯录(「伙伴」里点一个项目推进来):页头 返回 · 项目头像 · 项目名;「群」= 项目的群聊这一行,
 * 「Agent」= 我在这个项目里的 agent,副标题是它在这里最近那件事。项目群不进人:没有邀请链接,也没有「人」这一组。
 * 话题不成行(owner 10-28「项目 topic 在伙伴中也不应该像会话一样作为条目」,同电脑 #602 侧栏项目下不再列话题):
 * 话题在群里顶上那一排页签。点 Agent 打开它在这里最近那条会话,❌ 进群聊页(owner:选会话却进了群聊页离谱)。
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
  /** 打开项目群。 */
  onOpenGroup: () => void
}) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const myId = user?.id ?? null
  const { contacts, groupChats } = useContactsStore()
  const [query, setQuery] = useState('')

  const myAgents = useMemo(
    () => new Map(contacts.filter((contact) => contact.type === 'agent' && contact.owner_user_id === myId).map((contact) => [contact.id, contact])),
    [contacts, myId],
  )
  const group = project.chatId ? groupChats.find((candidate) => candidate.id === project.chatId) ?? null : null
  const agents = useMemo(() => projectAgents(group, myAgents, sessions), [group, myAgents, sessions])

  const groupLabel = t('partners.groupChat')
  const showGroup = matchesQuery(groupLabel, query) || matchesQuery(project.name, query)
  // 它在这里还没有会话(只在群里):进项目群。
  const openAgent = (agent: ProjectAgent) => {
    if (!agent.latest) {
      onOpenGroup()
      return
    }
    const detail: AppShowSessionDetail = { deviceId: agent.latest.deviceId, session: agent.latest.session }
    window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail }))
  }
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
          {showGroup ? <SectionLabel>{t('partners.rooms', { count: 1 })}</SectionLabel> : null}
          {showGroup ? (
            <ListRow mobile role="button" tabIndex={0} leading={<ProjectFolderAvatar coverId={project.coverId} running={running} />} title={groupLabel} onClick={onOpenGroup} onKeyDown={rowKeyActivate(onOpenGroup)} />
          ) : null}
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
                subtitle={isMyAssistant(myId, agent.id) ? t('partners.assistant') : agent.work ?? undefined}
                onClick={() => openAgent(agent)}
                onKeyDown={rowKeyActivate(() => openAgent(agent))}
              />
            )
          })}
          {query.trim() && !showGroup && !shownAgents.length ? <div className="gg-partners-empty">{t('partners.noResults')}</div> : null}
        </div>
      </div>
    </Pane>
  )
}
